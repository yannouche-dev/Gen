// Exécution d'une génération : envoi des images, POST /prompt, suivi WebSocket (progression, aperçus),
// récupération du résultat via /history + /view (Blob en mémoire), nettoyage des fichiers sur l'instance.
//
// Veille du téléphone : la génération tourne sur l'instance, pas dans le navigateur. Une coupure réseau ou
// une page suspendue ne fait JAMAIS échouer la génération : le suivi reprend au réveil (WebSocket rouvert,
// /history interrogé). Si l'onglet a été fermé, la génération mémorisée (core/pending) est reprise à la
// réouverture ; si l'historique de ComfyUI a été perdu (redémarrage), la vidéo est retrouvée par son préfixe.
import { journal } from '../core/journal.ts';
import { randomToken } from '../core/vault.ts';
import { HttpError } from '../core/http.ts';
import { addPending, removePending, type PendingJob } from '../core/pending.ts';
import type { ComfyClient, FileRef, HistoryEntry } from './client.ts';
import { explainError, explainExecutionError, type ReadableError } from './errors.ts';
import { buildPrompt, findEnhancedPrompt, findVideoOutputs, type ApiPrompt, type GenParams, type ModelDef, type Registry } from '../workflows/build.ts';

export interface GenProgress {
  /** Fraction globale estimée (0..1). */
  overall: number;
  /** Étape en cours (titre du nœud). */
  label: string;
  value?: number;
  max?: number;
}

export interface GenEvents {
  onStatus?(text: string): void;
  onProgress?(p: GenProgress): void;
  onPreview?(blob: Blob): void;
  onQueued?(promptId: string): void;
}

export interface GenResult {
  blob: Blob;
  file: FileRef;
  promptId: string;
  seed: number;
  modelId: string;
  params: GenParams;
  elapsedMs: number;
  /** Prompt réellement utilisé par le modèle (après amélioration par Gemma), si disponible. */
  enhancedPrompt: string | null;
}

export class GenerationError extends Error {
  readable: ReadableError;
  cancelled: boolean;
  constructor(readable: ReadableError, cancelled = false) {
    super(readable.title);
    this.readable = readable;
    this.cancelled = cancelled;
  }
}

export interface GenInput {
  client: ComfyClient;
  registry: Registry;
  model: ModelDef;
  workflow: ApiPrompt;
  params: Omit<GenParams, 'startImage' | 'endImage' | 'middleImage' | 'outputPrefix'>;
  startImage?: Blob | null;
  endImage?: Blob | null;
  middleImage?: Blob | null;
  stallMinutes: number;
  /** Instance Vast qui exécute la génération (pour la reprise après fermeture de l'onglet). */
  instanceId: number;
  parentId?: string;
  /** Reprise d'une génération lancée avant une mise en veille ou une fermeture de l'onglet. */
  resume?: PendingJob;
  events?: GenEvents;
}

const WATCH_MS = 5000;
/** Écart au-delà duquel on considère que la page a été suspendue (veille, arrière-plan). */
const SUSPEND_GAP_MS = 20000;
/** Travail absent de la file, de l'historique et des fichiers pendant ce délai : on abandonne. */
const MISSING_MS = 120000;

export class Generation {
  readonly promise: Promise<GenResult>;
  private input: GenInput;
  private promptId: string | null = null;
  private outputPrefix = '';
  private ws: WebSocket | null = null;
  private cancelled = false;
  private finished = false;
  private resolveFn!: (r: GenResult) => void;
  private rejectFn!: (e: GenerationError) => void;
  private lastActivity = Date.now();
  private lastWatch = Date.now();
  private missingSince: number | null = null;
  private offline = false;
  /** Fin annoncée par le WebSocket : on vérifie à chaque passage jusqu'à récupérer la vidéo. */
  private doneSeen = false;
  /** Génération reprise : ComfyUI envoie la progression à l'ancienne page, on interroge donc l'instance. */
  private polling = false;
  private watching = false;
  private delivering = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private executed = new Set<string>();
  private totalNodes = 1;
  private titles: Record<string, string> = {};
  private uploaded: FileRef[] = [];
  private t0 = Date.now();
  private clientId = crypto.randomUUID();
  private enhancedPrompt: string | null = null;
  private current = '';
  private currentValue = 0;
  private currentMax = 0;
  private onVisible = () => {
    if (document.visibilityState !== 'visible' || this.finished) return;
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) this.openSocket();
    void this.watch(true);
  };

  constructor(input: GenInput) {
    this.input = input;
    this.promise = new Promise<GenResult>((res, rej) => {
      this.resolveFn = res;
      this.rejectFn = rej;
    });
    document.addEventListener('visibilitychange', this.onVisible);
    const start = input.resume ? this.resumeRun(input.resume) : this.run();
    start.catch((e) => this.fail(e instanceof GenerationError ? e : new GenerationError(explainError(e))));
  }

  get id(): string | null {
    return this.promptId;
  }

  private status(t: string) {
    this.input.events?.onStatus?.(t);
  }

  private indexWorkflow(wf: ApiPrompt) {
    this.totalNodes = Object.keys(wf).length;
    for (const [id, n] of Object.entries(wf)) this.titles[id] = n._meta?.title ?? n.class_type;
  }

  private startWatching() {
    this.lastActivity = Date.now();
    this.lastWatch = Date.now();
    this.timers.push(setInterval(() => void this.watch(), WATCH_MS));
  }

  private async run() {
    const { client, registry, model, workflow, params } = this.input;
    this.status('Connexion au serveur…');
    this.openSocket();

    const names: { start?: string; end?: string; middle?: string } = {};
    const label = { start: 'Envoi de l’image de début…', end: 'Envoi de l’image de fin…', middle: 'Envoi de l’image clé intermédiaire…' };
    for (const [key, blob] of [['start', this.input.startImage], ['middle', this.input.middleImage], ['end', this.input.endImage]] as const) {
      if (!blob) continue;
      this.status(label[key]);
      const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
      const ref = await client.uploadImage(blob, `vg_${randomToken(9)}.${ext}`);
      this.uploaded.push(ref);
      names[key] = ref.subfolder ? `${ref.subfolder}/${ref.filename}` : ref.filename;
    }
    if (this.cancelled) throw new GenerationError({ title: 'Génération annulée', hint: '' }, true);

    this.outputPrefix = `videogen/${model.id}_${Date.now()}`;
    const prompt = buildPrompt(registry, model, workflow, { ...params, startImage: names.start, endImage: names.end, middleImage: names.middle, outputPrefix: this.outputPrefix });
    this.indexWorkflow(prompt);

    this.status('Envoi du workflow…');
    journal.info('génération', `Lancement ${model.label} — ${params.preset} ${params.ratio}, ${params.duration} s à ${params.fps} i/s, seed ${params.seed}`);
    const res = await client.prompt(prompt, this.clientId);
    this.promptId = res.prompt_id;
    addPending({
      promptId: res.prompt_id,
      instanceId: this.input.instanceId,
      modelId: model.id,
      params,
      outputPrefix: this.outputPrefix,
      uploaded: this.uploaded,
      startedAt: this.t0,
      parentId: this.input.parentId,
    });
    this.input.events?.onQueued?.(res.prompt_id);
    journal.info('génération', `Prompt accepté (id ${res.prompt_id}, position ${res.number}) — la génération continue sur l’instance même si le téléphone se met en veille`);
    this.status('En file d’attente…');
    if (this.cancelled) await this.sendCancel();
    this.startWatching();
  }

  /** Reprise : la génération tourne (ou a tourné) sur l'instance ; on rattache le suivi. */
  private async resumeRun(job: PendingJob) {
    this.promptId = job.promptId;
    this.polling = true;
    this.outputPrefix = job.outputPrefix;
    this.uploaded = job.uploaded;
    this.t0 = job.startedAt;
    this.indexWorkflow(this.input.workflow);
    journal.info('génération', `Reprise du suivi de la génération ${job.promptId} (${this.input.model.label})`);
    this.status('Reprise du suivi de la génération…');
    this.openSocket();
    this.startWatching();
    await this.watch(true);
  }

  private openSocket(attempt = 0) {
    if (this.finished) return;
    let ws: WebSocket;
    try {
      ws = this.input.client.openSocket(this.clientId);
    } catch (e) {
      journal.warn('génération', 'WebSocket impossible, suivi par interrogation', e);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'feature_flags', data: { supports_preview_metadata: true } }));
      journal.debug('génération', 'WebSocket connecté');
      if (this.offline) void this.watch(true);
    };
    ws.onmessage = (ev) => this.onMessage(ev);
    ws.onclose = () => {
      if (this.finished || this.ws !== ws) return;
      journal.debug('génération', 'WebSocket fermé, reconnexion…');
      const delay = Math.min(15000, 1000 * 2 ** attempt);
      setTimeout(() => {
        if (this.ws === ws) this.openSocket(attempt + 1);
      }, delay);
    };
    ws.onerror = () => {
      /* onclose suit */
    };
  }

  private onMessage(ev: MessageEvent) {
    if (ev.data instanceof ArrayBuffer) {
      this.onBinary(ev.data);
      return;
    }
    let msg: { type: string; data: Record<string, unknown> };
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const d = msg.data ?? {};
    if (d.prompt_id && this.promptId && d.prompt_id !== this.promptId) return;
    if (!this.promptId && msg.type !== 'status') return;
    this.lastActivity = Date.now();
    if (this.offline) {
      this.offline = false;
      this.status('Connexion rétablie, génération en cours…');
    }
    switch (msg.type) {
      case 'execution_start':
        this.status('Génération en cours…');
        break;
      case 'execution_cached':
        for (const n of (d.nodes as string[]) ?? []) this.executed.add(String(n));
        this.emitProgress();
        break;
      case 'executing': {
        const node = d.node as string | null;
        if (node === null) {
          this.doneSeen = true;
          void this.watch(true);
        }
        else {
          this.current = String(node);
          this.currentValue = 0;
          this.currentMax = 0;
          this.emitProgress();
        }
        break;
      }
      case 'progress':
        this.currentValue = Number(d.value ?? 0);
        this.currentMax = Number(d.max ?? 0);
        if (d.node) this.current = String(d.node);
        this.emitProgress();
        break;
      case 'executed':
        if (d.node) this.executed.add(String(d.node));
        this.emitProgress();
        break;
      case 'execution_success':
        this.doneSeen = true;
        void this.watch(true);
        break;
      case 'execution_error': {
        const readable = explainExecutionError(d as Record<string, string>);
        journal.error('génération', readable.title, d);
        this.fail(new GenerationError(readable));
        break;
      }
      case 'execution_interrupted':
        journal.warn('génération', 'Génération interrompue', d);
        this.fail(new GenerationError({ title: 'Génération annulée', hint: '' }, true));
        break;
    }
  }

  private emitProgress() {
    if (this.current) this.executed.add(this.current);
    const done = Math.max(0, this.executed.size - 1);
    const frac = this.currentMax > 0 ? this.currentValue / this.currentMax : 0;
    const overall = Math.min(0.99, (done + frac) / this.totalNodes);
    this.input.events?.onProgress?.({
      overall,
      label: this.titles[this.current] ?? this.current,
      value: this.currentMax ? this.currentValue : undefined,
      max: this.currentMax || undefined,
    });
  }

  private onBinary(buf: ArrayBuffer) {
    if (buf.byteLength < 8) return;
    const view = new DataView(buf);
    const event = view.getUint32(0);
    let offset = 4;
    let mime = 'image/jpeg';
    if (event === 1) {
      mime = view.getUint32(4) === 2 ? 'image/png' : 'image/jpeg';
      offset = 8;
    } else if (event === 4) {
      const len = view.getUint32(4);
      try {
        const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, len))) as { prompt_id?: string; image_type?: string };
        if (meta.prompt_id && meta.prompt_id !== this.promptId) return;
        if (meta.image_type) mime = meta.image_type;
      } catch {
        return;
      }
      offset = 8 + len;
    } else return;
    this.lastActivity = Date.now();
    this.input.events?.onPreview?.(new Blob([buf.slice(offset)], { type: mime }));
  }

  /**
   * Point de contrôle (toutes les 5 s, au réveil de la page, à la fin annoncée par le WebSocket) :
   * résultat dans /history ? toujours dans la file ? sinon fichier retrouvé par préfixe ?
   * Une erreur réseau n'est jamais une raison d'abandonner : on réessaie.
   */
  private async watch(force = false) {
    if (this.finished || !this.promptId || this.watching || this.delivering) return;
    const now = Date.now();
    if (now - this.lastWatch > SUSPEND_GAP_MS) {
      // La page était suspendue (veille) : ce temps ne compte pas comme une absence de progression.
      journal.info('génération', `Reprise après ${Math.round((now - this.lastWatch) / 1000)} s de veille, vérification sur l’instance…`);
      this.lastActivity = now;
      force = true;
    }
    this.lastWatch = now;
    const wsDown = !this.ws || this.ws.readyState !== WebSocket.OPEN;
    const idleMs = now - this.lastActivity;
    if (!force && !this.polling && !this.offline && !this.doneSeen && !wsDown && idleMs < 60000) return;
    this.watching = true;
    try {
      const h = await this.input.client.history(this.promptId);
      if (this.offline) {
        this.offline = false;
        this.status('Connexion rétablie, génération en cours…');
        journal.info('génération', 'Connexion à l’instance rétablie');
      }
      if (h && (h.status?.completed || h.status?.status_str === 'error' || h.status?.status_str === 'success')) {
        await this.handleHistory(h);
        return;
      }
      const q = await this.input.client.queue();
      const inQueue = [...q.queue_running, ...q.queue_pending].some((e) => e[1] === this.promptId);
      if (inQueue || h) {
        this.missingSince = null;
        if (this.polling) this.status('Génération en cours sur l’instance (reprise du suivi : progression détaillée indisponible)…');
        if (idleMs > this.input.stallMinutes * 60000) this.status('Toujours en cours sur l’instance (pas de nouvelles depuis un moment)…');
        return;
      }
      // Ni dans la file ni dans l'historique : ComfyUI a peut-être redémarré. La vidéo existe-t-elle ?
      const files = (await this.input.client.listOutputs(this.outputPrefix)).filter((f) => /\.(mp4|webm|mov|mkv|gif)$/i.test(f.filename));
      if (files.length) {
        journal.info('génération', 'Résultat retrouvé sur l’instance d’après son nom de fichier');
        await this.deliver(files);
        return;
      }
      this.missingSince ??= now;
      if (now - this.missingSince > MISSING_MS) {
        this.fail(new GenerationError({ title: 'Génération introuvable sur l’instance', hint: 'Elle n’est plus dans la file et aucun résultat n’existe (instance recréée ou ComfyUI redémarré pendant le calcul). Relance la génération.' }));
      }
    } catch {
      if (!this.offline) {
        this.offline = true;
        this.status('Connexion perdue : la génération continue sur l’instance, reprise automatique au retour du réseau…');
        journal.warn('génération', 'Instance momentanément injoignable, la génération continue ; nouvelle tentative automatique');
      }
    } finally {
      this.watching = false;
    }
  }

  private async handleHistory(h: HistoryEntry) {
    if (h.status?.status_str === 'error') {
      const err = h.status.messages.find((m) => m[0] === 'execution_error');
      if (err) return this.fail(new GenerationError(explainExecutionError(err[1] as Record<string, string>)));
      if (h.status.messages.some((m) => m[0] === 'execution_interrupted')) return this.fail(new GenerationError({ title: 'Génération annulée', hint: '' }, true));
      return this.fail(new GenerationError({ title: 'Échec de la génération', hint: 'Voir le Journal.' }));
    }
    const files = findVideoOutputs(h.outputs);
    if (!files.length) return this.fail(new GenerationError({ title: 'Aucune vidéo produite', hint: 'Le workflow s’est terminé sans sortie vidéo.' }));
    this.enhancedPrompt = findEnhancedPrompt(h.outputs, this.input.model.enhancedPromptNode);
    await this.deliver(files);
  }

  /** Télécharge la vidéo (réessayé au prochain point de contrôle en cas de coupure). */
  private async deliver(files: FileRef[]) {
    if (this.finished || this.delivering) return;
    this.delivering = true;
    try {
      this.status('Téléchargement de la vidéo…');
      this.input.events?.onProgress?.({ overall: 0.995, label: 'Téléchargement' });
      const file = files[files.length - 1];
      const blob = await this.input.client.view(file);
      this.succeed({
        blob: blob.type ? blob : new Blob([blob], { type: 'video/mp4' }),
        file,
        promptId: this.promptId!,
        seed: this.input.params.seed,
        modelId: this.input.model.id,
        params: { ...this.input.params, outputPrefix: '' },
        elapsedMs: Date.now() - this.t0,
        enhancedPrompt: this.enhancedPrompt,
      });
      // Suppression des sorties sur l'instance une fois récupérées.
      void this.input.client.deleteFiles([...files, ...this.uploaded]).catch((e) => journal.warn('génération', 'Suppression des fichiers sur l’instance impossible', e));
    } catch (e) {
      if (!this.offline) {
        this.offline = true;
        this.status('Connexion perdue pendant le téléchargement : nouvelle tentative automatique…');
      }
      journal.warn('génération', 'Téléchargement de la vidéo interrompu, nouvelle tentative automatique', e instanceof Error ? e.message : e);
    } finally {
      this.delivering = false;
    }
  }

  private async sendCancel() {
    if (!this.promptId) return;
    try {
      await this.input.client.removeFromQueue([this.promptId]);
      await this.input.client.interrupt(this.promptId);
    } catch (e) {
      journal.warn('génération', 'Annulation : requête échouée', e);
    }
  }

  async cancel(): Promise<void> {
    if (this.finished) return;
    this.cancelled = true;
    journal.info('génération', 'Annulation demandée');
    this.status('Annulation…');
    if (!this.promptId) return;
    await this.sendCancel();
    setTimeout(() => {
      if (!this.finished) this.fail(new GenerationError({ title: 'Génération annulée', hint: '' }, true));
    }, 8000);
  }

  private cleanup() {
    this.finished = true;
    for (const t of this.timers) clearInterval(t);
    document.removeEventListener('visibilitychange', this.onVisible);
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* déjà fermé */
    }
  }
  private succeed(r: GenResult) {
    if (this.finished) return;
    this.cleanup();
    removePending(r.promptId);
    journal.info('génération', `Vidéo reçue (${(r.blob.size / 1e6).toFixed(1)} Mo, ${Math.round(r.elapsedMs / 1000)} s)`);
    this.resolveFn(r);
  }
  private fail(e: GenerationError) {
    if (this.finished) return;
    this.cleanup();
    if (this.promptId) removePending(this.promptId);
    if (!e.cancelled) journal.error('génération', `${e.readable.title}${e.readable.detail ? ' — ' + e.readable.detail : ''}`);
    if (this.uploaded.length) void this.input.client.deleteFiles(this.uploaded).catch(() => undefined);
    this.rejectFn(e);
  }
}

export { HttpError };
