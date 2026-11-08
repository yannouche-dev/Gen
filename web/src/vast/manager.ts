// Cycle de vie de l'instance : repérage (label), démarrage/redémarrage, location d'une offre, suivi du
// démarrage (logs Vast puis agent sur l'instance), arrêt, destruction, coût de la session.
import { journal, registerSecret } from '../core/journal.ts';
import { HttpError } from '../core/http.ts';
import { randomToken, vault } from '../core/vault.ts';
import { loadSession, saveSession, type Settings } from '../core/settings.ts';
import { VastApi, type VastInstance, type VastOffer } from './api.ts';
import { buildOfferQuery, rankOffers } from './offers.ts';
import { buildEnv, buildOnstart, type BuildInfo } from './onstart.ts';
import { parseBootLog, tunnelFromLabel, type BootInfo } from './bootlog.ts';
import { ComfyClient, type AgentStatus } from '../comfy/client.ts';

export type Phase =
  | 'idle' // aucune instance
  | 'renting' // location en cours
  | 'starting' // conteneur en cours de démarrage
  | 'booting' // scripts en cours (tunnel, ComfyUI, modèles)
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'error';

export interface StepView {
  id: string;
  label: string;
  state: 'pending' | 'running' | 'done' | 'error';
  detail?: string;
  progress?: number;
  /** Début et fin de l'étape (ms), pour afficher sa durée. */
  startedAt?: number;
  endedAt?: number;
}

export interface ManagerState {
  phase: Phase;
  instance: VastInstance | null;
  steps: StepView[];
  message: string;
  tunnelUrl: string | null;
  agent: AgentStatus | null;
  credit: number | null;
  runningSince: number | null;
  autoStop: string | null;
  /** TOUTES les instances du compte Vast (quel que soit leur label), pour n'en oublier aucune. */
  all: VastInstance[];
  allCheckedAt: number | null;
  allError: string | null;
  /** Fin estimée du téléchargement des modèles (ms), d'après le débit mesuré. */
  modelsEta: number | null;
}

function fmtRate(bps: number): string {
  return bps >= 1e9 ? `${(bps / 1e9).toFixed(1).replace('.', ',')} Go/s` : `${Math.round(bps / 1e6)} Mo/s`;
}
function fmtLeft(sec: number): string {
  if (sec < 90) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1).replace('.', ',')} h`;
}

/** Une instance coûte du GPU si elle tourne, démarre, ou doit tourner. */
export function isBilling(i: VastInstance): boolean {
  return i.actual_status === 'running' || i.intended_status === 'running' || ['loading', 'created', 'rebooting'].includes(i.actual_status ?? '');
}

const STEP_DEFS: [string, string][] = [
  ['rented', 'Machine louée'],
  ['container', 'Conteneur démarré'],
  ['tools', 'Outils de l’instance (Caddy, cloudflared)'],
  ['tunnel', 'Accès HTTPS sécurisé (tunnel)'],
  ['comfy', 'ComfyUI installé et lancé'],
  ['models', 'Modèles téléchargés'],
  ['ready', 'Prêt'],
];

// Intervalles de sondage raccourcis dans le build de test (mocks rapides).
declare const __BUILD__: { test: boolean };
const SCALE = __BUILD__.test ? 0.2 : 1;
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms * SCALE));
}

export class InstanceManager {
  state: ManagerState = {
    phase: 'idle',
    instance: null,
    steps: STEP_DEFS.map(([id, label]) => ({ id, label, state: 'pending' })),
    message: '',
    tunnelUrl: null,
    agent: null,
    credit: null,
    runningSince: null,
    autoStop: null,
    all: [],
    allCheckedAt: null,
    allError: null,
    modelsEta: null,
  };
  comfy: ComfyClient | null = null;
  private modelSample: { t: number; done: number } | null = null;
  private modelRate: number | null = null;
  private listeners = new Set<(s: ManagerState) => void>();
  private loopToken = 0;
  private lastLogFetch = 0;
  private seenLogLines = new Set<string>();
  private build: BuildInfo;
  private getSettings: () => Settings;

  constructor(build: BuildInfo, getSettings: () => Settings) {
    this.build = build;
    this.getSettings = getSettings;
  }

  onChange(fn: (s: ManagerState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const l of this.listeners) l(this.state);
  }
  private patch(p: Partial<ManagerState>) {
    this.state = { ...this.state, ...p };
    this.emit();
  }
  private setStep(id: string, state: StepView['state'], detail?: string, progress?: number, times: { started?: number; ended?: number } = {}) {
    const prev = this.state.steps.find((s) => s.id === id);
    const now = Date.now();
    const startedAt = times.started ?? prev?.startedAt ?? (state === 'running' || state === 'done' || state === 'error' ? now : undefined);
    const endedAt = state === 'done' || state === 'error' ? times.ended ?? (prev?.state === state ? prev.endedAt : undefined) ?? now : undefined;
    if (prev && prev.state !== state) {
      const text = `${prev.label} : ${state === 'done' ? 'terminé' : state === 'running' ? 'en cours' : state === 'error' ? 'ERREUR' : state}${detail ? ' — ' + detail : ''}`;
      (state === 'error' ? journal.error : journal.info)('démarrage', text);
    } else if (prev && id === 'models' && typeof progress === 'number') {
      // Progression des téléchargements au Journal par paliers de 10 %.
      const step = Math.floor(progress * 10);
      if (step !== Math.floor((prev.progress ?? 0) * 10)) journal.info('démarrage', `Modèles : ${detail ?? Math.round(progress * 100) + ' %'}`);
    }
    this.state = {
      ...this.state,
      steps: this.state.steps.map((s) => (s.id === id ? { ...s, state, detail: detail ?? s.detail, progress, startedAt, endedAt } : s)),
    };
    this.emit();
  }
  private resetSteps() {
    this.state = { ...this.state, steps: STEP_DEFS.map(([id, label]) => ({ id, label, state: 'pending' })), tunnelUrl: null, agent: null, autoStop: null, modelsEta: null };
    this.modelSample = null;
    this.modelRate = null;
    this.comfy = null;
  }

  api(): VastApi {
    const s = this.getSettings();
    if (!s.proxyUrl) throw new Error('URL du proxy Vast non configurée (écran Clés)');
    return new VastApi(s.proxyUrl, () => (vault.isUnlocked() ? vault.secrets.vastKey ?? '' : ''));
  }

  isMine(i: VastInstance): boolean {
    const label = this.getSettings().label;
    return typeof i.label === 'string' && (i.label === label || i.label.startsWith(label + ' '));
  }

  async refreshCredit(): Promise<void> {
    try {
      const u = await this.api().currentUser(true);
      const credit = typeof u.credit === 'number' ? u.credit : typeof u.balance === 'number' ? u.balance : null;
      this.patch({ credit });
    } catch {
      /* déjà journalisé */
    }
  }

  /** Repère une instance du projet (label) et reprend son suivi si elle tourne. */
  /** Relit TOUTES les instances du compte (toutes les pages). Ne lève pas d'exception. */
  async refreshAll(quiet = true): Promise<VastInstance[] | null> {
    try {
      const all = await this.api().listInstances(quiet);
      all.sort((a, b) => b.id - a.id);
      const before = new Set(this.state.all.filter(isBilling).map((i) => i.id));
      const billing = all.filter(isBilling);
      for (const i of billing) {
        if (!before.has(i.id)) journal.warn('instance', `Instance #${i.id} allumée sur ton compte (${i.gpu_name ?? '?'}, ${i.label || 'sans label'}) : GPU facturé`);
      }
      for (const i of all) this.registerInstanceSecrets(i);
      this.patch({ all, allCheckedAt: Date.now(), allError: null });
      return all;
    } catch (e) {
      this.patch({ allError: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  /** Repère une instance du projet (label) et reprend son suivi si elle tourne. Liste aussi toutes les autres. */
  async discover(): Promise<VastInstance | null> {
    const all = await this.refreshAll(false);
    if (!all) throw new Error(this.state.allError ?? 'Liste des instances Vast indisponible');
    const others = all.filter((i) => !this.isMine(i) && isBilling(i));
    if (others.length) journal.warn('instance', `${others.length} autre(s) instance(s) allumée(s) sur ton compte : ${others.map((i) => '#' + i.id).join(', ')}`);
    const list = all.filter((i) => this.isMine(i));
    const pick = list.find((i) => i.actual_status === 'running') ?? list.find((i) => i.actual_status !== 'offline') ?? list[0] ?? null;
    if (list.length > 1) journal.warn('instance', `${list.length} instances portent le label du projet ; suivi de #${pick?.id}`);
    this.patch({ instance: pick });
    if (!pick) {
      this.patch({ phase: 'idle', message: 'Aucune instance du projet.' });
      return null;
    }
    journal.info('instance', `Instance #${pick.id} trouvée (${pick.actual_status ?? 'inconnu'}, ${pick.gpu_name ?? '?'})`);
    if (pick.actual_status === 'running' || pick.actual_status === 'loading' || pick.intended_status === 'running') {
      this.followBoot(pick.id, false);
    } else {
      this.patch({ phase: 'stopped', message: `Instance #${pick.id} arrêtée (disque conservé).` });
    }
    return pick;
  }

  /** Arrête n'importe quelle instance du compte (celle du projet ou une autre). */
  async stopById(id: number): Promise<void> {
    if (this.state.instance?.id === id) return this.stop();
    await this.api().setState(id, 'stopped');
    journal.info('instance', `Arrêt demandé pour l'instance #${id}`);
    setTimeout(() => void this.refreshAll(), 3000);
  }

  /** Détruit n'importe quelle instance du compte (celle du projet ou une autre). */
  async destroyById(id: number): Promise<void> {
    if (this.state.instance?.id === id) return this.destroy();
    await this.api().destroy(id);
    journal.info('instance', `Instance #${id} détruite`);
    this.patch({ all: this.state.all.filter((i) => i.id !== id) });
    setTimeout(() => void this.refreshAll(), 3000);
  }

  /** Instances facturées (GPU) du compte, avec la version la plus fraîche de l'instance suivie. */
  billingInstances(): VastInstance[] {
    const cur = this.state.instance;
    const all = this.state.all.map((i) => (cur && i.id === cur.id ? cur : i));
    if (cur && !all.some((i) => i.id === cur.id)) all.push(cur);
    return all.filter(isBilling);
  }

  private registerInstanceSecrets(i: VastInstance) {
    for (const [k, v] of i.extra_env ?? []) {
      if (/TOKEN|KEY|SECRET|PASSWORD/i.test(k)) registerSecret(v, k === 'COMFY_ACCESS_TOKEN' ? 'comfy' : k === 'HF_TOKEN' ? 'hf' : 'env');
    }
  }

  async searchOffers(): Promise<VastOffer[]> {
    const s = this.getSettings();
    journal.info('vast', `Recherche d'offres : ${s.gpuNames.join(', ')}, fiabilité ≥ ${s.minReliability * 100} %, ≥ ${s.minInetDown} Mb/s, disque ${s.diskGB} Go, ≤ ${s.maxPrice} $/h`);
    const offers = rankOffers(await this.api().searchOffers(buildOfferQuery(s)), s);
    journal.info('vast', `${offers.length} offre(s) correspondante(s)`);
    return offers;
  }

  /** Loue l'offre choisie (après confirmation du prix par l'utilisateur). */
  async rent(offer: VastOffer): Promise<void> {
    const s = this.getSettings();
    const secrets = vault.secrets;
    if (!secrets.hfToken) throw new Error('Token Hugging Face manquant (écran Clés)');
    this.resetSteps();
    this.patch({ phase: 'renting', message: `Location de l’offre #${offer.id} (${offer.gpu_name}, ${offer.dph_total.toFixed(3)} $/h)…` });
    const comfyToken = randomToken(32);
    registerSecret(comfyToken, 'comfy');
    const body = {
      image: s.image,
      disk: s.diskGB,
      label: s.label,
      runtype: 'ssh' as const,
      onstart: buildOnstart(this.build),
      env: buildEnv({
        hfToken: secrets.hfToken,
        comfyToken,
        allowedOrigin: location.origin,
        idleMinutes: s.idleMinutes,
        maxHours: s.maxHours,
        families: s.families,
        comfyVersion: s.comfyVersion,
      }),
      target_state: 'running' as const,
      cancel_unavail: true,
    };
    let res;
    try {
      res = await this.api().createInstance(offer.id, body);
    } catch (e) {
      this.patch({ phase: 'idle' });
      if (e instanceof HttpError && (e.status === 404 || e.status === 410 || /no_such_ask|unavailable/i.test(e.body))) {
        throw new Error('Cette offre vient d’être louée par quelqu’un d’autre. Relance la recherche.');
      }
      throw e;
    }
    if (res.instance_api_key) registerSecret(res.instance_api_key, 'cak');
    const id = res.new_contract;
    await vault.setComfyToken(id, comfyToken);
    journal.info('instance', `Instance #${id} créée (${offer.gpu_name}, ${offer.dph_total.toFixed(3)} $/h)`);
    this.setStep('rented', 'done', `#${id} · ${offer.gpu_name}`);
    saveSession({ instanceId: id, runningSince: null, dph: offer.dph_total });
    void this.refreshAll();
    this.followBoot(id, true);
  }

  /** Redémarre l'instance arrêtée (le disque, donc les modèles, est conservé). */
  async restart(): Promise<void> {
    const inst = this.state.instance;
    if (!inst) throw new Error('Aucune instance');
    this.resetSteps();
    this.patch({ phase: 'starting', message: `Redémarrage de l’instance #${inst.id}…` });
    await this.api().setState(inst.id, 'running');
    journal.info('instance', `Démarrage demandé pour #${inst.id}`);
    this.setStep('rented', 'done', `#${inst.id} · ${inst.gpu_name ?? ''}`);
    this.followBoot(inst.id, true);
  }

  async stop(): Promise<void> {
    const inst = this.state.instance;
    if (!inst) return;
    this.loopToken++;
    this.patch({ phase: 'stopping', message: 'Arrêt en cours…' });
    await this.api().setState(inst.id, 'stopped');
    journal.info('instance', `Arrêt demandé pour #${inst.id} (le disque est conservé, le stockage reste facturé)`);
    this.endSessionClock();
    this.comfy = null;
    void this.watchUntil(inst.id, (i) => i.actual_status !== 'running', 'stopped', 'Instance arrêtée. Le stockage reste facturé jusqu’à la destruction.').then(() => this.refreshAll());
  }

  async destroy(): Promise<void> {
    const inst = this.state.instance;
    if (!inst) return;
    this.loopToken++;
    this.patch({ phase: 'stopping', message: 'Destruction en cours…' });
    await this.api().destroy(inst.id);
    journal.info('instance', `Instance #${inst.id} détruite (disque supprimé, plus aucun frais)`);
    await vault.setComfyToken(inst.id, null).catch(() => undefined);
    this.endSessionClock();
    saveSession(null);
    this.comfy = null;
    this.resetSteps();
    this.patch({ phase: 'idle', instance: null, message: 'Instance détruite.', all: this.state.all.filter((i) => i.id !== inst.id) });
    setTimeout(() => void this.refreshAll(), 3000);
  }

  private endSessionClock() {
    const sess = loadSession();
    if (sess) saveSession({ ...sess, runningSince: null });
    this.patch({ runningSince: null });
  }

  private async watchUntil(id: number, done: (i: VastInstance) => boolean, phase: Phase, message: string) {
    const token = this.loopToken;
    for (let i = 0; i < 60 && token === this.loopToken; i++) {
      await sleep(5000);
      try {
        const inst = await this.api().getInstance(id, true);
        if (inst) this.patch({ instance: inst });
        if (!inst || done(inst)) break;
      } catch {
        /* réessayer */
      }
    }
    if (token === this.loopToken) this.patch({ phase, message });
  }

  private tokenFor(inst: VastInstance): string | null {
    const fromVault = vault.isUnlocked() ? vault.secrets.comfyTokens?.[String(inst.id)] : undefined;
    if (fromVault) return fromVault;
    const fromEnv = (inst.extra_env ?? []).find(([k]) => k === 'COMFY_ACCESS_TOKEN')?.[1];
    if (fromEnv) {
      registerSecret(fromEnv, 'comfy');
      void vault.setComfyToken(inst.id, fromEnv).catch(() => undefined);
    }
    return fromEnv ?? null;
  }

  /** Boucle de suivi : statut Vast → logs (étapes + URL du tunnel) → agent de l'instance. */
  followBoot(id: number, fresh: boolean): void {
    const token = ++this.loopToken;
    void this.bootLoop(id, token, fresh).catch((e) => {
      if (token !== this.loopToken) return;
      journal.error('instance', 'Suivi du démarrage interrompu', e);
      this.patch({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
    });
  }

  private async bootLoop(id: number, token: number, fresh: boolean) {
    const alive = () => token === this.loopToken;
    const allowLocal = this.build.test;
    if (fresh) this.patch({ phase: 'starting', message: 'Démarrage du conteneur (téléchargement de l’image)…' });
    let lastStatus = '';
    let bootLogs: BootInfo | null = null;
    let notReadyAgent = 0;
    while (alive()) {
      const inst = await this.api().getInstance(id, true).catch(() => null);
      if (!alive()) return;
      if (inst) {
        this.patch({ instance: inst });
        this.registerInstanceSecrets(inst);
        const st = `${inst.actual_status ?? '?'}|${inst.status_msg ?? ''}`;
        if (st !== lastStatus) {
          journal.info('instance', `Statut Vast : ${inst.actual_status ?? '?'} (voulu : ${inst.intended_status ?? '?'})${inst.status_msg ? ' — ' + inst.status_msg : ''}`);
          lastStatus = st;
        }
        if (this.state.steps[0].state !== 'done') this.setStep('rented', 'done', `#${inst.id} · ${inst.gpu_name ?? ''}`);
        const status = inst.actual_status ?? '';
        if (['exited', 'offline', 'unknown'].includes(status)) {
          this.patch({ phase: 'error', message: `L’instance est « ${status} » et ne démarrera pas. Détruis-la et loue une autre machine.` });
          this.setStep('container', 'error', inst.status_msg ?? status);
          return;
        }
        if (status === 'stopped' && inst.intended_status === 'stopped') {
          this.endSessionClock();
          this.patch({ phase: 'stopped', message: this.state.autoStop ? `Arrêtée automatiquement : ${this.state.autoStop}` : 'Instance arrêtée.' });
          return;
        }
        if (status !== 'running') {
          this.setStep('container', 'running', inst.status_msg ?? status);
          if (inst.intended_status === 'running' && status === 'stopped') {
            this.patch({ message: 'En attente du GPU (machine peut-être occupée par un autre client)…' });
          }
          await sleep(8000);
          continue;
        }
        this.setStep('container', 'done', '');
        this.startSessionClock(inst);
      }

      const comfyToken = inst ? this.tokenFor(inst) : null;
      if (!comfyToken) {
        this.patch({ phase: 'error', message: 'Jeton ComfyUI introuvable pour cette instance (coffre ou variables d’environnement).' });
        return;
      }

      // 1) Tant qu'on n'a pas d'URL joignable : lire les logs Vast (≥ 10 s d'intervalle).
      if (!this.comfy) {
        if (this.state.phase !== 'booting') this.patch({ phase: 'booting', message: 'Installation sur l’instance…' });
        const candidates: string[] = [];
        const fromLabel = tunnelFromLabel(inst?.label, allowLocal);
        if (Date.now() - this.lastLogFetch > 10000 * SCALE) {
          this.lastLogFetch = Date.now();
          try {
            const text = await this.api().logs(id, { tail: 400, filter: 'VIDEOGEN_' });
            bootLogs = parseBootLog(text, allowLocal);
            const fresh = bootLogs.lines.filter((l) => !this.seenLogLines.has(l));
            for (const l of fresh) this.seenLogLines.add(l);
            if (fresh.length) journal.info('instance', `Logs de démarrage (Vast) : ${fresh.length} nouvelle(s) ligne(s)`, fresh.join('\n'));
            this.applyLogSteps(bootLogs);
          } catch (e) {
            journal.debug('instance', 'Logs indisponibles pour le moment', e instanceof Error ? e.message : e);
          }
        }
        if (bootLogs?.tunnelUrl) candidates.push(bootLogs.tunnelUrl);
        if (fromLabel && !candidates.includes(fromLabel)) candidates.push(fromLabel);
        for (const url of candidates) {
          const c = new ComfyClient(url, comfyToken);
          try {
            const status = await c.agentStatus();
            this.comfy = c;
            this.patch({ tunnelUrl: url });
            journal.info('instance', `Instance joignable : ${url}`);
            this.setStep('tunnel', 'done', url.replace(/^https?:\/\//, ''));
            this.applyAgent(status);
            break;
          } catch {
            journal.debug('instance', `URL pas encore joignable : ${url}`);
          }
        }
        if (!this.comfy) {
          await sleep(4000);
          continue;
        }
      }

      // 2) Agent joignable : progression détaillée puis surveillance (watchdog, perte du tunnel).
      try {
        const status = await this.comfy!.agentStatus();
        notReadyAgent = 0;
        this.applyAgent(status);
      } catch (e) {
        notReadyAgent++;
        if (notReadyAgent >= 3) {
          journal.warn('instance', 'Instance injoignable via le tunnel : recherche d’une nouvelle URL', e instanceof Error ? e.message : e);
          this.comfy = null;
          this.patch({ tunnelUrl: null, phase: 'booting', message: 'Reconnexion à l’instance…' });
          this.setStep('tunnel', 'running');
          notReadyAgent = 0;
        }
      }
      await sleep(this.state.phase === 'ready' ? 20000 : 3000);
    }
  }

  private startSessionClock(inst: VastInstance) {
    let sess = loadSession();
    if (!sess || sess.instanceId !== inst.id) sess = { instanceId: inst.id, runningSince: null, dph: inst.dph_total ?? 0 };
    if (!sess.runningSince) {
      // Reprise sur un autre appareil : on se base sur la durée de fonctionnement connue de Vast si possible.
      const up = typeof inst.uptime_mins === 'number' ? inst.uptime_mins * 60000 : 0;
      sess.runningSince = Date.now() - up;
    }
    sess.dph = inst.dph_total ?? sess.dph;
    saveSession(sess);
    if (this.state.runningSince !== sess.runningSince) this.patch({ runningSince: sess.runningSince });
  }

  private applyLogSteps(info: BootInfo) {
    const s = info.steps;
    if (s.tools?.state === 'running') this.setStep('tools', 'running', s.tools.msg || 'téléchargement et vérification SHA-256…');
    if (s.tools?.state === 'done') this.setStep('tools', 'done', s.tools.msg || '');
    if (s.tools?.state === 'error') this.failStep('tools', `Outils : ${s.tools.msg}`);
    if (s.tunnel?.state === 'running') this.setStep('tunnel', 'running', s.tunnel.msg || 'ouverture du tunnel Cloudflare…');
    if (s.tunnel?.state === 'retry') this.setStep('tunnel', 'running', `nouvel essai en ${s.tunnel.msg === 'http2' ? 'HTTP/2' : 'QUIC'} (le premier protocole est bloqué par l’hôte)`);
    if (s.comfy_install?.state === 'running') this.setStep('comfy', 'running', s.comfy_install.msg || 'installation…');
    if (s.comfy_install?.state === 'error') this.failStep('comfy', s.comfy_install.msg);
    if (s.comfy_start?.state === 'error') this.failStep('comfy', s.comfy_start.msg);
    if (s.models?.state === 'running') this.setStep('models', 'running', 'téléchargement…');
    if (info.autoStop) this.patch({ autoStop: info.autoStop });
  }

  private failStep(id: string, msg: string) {
    this.setStep(id, 'error', msg);
    this.patch({ phase: 'error', message: msg });
  }

  private applyAgent(a: AgentStatus) {
    this.patch({ agent: a });
    const st = a.steps;
    // Heures de l'agent (secondes) → heure locale (ms), corrigées du décalage d'horloge entre l'instance et le téléphone.
    const skew = Date.now() - a.now * 1000;
    const ms = (t?: number) => (typeof t === 'number' ? t * 1000 + skew : undefined);
    const times = (x?: { started?: number; ended?: number }) => ({ started: ms(x?.started), ended: ms(x?.ended) });

    if (st.tools?.state === 'done') this.setStep('tools', 'done', st.tools.msg ?? '', undefined, times(st.tools));
    else if (st.tools?.state === 'error') this.failStep('tools', st.tools.msg ?? 'outils');

    const inst = st.comfy_install;
    const start = st.comfy_start;
    const comfyErr = inst?.state === 'error' ? inst : start?.state === 'error' ? start : null;
    if (comfyErr) this.failStep('comfy', comfyErr.msg ?? 'erreur ComfyUI');
    else if (start?.state === 'done' && a.comfy_ready) this.setStep('comfy', 'done', `ComfyUI ${a.comfy_version ?? ''}`.trim(), undefined, { started: ms(inst?.started), ended: ms(start.ended) });
    else if (inst?.state === 'running') {
      // Installation ≈ 85 % de l'étape, démarrage ≈ 15 %.
      this.setStep('comfy', 'running', `Installation : ${inst.msg || 'en cours…'}`, (inst.pct ?? 0) * 0.85, { started: ms(inst.started) });
    } else if (start?.state === 'running' || inst?.state === 'done') {
      this.setStep('comfy', 'running', `Démarrage : ${start?.msg || 'lancement de ComfyUI…'}`, 0.85 + (start?.pct ?? 0) * 0.15, { started: ms(inst?.started ?? start?.started) });
    }

    const m = a.models;
    if (m) {
      const pct = m.total_bytes ? Math.min(1, m.done_bytes / m.total_bytes) : 0;
      const gb = (n: number) => (n / 1e9).toFixed(1).replace('.', ',');
      const mt = times(st.models);
      if (m.state === 'done') this.setStep('models', 'done', `${gb(m.total_bytes)} Go`, undefined, mt);
      else if (m.state === 'error') this.setStep('models', 'error', m.error ?? 'erreur de téléchargement', undefined, mt);
      else {
        // Débit lissé et temps restant, d'après deux relevés successifs de l'agent.
        const prev = this.modelSample;
        if (prev && a.now > prev.t && m.done_bytes >= prev.done) {
          const rate = (m.done_bytes - prev.done) / (a.now - prev.t);
          this.modelRate = this.modelRate ? this.modelRate * 0.6 + rate * 0.4 : rate;
        }
        this.modelSample = { t: a.now, done: m.done_bytes };
        const left = m.total_bytes - m.done_bytes;
        const extra = this.modelRate && this.modelRate > 1e5
          ? ` · ${fmtRate(this.modelRate)} · reste ≈ ${fmtLeft(left / this.modelRate)}`
          : '';
        const active = m.files.find((f) => f.state === 'downloading');
        this.setStep('models', 'running', `${Math.round(pct * 100)} % · ${gb(m.done_bytes)} / ${gb(m.total_bytes)} Go${extra}${active ? ` · ${active.name}` : ''}`, pct, mt);
        this.patch({ modelsEta: this.modelRate && this.modelRate > 1e5 ? Date.now() + (left / this.modelRate) * 1000 : null });
      }
    }
    if (st.ready?.state === 'done' && a.comfy_ready) {
      if (this.state.phase !== 'ready') {
        journal.info('instance', 'Instance prête');
        this.patch({ phase: 'ready', message: m?.state === 'error' ? 'Prête, mais certains modèles ont échoué (voir détails).' : 'Prête à générer.' });
      }
      this.setStep('ready', m?.state === 'error' ? 'error' : 'done');
    }
    if (a.watchdog?.triggered) this.patch({ autoStop: a.watchdog.reason });
  }

  /** Coût estimé de la période allumée en cours. */
  sessionCost(now = Date.now()): { hours: number; cost: number; dph: number } | null {
    const since = this.state.runningSince;
    const dph = this.state.instance?.dph_total ?? loadSession()?.dph ?? 0;
    if (!since) return null;
    const hours = Math.max(0, (now - since) / 3600000);
    return { hours, cost: hours * dph, dph };
  }
}
