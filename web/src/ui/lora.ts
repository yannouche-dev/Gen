// LoRA : carte d'installation (onglet Instance) et sélecteur (Générer, Style du Studio BD).
// Les fichiers viennent UNIQUEMENT de huggingface.co ; c'est l'instance qui les télécharge (token HF de l'instance).
import { h, replace, toast, fmtBytes } from './dom.ts';
import { confirmDialog } from './dialog.ts';
import { app, BUILD } from './context.ts';
import { journal } from '../core/journal.ts';
import { vault } from '../core/vault.ts';
import { requestJson, HttpError } from '../core/http.ts';
import { guessBase, loraFileName, parseHfLink, LORA_BASES, MAX_LORAS, type HfLink, type LoraChoice, type SavedLora } from '../workflows/lora.ts';

/** Fichiers .safetensors d'un dépôt (API Hugging Face, appelée depuis le navigateur). */
async function listRepoFiles(link: HfLink): Promise<string[]> {
  const tok = vault.secrets.hfToken;
  const r = await requestJson<{ siblings?: { rfilename: string }[] }>(`${BUILD.hfBase}/api/models/${link.repo}/revision/${encodeURIComponent(link.revision)}`, {
    cat: 'hf',
    headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    silentStatuses: [401, 403, 404],
  });
  return (r.siblings ?? []).map((s) => s.rfilename).filter((f) => f.endsWith('.safetensors'));
}

function errMessage(e: unknown): string {
  if (e instanceof HttpError) {
    const j = e.json<{ message?: string }>();
    if (j?.message) return j.message;
    if (e.status === 401 || e.status === 403) return 'accès refusé par Hugging Face (dépôt privé ou licence à accepter)';
    if (e.status === 404) return 'dépôt ou fichier introuvable sur Hugging Face';
  }
  return e instanceof Error ? e.message : String(e);
}

function remember(l: SavedLora) {
  const list = app.settings.savedLoras.filter((x) => !(x.repo === l.repo && x.path === l.path));
  app.saveSettings({ savedLoras: [...list, l] });
}

async function install(l: SavedLora): Promise<boolean> {
  const c = app.manager.comfy;
  if (!c) {
    toast('Démarre d’abord l’instance', 'error');
    return false;
  }
  try {
    const r = await c.installLora(l);
    remember(l);
    journal.info('lora', `${r.already ? 'Déjà installée' : 'Téléchargement lancé'} : ${l.repo}/${l.path} (${LORA_BASES[l.base] ?? l.base})`);
    toast(r.already ? 'LoRA déjà installée' : 'Téléchargement de la LoRA lancé sur l’instance', 'ok');
    await app.refreshLoras();
    return true;
  } catch (e) {
    toast(`LoRA refusée : ${errMessage(e)}`, 'error');
    journal.warn('lora', `Installation refusée : ${l.repo}/${l.path}`, errMessage(e));
    return false;
  }
}

/** Carte « LoRA » de l'onglet Instance. */
export class LoraCard {
  el = h('section', { class: 'card', 'data-testid': 'lora-card' });
  private pending: { link: HfLink; files: string[] } | null = null;
  private draft = '';
  private base = 'ltx25';

  constructor() {
    app.on((w) => {
      if (w === 'loras' || w === 'settings') this.render();
    });
    app.manager.onChange(() => this.render());
    this.render();
  }

  render(): void {
    const ready = app.manager.state.phase === 'ready' && !!app.manager.comfy;
    if (!ready) {
      replace(this.el, h('h2', null, 'LoRA'), h('p', { class: 'hint' }, 'Les LoRA s’installent sur une instance prête. Démarre l’instance pour en ajouter.'),
        app.settings.savedLoras.length ? h('p', { class: 'hint' }, `${app.settings.savedLoras.length} LoRA mémorisée(s) dans ce navigateur, à réinstaller sur la prochaine instance.`) : null);
      return;
    }
    const link = h('input', { class: 'input', value: this.draft, placeholder: 'https://huggingface.co/propriétaire/dépôt/blob/main/fichier.safetensors', 'data-testid': 'lora-link', inputmode: 'url' }) as HTMLInputElement;
    link.addEventListener('input', () => {
      this.draft = link.value;
      this.pending = null;
    });
    const base = h('select', { class: 'input', 'data-testid': 'lora-base' }) as HTMLSelectElement;
    for (const [k, l] of Object.entries(LORA_BASES)) base.append(h('option', { value: k, selected: k === this.base }, l));
    base.addEventListener('change', () => (this.base = base.value));
    link.addEventListener('change', () => {
      try {
        this.base = guessBase(parseHfLink(link.value));
        base.value = this.base;
      } catch {
        /* lien incomplet : on attend */
      }
    });
    const fileSel = this.pending
      ? (h('select', { class: 'input', 'data-testid': 'lora-file' }, ...this.pending.files.map((f) => h('option', { value: f }, f))) as HTMLSelectElement)
      : null;
    const go = h('button', { type: 'button', class: 'btn btn-primary btn-big', 'data-testid': 'lora-install' }, this.pending ? 'Installer ce fichier' : 'Installer');
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const l = this.pending ? { ...this.pending.link, path: fileSel!.value } : parseHfLink(link.value);
        if (!l.path) {
          const files = await listRepoFiles(l).catch((e) => {
            throw new Error(`liste des fichiers impossible (${errMessage(e)}) : colle le lien complet du fichier .safetensors`);
          });
          if (!files.length) throw new Error('aucun fichier .safetensors dans ce dépôt');
          if (files.length === 1) {
            if (await install({ repo: l.repo, path: files[0], revision: l.revision, base: base.value })) this.reset();
            return;
          }
          this.pending = { link: l, files };
          this.render();
          return;
        }
        if (await install({ repo: l.repo, path: l.path, revision: l.revision, base: base.value })) this.reset();
      } catch (e) {
        toast(errMessage(e), 'error');
      } finally {
        go.disabled = false;
      }
    });

    const { list, jobs } = app.loras;
    const missing = app.settings.savedLoras.filter((s) => !list.some((l) => l.file === loraFileName(s.repo, s.path)) && !jobs.some((j) => j.file === loraFileName(s.repo, s.path) && j.state === 'downloading'));
    replace(
      this.el,
      h('h2', null, 'LoRA'),
      h('p', { class: 'hint' }, 'Colle le lien Hugging Face d’une LoRA (fichier .safetensors, ou dépôt pour choisir le fichier). L’instance la télécharge avec ton token HF ; elle devient utilisable aussitôt dans Générer (LTX-2.5) ou dans le Style du Studio BD (FLUX.2).'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Lien Hugging Face'), link),
      fileSel ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Fichier'), fileSel) : null,
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Faite pour'), base),
      h('small', { class: 'hint' }, 'Une LoRA ne marche que sur le modèle pour lequel elle a été entraînée (une LoRA LTX-2 19B ne marche pas sur LTX-2.5).'),
      go,
      ...jobs.map((j) =>
        h('p', { class: `msg ${j.state === 'error' ? 'err' : 'info'}`, 'data-testid': 'lora-job' },
          j.state === 'error' ? `${j.file} : ${j.error}` : `Téléchargement de ${j.file} : ${j.size ? Math.round((j.done / j.size) * 100) : 0} %${j.size ? ` de ${fmtBytes(j.size)}` : ''}`),
      ),
      list.length
        ? h('ul', { class: 'lora-list' }, ...list.map((l) =>
            h('li', { 'data-testid': 'lora-item' },
              h('span', { class: 'lora-name' }, l.file.replace(/\.safetensors$/, '')),
              h('small', { class: 'hint' }, ` ${LORA_BASES[l.base ?? ''] ?? 'base inconnue'} · ${fmtBytes(l.size)}`),
              h('button', { type: 'button', class: 'btn btn-small btn-danger', 'aria-label': `Supprimer ${l.file}`, 'data-testid': 'lora-delete', on: { click: () => void this.remove(l.name, l.repo ?? undefined, l.path ?? undefined) } }, 'Supprimer'),
            )))
        : h('p', { class: 'hint' }, 'Aucune LoRA installée sur cette instance.'),
      missing.length
        ? h('button', { type: 'button', class: 'btn', 'data-testid': 'lora-reinstall', on: { click: async () => {
            for (const s of missing) await install(s);
          } } }, `Réinstaller mes LoRA (${missing.length})`)
        : null,
    );
  }

  private reset() {
    this.draft = '';
    this.pending = null;
    this.render();
  }

  private async remove(name: string, repo?: string, path?: string) {
    if (!(await confirmDialog({ title: 'Supprimer cette LoRA ?', body: ['Elle est effacée du disque de l’instance et oubliée par ce navigateur.'], ok: 'Supprimer', danger: true }))) return;
    try {
      await app.manager.comfy!.deleteLora(name);
      if (repo && path) app.saveSettings({ savedLoras: app.settings.savedLoras.filter((x) => !(x.repo === repo && x.path === path)) });
      toast('LoRA supprimée', 'ok');
    } catch (e) {
      toast(`Suppression impossible : ${errMessage(e)}`, 'error');
    }
    await app.refreshLoras();
  }
}

/**
 * Sélecteur de LoRA (jusqu'à 3) pour un modèle de base. `value` est modifié sur place ; `onChange` est appelé
 * à chaque changement (enregistrement), `rerender` quand le nombre de lignes change.
 */
export function loraPicker(base: string, value: LoraChoice[], onChange: () => void, rerender: () => void, testid = 'lora'): HTMLElement {
  const installed = app.lorasFor(base);
  const rows = value.map((l, i) => {
    const sel = h('select', { class: 'input', 'data-testid': `${testid}-name-${i + 1}` }) as HTMLSelectElement;
    const known = installed.some((x) => x.name === l.name);
    if (!known) sel.append(h('option', { value: l.name, selected: true }, `${l.name.replace(/^videogen\//, '')} (absente de l’instance)`));
    for (const x of installed) sel.append(h('option', { value: x.name, selected: x.name === l.name }, x.file.replace(/\.safetensors$/, '')));
    sel.addEventListener('change', () => {
      l.name = sel.value;
      onChange();
    });
    const out = h('span', { class: 'hint' }, l.strength.toFixed(2));
    const range = h('input', { type: 'range', min: -1, max: 2, step: 0.05, value: String(l.strength), class: 'range', 'data-testid': `${testid}-strength-${i + 1}`, 'aria-label': 'Force' }) as HTMLInputElement;
    range.addEventListener('input', () => {
      l.strength = Number(range.value);
      out.textContent = l.strength.toFixed(2);
      onChange();
    });
    const del = h('button', { type: 'button', class: 'btn btn-small', 'aria-label': 'Retirer la LoRA', on: { click: () => {
      value.splice(i, 1);
      onChange();
      rerender();
    } } }, '✕');
    return h('div', { class: 'lora-row' }, h('div', { class: 'row' }, sel, del), h('div', { class: 'row' }, h('span', { class: 'hint' }, 'Force'), range, out));
  });
  const add = installed.length && value.length < MAX_LORAS
    ? h('button', { type: 'button', class: 'btn btn-small', 'data-testid': `${testid}-add`, on: { click: () => {
        value.push({ name: installed.find((x) => !value.some((v) => v.name === x.name))?.name ?? installed[0].name, strength: 1 });
        onChange();
        rerender();
      } } }, '+ Ajouter une LoRA')
    : null;
  return h(
    'div',
    { class: 'field', 'data-testid': `${testid}-picker` },
    h('span', { class: 'field-label' }, `LoRA · ${LORA_BASES[base] ?? base}`),
    ...rows,
    add,
    !installed.length
      ? h('small', { class: 'hint' }, app.manager.state.phase === 'ready' ? 'Aucune LoRA installée pour ce modèle : onglet Instance → LoRA.' : 'Les LoRA se choisissent quand l’instance est prête.')
      : null,
  );
}
