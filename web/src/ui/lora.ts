// LoRA : carte d'installation (onglet Instance) et sélecteur (Générer, Style du Studio BD).
// Les fichiers viennent UNIQUEMENT de huggingface.co ; c'est l'instance qui les télécharge (token HF de l'instance).
import { h, replace, toast, fmtBytes } from './dom.ts';
import { confirmDialog } from './dialog.ts';
import { app, BUILD } from './context.ts';
import { journal } from '../core/journal.ts';
import { vault } from '../core/vault.ts';
import { requestJson, HttpError } from '../core/http.ts';
import { guessBase, loraFileName, parseHfLink, LORA_BASES, MAX_LORAS, type HfLink, type LoraChoice, type SavedLora } from '../workflows/lora.ts';
import { catalogPage, catalogQueries, mergeCatalog, CATALOG_BASES, type CatalogItem, type CatalogSort } from '../workflows/catalog.ts';

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

const nf = new Intl.NumberFormat('fr-FR');

/**
 * Catalogue des LoRA publiées sur Hugging Face pour LTX-2.5 ou FLUX.2 (API publique appelée depuis le navigateur,
 * sans token). Élément persistant : la carte LoRA est redessinée souvent, la liste et la recherche restent.
 */
class LoraCatalog {
  el = h('details', { class: 'lora-catalog', 'data-testid': 'lora-catalog' });
  private base = 'ltx25';
  private sort: CatalogSort = 'downloads';
  private text = '';
  private items: CatalogItem[] | null = null;
  private error = '';
  private loading = false;
  private shown = 30;
  private onInstall: (repo: string, base: string) => void;

  constructor(onInstall: (repo: string, base: string) => void) {
    this.onInstall = onInstall;
    this.el.addEventListener('toggle', () => {
      if (this.el.open && !this.items && !this.loading) void this.load();
    });
    this.render();
  }

  private async load() {
    this.loading = true;
    this.error = '';
    this.shown = 30;
    this.render();
    const results = await Promise.allSettled(
      catalogQueries(this.base, this.sort, this.text).map((q) => requestJson<unknown>(`${BUILD.hfBase}${q}`, { cat: 'hf', quiet: true })),
    );
    const ok = results.filter((r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled').map((r) => r.value);
    this.loading = false;
    if (!ok.length) {
      this.items = null;
      this.error = 'Liste indisponible depuis le navigateur (réseau, ou Hugging Face refuse l’appel direct).';
      journal.warn('lora', 'Catalogue Hugging Face indisponible', results.map((r) => (r.status === 'rejected' ? errMessage(r.reason) : 'ok')).join(' · '));
    } else {
      this.items = mergeCatalog(ok, this.base, this.sort);
      journal.info('lora', `Catalogue ${CATALOG_BASES[this.base].label} : ${this.items.length} LoRA`);
    }
    this.render();
  }

  render(): void {
    const base = h('select', { class: 'input', 'data-testid': 'catalog-base', 'aria-label': 'Modèle' }) as HTMLSelectElement;
    for (const [k, b] of Object.entries(CATALOG_BASES)) base.append(h('option', { value: k, selected: k === this.base }, b.label));
    base.addEventListener('change', () => {
      this.base = base.value;
      void this.load();
    });
    const sort = h('select', { class: 'input', 'data-testid': 'catalog-sort', 'aria-label': 'Tri' }) as HTMLSelectElement;
    for (const [k, l] of [['downloads', 'Les plus téléchargées'], ['likes', 'Les plus aimées'], ['lastModified', 'Les plus récentes']] as const) sort.append(h('option', { value: k, selected: k === this.sort }, l));
    sort.addEventListener('change', () => {
      this.sort = sort.value as CatalogSort;
      void this.load();
    });
    const text = h('input', { class: 'input', type: 'search', value: this.text, placeholder: 'Rechercher (ex. : dolly, anime, ink…)', 'data-testid': 'catalog-search', enterkeyhint: 'search' }) as HTMLInputElement;
    const search = () => {
      this.text = text.value.trim();
      void this.load();
    };
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') search();
    });
    const installed = new Set(app.loras.list.map((l) => l.repo));
    const items = this.items ?? [];
    const list = items.slice(0, this.shown).map((it) =>
      h(
        'li',
        { class: 'catalog-item', 'data-testid': 'catalog-item' },
        h('div', { class: 'catalog-head' }, h('strong', { class: 'catalog-name' }, it.name), h('small', { class: 'hint' }, ` · ${it.author}`)),
        h('small', { class: 'hint' }, `⬇ ${nf.format(it.downloads)} · ♥ ${nf.format(it.likes)}${it.updated ? ` · ${it.updated.slice(0, 10)}` : ''}`),
        h(
          'div',
          { class: 'row-wrap' },
          installed.has(it.id)
            ? h('span', { class: 'badge', 'data-testid': 'catalog-installed' }, '✓ installée')
            : h('button', { type: 'button', class: 'btn btn-small btn-primary', 'data-testid': 'catalog-install', on: { click: () => this.onInstall(it.id, this.base) } }, 'Installer'),
          h('a', { class: 'btn btn-small', href: `https://huggingface.co/${it.id}`, target: '_blank', rel: 'noopener noreferrer' }, 'Voir la page'),
        ),
      ),
    );
    replace(
      this.el,
      h('summary', null, 'Catalogue Hugging Face : toutes les LoRA disponibles'),
      h('div', { class: 'row' }, base, sort),
      h('div', { class: 'row' }, text, h('button', { type: 'button', class: 'btn btn-small', 'data-testid': 'catalog-go', on: { click: search } }, 'Chercher')),
      this.loading ? h('p', { class: 'hint', 'data-testid': 'catalog-loading' }, 'Chargement de la liste…') : null,
      this.error ? h('p', { class: 'msg warn', 'data-testid': 'catalog-error' }, this.error) : null,
      this.items
        ? h('p', { class: 'hint', 'data-testid': 'catalog-count' }, items.length ? `${items.length} LoRA pour ${CATALOG_BASES[this.base].label}${this.text ? ` (« ${this.text} »)` : ''}` : 'Aucune LoRA trouvée.')
        : null,
      list.length ? h('ul', { class: 'catalog-list' }, ...list) : null,
      items.length > this.shown
        ? h('button', { type: 'button', class: 'btn btn-small', 'data-testid': 'catalog-more', on: { click: () => ((this.shown += 30), this.render()) } }, `Afficher plus (${items.length - this.shown} de plus)`)
        : null,
      h(
        'small',
        { class: 'hint' },
        'Source : API publique de Hugging Face (dépôts qui déclarent ce modèle de base, et recherche par nom). Les dépôts réservés aux adultes ne sont pas listés. ',
        h('a', { href: catalogPage(this.base), target: '_blank', rel: 'noopener noreferrer' }, 'Voir la liste sur Hugging Face'),
      ),
    );
  }
}

/** Carte « LoRA » de l'onglet Instance. */
export class LoraCard {
  el = h('section', { class: 'card', 'data-testid': 'lora-card' });
  private pending: { link: HfLink; files: string[] } | null = null;
  private draft = '';
  private base = 'ltx25';
  private catalog = new LoraCatalog((repo, base) => void this.fromCatalog(repo, base));

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
      replace(this.el, h('h2', null, 'LoRA'), h('p', { class: 'hint' }, 'Les LoRA s’installent sur une instance prête. Démarre l’instance pour en ajouter ; tu peux déjà parcourir le catalogue.'),
        app.settings.savedLoras.length ? h('p', { class: 'hint' }, `${app.settings.savedLoras.length} LoRA mémorisée(s) dans ce navigateur, à réinstaller sur la prochaine instance.`) : null,
        this.catalog.el);
      this.catalog.render();
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
        await this.installFrom(this.pending ? { ...this.pending.link, path: fileSel!.value } : parseHfLink(link.value), base.value);
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
      this.catalog.el,
    );
    this.catalog.render();
  }

  /** Installe depuis un lien : fichier direct, ou choix du fichier quand le dépôt en a plusieurs. */
  private async installFrom(l: HfLink, base: string) {
    if (!l.path) {
      const files = await listRepoFiles(l).catch((e) => {
        throw new Error(`liste des fichiers impossible (${errMessage(e)}) : colle le lien complet du fichier .safetensors`);
      });
      if (!files.length) throw new Error('aucun fichier .safetensors dans ce dépôt');
      if (files.length > 1) {
        this.pending = { link: l, files };
        this.render();
        this.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast(`Choisis le fichier à installer (${files.length} dans ce dépôt)`, 'info');
        return;
      }
      l = { ...l, path: files[0] };
    }
    if (await install({ repo: l.repo, path: l.path!, revision: l.revision, base })) this.reset();
  }

  private async fromCatalog(repo: string, base: string) {
    if (app.manager.state.phase !== 'ready' || !app.manager.comfy) return void toast('Démarre d’abord l’instance pour installer une LoRA', 'error');
    this.base = base;
    this.draft = `https://huggingface.co/${repo}`;
    try {
      await this.installFrom({ repo, path: null, revision: 'main' }, base);
    } catch (e) {
      toast(errMessage(e), 'error');
    }
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
