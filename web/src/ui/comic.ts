// Écran « BD » : projets (chiffrés dans le téléphone), personnages de référence, style, découpage de l'histoire
// par l'IA locale (Qwen 3.5), génération des cases (FLUX.2 Dev, références multiples), mise en page avec bulles,
// export PDF / CBZ / PNG.
import { h, replace, toast, download } from './dom.ts';
import { confirmDialog } from './dialog.ts';
import { app } from './context.ts';
import { journal } from '../core/journal.ts';
import { vault } from '../core/vault.ts';
import { listPending, removePending, type PendingJob } from '../core/pending.ts';
import { holdAwake, releaseAwake } from '../core/wakelock.ts';
import { randomSeed, checkAvailability, type ApiPrompt, type GenParams } from '../workflows/build.ts';
import { Generation, GenerationError, type GenEvents } from '../comfy/generate.ts';
import { explainError } from '../comfy/errors.ts';
import {
  LAYOUTS, SHOTS, STYLES, TONES, PAGE_W, PAGE_H, SETTING_SIZE, SHEET_SIZE, cellRects, generationSize, getLayout, layoutFor, newPanel, newProject, panelPrompt,
  turnaroundPrompt, settingPrompt, describeCharacterPrompt, storyPrompt, parseStory, storyToPages, biblePrompt, parseBible, applyBible, uid,
  type Bubble, type Character, type Page, type Panel, type Project, type Setting,
} from '../comic/model.ts';
import { buildFlux, buildQwen, outputKey, FLUX, QWEN } from '../comic/flux.ts';
import { planComic, countImages, type ImageJob, type OutputTarget } from '../comic/express.ts';
import { listProjects, saveProject, deleteProject, putImage, getImage, deleteImage, toJpeg } from '../comic/store.ts';
import { renderPage, canvasToBlob, type BubbleBox } from '../comic/render.ts';
import { buildCbz, buildPdf } from '../comic/export.ts';
import { loraPicker } from './lora.ts';
import { DEFAULT_FLUX_LORA, loraFileName } from '../workflows/lora.ts';
import { openViewer } from './viewer.ts';

type Step = 'chars' | 'sets' | 'style' | 'story' | 'pages' | 'export';
const STEPS: [Step, string][] = [
  ['chars', 'Personnages'],
  ['sets', 'Décors'],
  ['style', 'Style'],
  ['story', 'Histoire'],
  ['pages', 'Pages'],
  ['export', 'Export'],
];

const DUMMY = (seed: number): Omit<GenParams, 'startImage' | 'endImage' | 'middleImage' | 'outputPrefix'> => ({
  prompt: 'bd',
  preset: '',
  ratio: '',
  duration: 0,
  fps: 0,
  seed,
});

export class ComicScreen {
  el = h('div', { class: 'screen', 'data-testid': 'comic' });
  private projects: Project[] = [];
  private p: Project | null = null;
  private step: Step = 'chars';
  private pageIdx = 0;
  private loaded = false;
  private busy = '';
  private wf: { flux?: ApiPrompt; qwen?: ApiPrompt } = {};
  private urls = new Map<string, string>();
  private statusEls = new Map<string, HTMLElement>();
  private current: Generation | null = null;
  private resuming = false;
  /** Travaux d'images envoyés dans la file de l'instance (pages complètes, planches). */
  private bg: { job: ImageJob; gen: Generation; status: string; projectId: string }[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    app.on((w) => {
      if (w === 'route' && app.route === 'comic') void this.open();
      if ((w === 'availability' || w === 'loras') && app.route === 'comic' && this.step === 'style') this.render();
      else if (w === 'availability' && app.route === 'comic') this.render();
    });
    app.manager.onChange((s) => {
      if (s.phase === 'ready' && app.manager.comfy && listPending().some((j) => j.meta?.comic)) void this.resumePending();
      for (const b of this.bg) {
        if ((s.phase === 'idle' && !s.instance) || (s.instance && s.instance.id !== b.gen.instanceId)) {
          b.gen.abandon('Instance détruite : travail perdu', 'Relance la génération des cases vides sur une nouvelle instance.');
        }
      }
    });
  }

  private async open() {
    void this.ensureFluxLora();
    if (!this.loaded) {
      try {
        const [flux, qwen] = await Promise.all([FLUX.workflow, QWEN.workflow].map(async (f) => (await (await fetch(f, { cache: 'no-cache' })).json()) as ApiPrompt));
        this.wf = { flux, qwen };
        this.projects = await listProjects();
        this.p = this.projects[0] ?? null;
        this.loaded = true;
      } catch (e) {
        journal.error('bd', 'Chargement du Studio BD impossible', e);
        toast('Chargement du Studio BD impossible (voir Journal)', 'error');
      }
    }
    this.render();
  }

  // ---------------------------------------------------------------- utilitaires

  private save(now = false) {
    if (!this.p) return;
    const p = this.p;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const run = () => saveProject(p).catch((e) => {
      journal.error('bd', 'Enregistrement du projet impossible', e);
      toast('Enregistrement impossible (stockage plein ?)', 'error');
    });
    if (now) return run();
    this.saveTimer = setTimeout(run, 600);
  }

  private async url(id: string): Promise<string | null> {
    if (this.urls.has(id)) return this.urls.get(id)!;
    const b = await getImage(id).catch(() => null);
    if (!b) return null;
    const u = URL.createObjectURL(b);
    this.urls.set(id, u);
    return u;
  }

  private thumb(id: string, alt: string, onRemove?: () => void): HTMLElement {
    const img = h('img', { alt, class: 'thumb', style: 'cursor:zoom-in' }) as HTMLImageElement;
    void this.url(id).then((u) => u && (img.src = u));
    img.addEventListener('click', () => {
      void this.url(id).then((u) => {
        if (!u) return;
        openViewer({
          count: 1,
          start: 0,
          title: alt,
          render: async () => {
            const canvas = document.createElement('canvas');
            const imgEl = new Image();
            imgEl.src = u;
            await imgEl.decode();
            canvas.width = imgEl.naturalWidth;
            canvas.height = imgEl.naturalHeight;
            canvas.getContext('2d')!.drawImage(imgEl, 0, 0);
            return canvas;
          },
        });
      });
    });
    return h('div', { class: 'thumb-box' }, img, onRemove ? h('button', { type: 'button', class: 'btn btn-small', 'aria-label': 'Retirer', on: { click: (e) => { e.stopPropagation(); onRemove(); } } }, '✕') : null);
  }

  private availability(): { flux: boolean | null; qwen: boolean | null } {
    const info = app.objectInfo;
    if (!info || !this.wf.flux || !this.wf.qwen) return { flux: null, qwen: null };
    return { flux: checkAvailability(this.wf.flux, info).ok, qwen: checkAvailability(this.wf.qwen, info).ok };
  }

  private ready(kind: 'flux' | 'qwen'): boolean {
    if (app.manager.state.phase !== 'ready' || !app.manager.comfy) {
      toast('Démarre d’abord l’instance (onglet Instance)', 'error');
      return false;
    }
    const av = this.availability()[kind];
    if (av === false) {
      toast(kind === 'flux' ? 'FLUX.2 Dev n’est pas installé sur cette instance' : 'Qwen 3.5 n’est pas installé sur cette instance', 'error');
      return false;
    }
    return true;
  }

  private events(id: string): GenEvents {
    const el = () => this.statusEls.get(id);
    return {
      onStatus: (t) => {
        const e = el();
        if (e) e.textContent = t;
      },
      onProgress: (p) => {
        const e = el();
        if (e) e.textContent = `${Math.round(p.overall * 100)} % · ${p.label}${p.max ? ` (${p.value}/${p.max})` : ''}`;
      },
    };
  }

  /** Lance un workflow FLUX.2 (case, planche de poses). Les images sont envoyées comme références. */
  private async runImage(statusId: string, label: string, refs: Blob[], prompt: string, size: { width: number; height: number }, seed: number, meta?: Record<string, unknown>): Promise<Blob> {
    const c = app.manager.comfy!;
    const flux = this.wf.flux!;
    const turbo = this.p!.style.turbo;
    holdAwake('bd');
    try {
      const gen = new Generation({
        client: c,
        clientRef: () => app.manager.comfy,
        registry: app.registry!,
        model: { id: 'flux2-bd', label },
        workflow: flux,
        params: DUMMY(seed),
        uploads: refs,
        prebuilt: (names, prefix) => buildFlux(flux, { prompt, refs: names, width: size.width, height: size.height, seed, turbo, loras: this.styleLoras(), outputPrefix: prefix }),
        kind: 'image',
        stallMinutes: app.settings.stallMinutes,
        instanceId: app.manager.state.instance!.id,
        meta: meta ? { comic: true, ...meta } : undefined,
        persist: !!meta,
        events: this.events(statusId),
      });
      this.current = gen;
      const r = await gen.promise;
      return r.blob;
    } finally {
      this.current = null;
      releaseAwake('bd');
    }
  }

  private async runText(statusId: string, label: string, prompt: string, image: Blob | null, maxLength: number, temperature: number): Promise<string> {
    const c = app.manager.comfy!;
    const qwen = this.wf.qwen!;
    holdAwake('bd');
    try {
      const gen = new Generation({
        client: c,
        clientRef: () => app.manager.comfy,
        registry: app.registry!,
        model: { id: 'qwen35-bd', label },
        workflow: qwen,
        params: DUMMY(0),
        uploads: image ? [image] : [],
        prebuilt: (names) => buildQwen(qwen, { prompt, image: names[0], maxLength, temperature, seed: randomSeed() }),
        kind: 'text',
        textNode: QWEN.preview,
        persist: false,
        stallMinutes: app.settings.stallMinutes,
        instanceId: app.manager.state.instance!.id,
        events: this.events(statusId),
      });
      this.current = gen;
      return (await gen.promise).text ?? '';
    } finally {
      this.current = null;
      releaseAwake('bd');
    }
  }

  /** LoRA de style du projet réellement présentes sur l'instance (les autres sont ignorées, avec un avertissement). */
  private styleLoras() {
    const want = this.p?.style.loras ?? [];
    const have = new Set(app.loras.list.map((l) => l.name));
    const ok = want.filter((l) => have.has(l.name));
    if (ok.length < want.length) toast('LoRA de style absente(s) de l’instance ignorée(s) (onglet Instance → Réinstaller mes LoRA)', 'info');
    return ok;
  }

  private async guard(name: string, fn: () => Promise<void>) {
    if (this.busy) return toast(`Patiente : ${this.busy}`, 'info');
    this.busy = name;
    this.render();
    try {
      await fn();
    } catch (e) {
      const r = e instanceof GenerationError ? e.readable : explainError(e);
      if (!(e instanceof GenerationError && e.cancelled)) {
        journal.error('bd', `${name} : ${r.title}`, r.detail ?? e);
        toast(`${r.title}${r.hint ? ' — ' + r.hint : ''}`, 'error');
      }
    } finally {
      this.busy = '';
      this.render();
    }
  }

  // ---------------------------------------------------------------- rendu

  render(): void {
    this.statusEls.clear();
    const p = this.p;
    const select = h('select', { class: 'input', 'data-testid': 'project-select', 'aria-label': 'Projet' }) as HTMLSelectElement;
    if (!this.projects.length) select.append(h('option', { value: '' }, 'Aucun projet'));
    for (const pr of this.projects) select.append(h('option', { value: pr.id, selected: pr.id === p?.id }, pr.title));
    select.addEventListener('change', () => {
      this.p = this.projects.find((x) => x.id === select.value) ?? null;
      this.pageIdx = 0;
      this.render();
    });
    const av = this.availability();
    const notices: (HTMLElement | null)[] = [
      !vault.isRemembered() ? h('p', { class: 'msg warn' }, 'Tes clés sont en mémoire seulement : les projets ne pourront pas être relus après fermeture de l’onglet (écran Clés → Mémoriser).') : null,
      app.manager.state.phase !== 'ready' ? h('p', { class: 'msg info' }, 'Pour générer, démarre une instance avec les familles « Studio BD : FLUX.2 Dev » et « IA d’écriture Qwen 3.5 » (Instance → Réglages de location). Tu peux préparer ton projet en attendant.') : null,
      av.flux === false || av.qwen === false
        ? h('p', { class: 'msg warn', 'data-testid': 'comic-missing' }, `Absent de l’instance : ${[av.flux === false ? 'FLUX.2 Dev' : '', av.qwen === false ? 'Qwen 3.5' : ''].filter(Boolean).join(', ')}. Coche ces familles dans les réglages de location et loue une nouvelle instance.`)
        : null,
      this.busy ? h('p', { class: 'msg info', 'data-testid': 'comic-busy' }, `En cours : ${this.busy}`, ' ', h('button', { type: 'button', class: 'btn btn-small', on: { click: () => void this.current?.cancel() } }, 'Annuler')) : null,
      this.bg.length ? this.renderJobs() : null,
    ];
    replace(
      this.el,
      h(
        'section',
        { class: 'card' },
        h('h1', null, 'Studio BD'),
        h('div', { class: 'row' }, select, h('button', { type: 'button', class: 'btn btn-small', 'data-testid': 'new-project', on: { click: () => void this.createProject() } }, 'Nouveau')),
        p
          ? h(
              'div',
              { class: 'row-wrap' },
              h('button', { type: 'button', class: 'btn btn-small', on: { click: () => void this.renameProject() } }, 'Renommer'),
              h('button', { type: 'button', class: 'btn btn-small btn-danger', on: { click: () => void this.removeProject() } }, 'Supprimer'),
            )
          : null,
        ...notices,
      ),
      p
        ? h(
            'nav',
            { class: 'segmented steps-nav', 'aria-label': 'Étapes' },
            ...STEPS.map(([s, label]) =>
              h('button', { type: 'button', class: `seg ${this.step === s ? 'active' : ''}`, 'data-testid': `step-${s}`, on: { click: () => ((this.step = s), this.render()) } }, label),
            ),
          )
        : h('p', { class: 'card hint' }, 'Crée un projet pour commencer : personnages de référence, style, histoire, puis pages.'),
      p ? this.renderStep(p) : null,
    );
  }

  private renderStep(p: Project): HTMLElement {
    switch (this.step) {
      case 'chars':
        return this.renderChars(p);
      case 'sets':
        return this.renderSets(p);
      case 'style':
        return this.renderStyle(p);
      case 'story':
        return this.renderStory(p);
      case 'pages':
        return this.renderPages(p);
      case 'export':
        return this.renderExport(p);
    }
  }

  // ---------------------------------------------------------------- projets


  /** Installe et active automatiquement la LoRA FLUX recommandée sur le projet courant. */
  private async ensureFluxLora() {
    const p = this.p;
    if (!p || !app.manager.comfy) return;
    const file = loraFileName(DEFAULT_FLUX_LORA.repo, DEFAULT_FLUX_LORA.path);
    const installed = app.lorasFor('flux2dev').find((l) => l.file === file);
    if (!installed) {
      try {
        await app.manager.comfy.installLora(DEFAULT_FLUX_LORA);
        journal.info('lora', 'Installation automatique de la LoRA FLUX');
        await app.refreshLoras();
      } catch (e) {
        journal.warn('lora', 'Installation auto LoRA FLUX échouée', String(e));
        return;
      }
    }
    const found = app.lorasFor('flux2dev').find((l) => l.file === file);
    if (!found) return;
    const has = (p.style.loras ?? []).some((l) => l.name === found.name);
    if (!has) {
      p.style.loras = [...(p.style.loras ?? []), { name: found.name, strength: 0.85 }];
      await this.save(true);
    }
  }

  private async createProject() {
    const title = window.prompt('Titre de la BD', 'Ma BD')?.trim();
    if (!title) return;
    const p = newProject(title);
    this.projects.unshift(p);
    this.p = p;
    this.step = 'chars';
    await this.save(true);
    this.render();
  }

  private async renameProject() {
    if (!this.p) return;
    const t = window.prompt('Nouveau titre', this.p.title)?.trim();
    if (!t) return;
    this.p.title = t;
    await this.save(true);
    this.render();
  }

  private async removeProject() {
    const p = this.p;
    if (!p || !(await confirmDialog({ title: `Supprimer « ${p.title} » ?`, body: ['Le projet, ses personnages et toutes ses images seront effacés de ce téléphone.'], ok: 'Supprimer', danger: true }))) return;
    await deleteProject(p);
    this.projects = this.projects.filter((x) => x.id !== p.id);
    this.p = this.projects[0] ?? null;
    this.render();
  }

  // ---------------------------------------------------------------- personnages

  private renderChars(p: Project): HTMLElement {
    const card = (c: Character) => {
      const name = h('input', { class: 'input', value: c.name, placeholder: 'Nom', 'data-testid': `char-name-${c.id}` }) as HTMLInputElement;
      name.addEventListener('input', () => {
        c.name = name.value;
        this.save();
      });
      const desc = h('textarea', { class: 'input', rows: 4, placeholder: 'Apparence : âge, visage, cheveux, tenue, couleurs…', 'data-testid': `char-desc-${c.id}` }) as HTMLTextAreaElement;
      desc.value = c.description;
      desc.addEventListener('input', () => {
        c.description = desc.value;
        this.save();
      });
      const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'input', 'data-testid': `char-image-${c.id}`, disabled: c.imageIds.length >= 3 }) as HTMLInputElement;
      file.addEventListener('change', async () => {
        const f = file.files?.[0];
        if (!f) return;
        c.imageIds.push(await putImage(p.id, await toJpeg(f)));
        await this.save(true);
        this.render();
      });
      const status = h('small', { class: 'hint' });
      this.statusEls.set(c.id, status);
      return h(
        'div',
        { class: 'card', 'data-testid': `char-${c.id}` },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Nom'), name),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, `Images de référence (${c.imageIds.length}/3)`), h('div', { class: 'thumbs' }, ...c.imageIds.map((id) => this.thumb(id, c.name, () => void this.removeCharImage(c, id)))), file),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Description'), desc),
        h(
          'div',
          { class: 'row-wrap' },
          h('button', { type: 'button', class: 'btn btn-small', disabled: !c.imageIds.length || !!this.busy, 'data-testid': `char-describe-${c.id}`, on: { click: () => void this.describe(c) } }, 'Décrire avec l’IA'),
          h('button', { type: 'button', class: 'btn btn-small', disabled: (!c.imageIds.length && !c.description.trim()) || !!this.busy, 'data-testid': `char-sheet-${c.id}`, on: { click: () => void this.turnaround(c) } }, c.imageIds.length ? 'Planche de poses' : 'Dessiner d’après la description'),
          h('button', { type: 'button', class: 'btn btn-small btn-danger', on: { click: () => void this.removeChar(c) } }, 'Supprimer'),
        ),
        status,
      );
    };
    return h(
      'section',
      { class: 'stack' },
      h('p', { class: 'hint card' }, 'Ajoute 1 à 3 images nettes de chaque personnage (visage et tenue visibles). Elles sont envoyées au modèle comme « images de référence » pour chaque case où il apparaît. La « planche de poses » génère des vues de face, profil et dos pour renforcer la cohérence. Sans photo, le personnage est dessiné d’après sa description, et ce dessin devient sa référence.'),
      ...p.characters.map(card),
      h('button', { type: 'button', class: 'btn btn-primary', 'data-testid': 'add-char', on: { click: () => void this.addChar() } }, '+ Ajouter un personnage'),
    );
  }

  private async addChar() {
    const p = this.p!;
    p.characters.push({ id: uid('k'), name: `Personnage ${p.characters.length + 1}`, description: '', imageIds: [] });
    await this.save(true);
    this.render();
  }
  private async removeChar(c: Character) {
    const p = this.p!;
    if (!(await confirmDialog({ title: `Supprimer ${c.name} ?`, ok: 'Supprimer', danger: true }))) return;
    for (const id of c.imageIds) await deleteImage(id).catch(() => undefined);
    p.characters = p.characters.filter((x) => x.id !== c.id);
    for (const pg of p.pages) for (const pa of pg.panels) pa.characters = pa.characters.filter((x) => x !== c.id);
    await this.save(true);
    this.render();
  }
  private async removeCharImage(c: Character, id: string) {
    c.imageIds = c.imageIds.filter((x) => x !== id);
    await deleteImage(id).catch(() => undefined);
    await this.save(true);
    this.render();
  }

  private describe(c: Character) {
    if (!this.ready('qwen')) return;
    return this.guard(`description de ${c.name}`, async () => {
      const img = await getImage(c.imageIds[0]);
      const text = await this.runText(c.id, `Qwen 3.5 · description de ${c.name}`, describeCharacterPrompt(c.name), img, 300, 0.4);
      c.description = text.trim().replace(/^["“]|["”]$/g, '');
      await this.save(true);
      toast('Description proposée par l’IA (modifiable)', 'ok');
    });
  }

  private turnaround(c: Character) {
    if (!this.ready('flux')) return;
    return this.guard(`planche de poses de ${c.name}`, async () => {
      const ref = c.imageIds.length ? await getImage(c.imageIds[0]) : null;
      if (c.imageIds.length && !ref) throw new Error('Image de référence introuvable');
      const blob = await this.runImage(c.id, `FLUX.2 · poses de ${c.name}`, ref ? [ref] : [], turnaroundPrompt(this.p!, c, !!ref), SHEET_SIZE, randomSeed());
      const id = await putImage(this.p!.id, await toJpeg(blob));
      if (c.imageIds.length >= 3) {
        const old = c.imageIds.pop()!;
        await deleteImage(old).catch(() => undefined);
      }
      c.imageIds.push(id);
      await this.save(true);
      toast('Planche de poses ajoutée aux références', 'ok');
    });
  }

  // ---------------------------------------------------------------- décors

  private renderSets(p: Project): HTMLElement {
    const card = (st: Setting) => {
      const name = h('input', { class: 'input', value: st.name, placeholder: 'Nom (ex. : la librairie)', 'data-testid': `set-name-${st.id}` }) as HTMLInputElement;
      name.addEventListener('input', () => ((st.name = name.value), this.save()));
      const desc = h('textarea', { class: 'input', rows: 3, placeholder: 'Ce qu’on y voit : architecture, meubles, couleurs, lumière…', 'data-testid': `set-desc-${st.id}` }) as HTMLTextAreaElement;
      desc.value = st.description;
      desc.addEventListener('input', () => ((st.description = desc.value), this.save()));
      const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'input', disabled: st.imageIds.length >= 2 }) as HTMLInputElement;
      file.addEventListener('change', async () => {
        const f = file.files?.[0];
        if (!f) return;
        st.imageIds.unshift(await putImage(p.id, await toJpeg(f)));
        await this.save(true);
        this.render();
      });
      const status = h('small', { class: 'hint' });
      this.statusEls.set(st.id, status);
      return h(
        'div',
        { class: 'card', 'data-testid': `set-${st.id}` },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Nom'), name),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Description'), desc),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, `Image de référence (${st.imageIds.length}/2)`), h('div', { class: 'thumbs' }, ...st.imageIds.map((id) => this.thumb(id, st.name, () => void (async () => {
          st.imageIds = st.imageIds.filter((x) => x !== id);
          await deleteImage(id).catch(() => undefined);
          await this.save(true);
          this.render();
        })()))), file),
        h('div', { class: 'row-wrap' },
          h('button', { type: 'button', class: 'btn btn-small', disabled: !st.description.trim() || !!this.busy, 'data-testid': `set-gen-${st.id}`, on: { click: () => void this.drawSetting(st) } }, st.imageIds.length ? 'Redessiner le décor' : 'Dessiner le décor'),
          h('button', { type: 'button', class: 'btn btn-small btn-danger', on: { click: () => void this.removeSetting(st) } }, 'Supprimer')),
        status,
      );
    };
    return h(
      'section',
      { class: 'stack' },
      h('p', { class: 'hint card' }, 'Les lieux qui reviennent (la librairie, l’appartement…). Leur image de référence est envoyée au modèle pour chaque case qui s’y passe : mêmes murs, mêmes meubles, mêmes couleurs d’une page à l’autre. Ajoute une photo ou fais dessiner le décor d’après sa description.'),
      ...p.settings.map(card),
      h('button', { type: 'button', class: 'btn btn-primary', 'data-testid': 'add-set', on: { click: () => void (async () => {
        p.settings.push({ id: uid('s'), name: `Décor ${p.settings.length + 1}`, description: '', imageIds: [] });
        await this.save(true);
        this.render();
      })() } }, '+ Ajouter un décor'),
    );
  }

  private async removeSetting(st: Setting) {
    const p = this.p!;
    if (!(await confirmDialog({ title: `Supprimer le décor « ${st.name} » ?`, ok: 'Supprimer', danger: true }))) return;
    for (const id of st.imageIds) await deleteImage(id).catch(() => undefined);
    p.settings = p.settings.filter((x) => x !== st);
    for (const pg of p.pages) for (const pa of pg.panels) if (pa.setting === st.id) pa.setting = undefined;
    await this.save(true);
    this.render();
  }

  private drawSetting(st: Setting) {
    if (!this.ready('flux')) return;
    return this.guard(`décor « ${st.name} »`, async () => {
      const blob = await this.runImage(st.id, `FLUX.2 · décor ${st.name}`, [], settingPrompt(this.p!, st), SETTING_SIZE, randomSeed());
      const old = st.imageIds.length >= 2 ? st.imageIds.pop() : undefined;
      if (old) await deleteImage(old).catch(() => undefined);
      st.imageIds.unshift(await putImage(this.p!.id, await toJpeg(blob)));
      await this.save(true);
      toast('Décor dessiné : il servira de référence', 'ok');
    });
  }

  // ---------------------------------------------------------------- BD express

  private renderExpress(p: Project): HTMLElement {
    const title = h('input', { class: 'input', value: p.title, placeholder: 'ex. : La libraire veut rendre son mari jaloux', 'data-testid': 'express-title' }) as HTMLInputElement;
    const pages = h('select', { class: 'input', 'data-testid': 'express-pages' }) as HTMLSelectElement;
    for (let n = 1; n <= 6; n++) pages.append(h('option', { value: n, selected: n === 3 }, `${n} page${n > 1 ? 's' : ''}`));
    const tone = h('select', { class: 'input', 'data-testid': 'express-tone' }) as HTMLSelectElement;
    for (const [k, l] of TONES) tone.append(h('option', { value: k, selected: k === (p.tone ?? 'comédie') }, l));
    const style = STYLES.find((x) => x.id === p.style.preset)?.label ?? p.style.preset;
    const status = h('small', { class: 'hint', 'data-testid': 'express-status' });
    this.statusEls.set('express', status);
    return h(
      'section',
      { class: 'card express' },
      h('h2', null, 'BD express : un titre suffit'),
      h('p', { class: 'hint' }, 'L’IA écrit l’histoire page par page, crée les personnages et les décors, les dessine une fois pour toutes, puis dessine toutes les cases avec ces références : même style, mêmes visages, mêmes lieux. Tout part dans la file de l’instance ; tu peux verrouiller le téléphone.'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Titre'), title),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Pages'), pages),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Ton'), tone)),
      h('p', { class: 'hint' }, `Style : ${style}${p.style.turbo ? ' · rapide (Turbo)' : ' · qualité'} — `, h('button', { type: 'button', class: 'btn btn-small', on: { click: () => ((this.step = 'style'), this.render()) } }, 'changer')),
      p.characters.length ? h('p', { class: 'hint' }, `Tes personnages (${p.characters.map((c) => c.name).join(', ')}) seront les héros de l’histoire.`) : null,
      h('button', { type: 'button', class: 'btn btn-primary btn-big', disabled: !!this.busy, 'data-testid': 'express-go', on: { click: () => void this.express(title.value.trim(), Number(pages.value), tone.value) } }, 'Créer la BD'),
      status,
    );
  }

  /** Demande un JSON à Qwen 3.5, avec une nouvelle tentative si la réponse est illisible. */
  private async askJson<T>(label: string, prompt: string, maxLength: number, temperature: number, parse: (t: string) => T): Promise<T> {
    let last: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const text = await this.runText('express', `Qwen 3.5 · ${label}`, prompt, null, maxLength, temperature);
      try {
        return parse(text);
      } catch (e) {
        last = e;
        journal.warn('bd', `Réponse de l’IA illisible (${label}, essai ${attempt})`, text.slice(0, 3000));
      }
    }
    throw new Error(`Réponse de l’IA illisible (${last instanceof Error ? last.message : last}) : relance`);
  }

  private express(title: string, pages: number, tone: string) {
    const p = this.p!;
    if (!title) return toast('Donne un titre à ta BD', 'error');
    if (!this.ready('qwen') || !this.ready('flux')) return;
    return this.guard('BD express', async () => {
      if (p.pages.length && !(await confirmDialog({ title: 'Remplacer les pages existantes ?', body: ['La BD express réécrit l’histoire et redessine toutes les cases.'], ok: 'Remplacer', danger: true }))) return;
      p.title = title;
      p.tone = tone;
      p.seed = randomSeed();
      this.setStatus('express', '1/3 · L’IA écrit l’histoire, les personnages et les décors…');
      const bible = await this.askJson('histoire', biblePrompt(p, title, pages), 2048, 0.8, (t) => parseBible(t, pages));
      applyBible(p, bible);
      await this.save(true);
      journal.info('bd', `BD express « ${title} » : ${bible.characters.length} personnage(s), ${bible.settings.length} décor(s)`);
      this.setStatus('express', '2/3 · L’IA découpe les pages en cases et écrit les dialogues…');
      const story = await this.askJson('découpage', storyPrompt(p, pages), 4096, 0.6, parseStory);
      for (const pg of p.pages) for (const pa of pg.panels) if (pa.imageId) await deleteImage(pa.imageId).catch(() => undefined);
      p.pages = storyToPages(p, story);
      this.pageIdx = 0;
      await this.save(true);
      this.setStatus('express', '3/3 · Envoi des dessins dans la file de l’instance…');
      const jobs = planComic(p, { loras: this.styleLoras() });
      await this.queueJobs(p, jobs);
      this.step = 'pages';
      journal.info('bd', `BD express : ${p.pages.length} page(s), ${countImages(jobs)} image(s) en file`);
    });
  }

  // ---------------------------------------------------------------- style

  private renderStyle(p: Project): HTMLElement {
    const st = p.style;
    const extra = h('input', { class: 'input', value: st.extra, placeholder: 'Précisions (ex. : tons pastel, encrage épais, ambiance pluvieuse)', 'data-testid': 'style-extra' }) as HTMLInputElement;
    extra.addEventListener('input', () => {
      st.extra = extra.value;
      this.save();
    });
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'input', 'data-testid': 'style-image' }) as HTMLInputElement;
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      if (st.refImageId) await deleteImage(st.refImageId).catch(() => undefined);
      st.refImageId = await putImage(p.id, await toJpeg(f));
      await this.save(true);
      this.render();
    });
    const turbo = h('input', { type: 'checkbox', checked: st.turbo, 'data-testid': 'style-turbo' }) as HTMLInputElement;
    turbo.addEventListener('change', () => {
      st.turbo = turbo.checked;
      this.save();
    });
    return h(
      'section',
      { class: 'card' },
      h('h2', null, 'Style'),
      h('div', { class: 'chips' }, ...STYLES.map((s) => h('button', { type: 'button', class: `chip ${st.preset === s.id ? 'active' : ''}`, 'data-testid': `style-${s.id}`, on: { click: () => ((st.preset = s.id), this.save(), this.render()) } }, s.label))),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Précisions de style'), extra),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label' }, 'Image de référence de style (facultative)'),
        st.refImageId ? this.thumb(st.refImageId, 'style', () => void (async () => {
          await deleteImage(st.refImageId!).catch(() => undefined);
          st.refImageId = undefined;
          await this.save(true);
          this.render();
        })()) : null,
        file,
        h('small', { class: 'hint' }, 'Une case, une couverture ou une page d’un album dont tu veux le trait et les couleurs (pas le contenu).'),
      ),
      h('label', { class: 'check' }, turbo, ' Rapide (FLUX.2 Turbo, 8 étapes) — décoche pour la qualité finale (20 étapes)'),
      loraPicker('flux2dev', (st.loras ??= []), () => this.save(), () => this.render(), 'style-lora'),
      h('small', { class: 'hint' }, 'Une LoRA de style s’applique à toutes les images du projet (cases, planches de personnages, décors) : le trait reste le même partout.'),
    );
  }

  // ---------------------------------------------------------------- histoire

  private renderStory(p: Project): HTMLElement {
    const syn = h('textarea', { class: 'input', rows: 8, placeholder: 'Raconte ton histoire : situation, personnages, rebondissements, fin…', 'data-testid': 'synopsis' }) as HTMLTextAreaElement;
    syn.value = p.synopsis;
    syn.addEventListener('input', () => {
      p.synopsis = syn.value;
      this.save();
    });
    const pages = h('select', { class: 'input', 'data-testid': 'story-pages' }) as HTMLSelectElement;
    for (let n = 1; n <= 8; n++) pages.append(h('option', { value: n, selected: n === Math.max(1, Math.min(8, p.pages.length || 2)) }, `${n} page${n > 1 ? 's' : ''}`));
    const status = h('small', { class: 'hint' });
    this.statusEls.set('story', status);
    return h('div', { class: 'stack' }, this.renderExpress(p), h(
      'section',
      { class: 'card' },
      h('h2', null, 'Histoire (manuel)'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Synopsis'), syn),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Nombre de pages'), pages),
      h('button', { type: 'button', class: 'btn btn-primary btn-big', disabled: !!this.busy, 'data-testid': 'story-split', on: { click: () => void this.split(Number(pages.value)) } }, 'Découper avec l’IA (pages, cases, dialogues)'),
      status,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', 'data-testid': 'add-page', on: { click: () => void this.addPage() } }, '+ Ajouter une page vide'),
        p.pages.length || p.synopsis.trim()
          ? h('button', { type: 'button', class: 'btn btn-danger', 'data-testid': 'reset-story', on: { click: () => void this.resetStory() } }, 'Réinitialiser l’histoire et les pages')
          : null,
      ),
      p.pages.length ? h('p', { class: 'hint' }, `${p.pages.length} page(s), ${p.pages.reduce((n, pg) => n + pg.panels.length, 0)} case(s). Voir l’étape Pages.`) : null,
    ));
  }

  private split(pages: number) {
    const p = this.p!;
    if (!p.synopsis.trim()) return toast('Écris d’abord le synopsis', 'error');
    if (!this.ready('qwen')) return;
    return this.guard('découpage de l’histoire', async () => {
      if (p.pages.length && !(await confirmDialog({ title: 'Remplacer les pages existantes ?', body: ['Le découpage proposé par l’IA remplacera tes pages actuelles (les images des cases seront supprimées).'], ok: 'Remplacer', danger: true }))) return;
      let story;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const text = await this.runText('story', `Qwen 3.5 · découpage (essai ${attempt})`, storyPrompt(p, pages), null, 4096, 0.5);
        try {
          story = parseStory(text);
          break;
        } catch (e) {
          lastErr = e;
          journal.warn('bd', `Découpage illisible (essai ${attempt})`, text.slice(0, 3000));
        }
      }
      if (!story) throw new Error(`Réponse de l’IA illisible (${lastErr instanceof Error ? lastErr.message : lastErr}) : relance le découpage`);
      for (const pg of p.pages) for (const pa of pg.panels) if (pa.imageId) await deleteImage(pa.imageId).catch(() => undefined);
      p.pages = storyToPages(p, story);
      this.pageIdx = 0;
      await this.save(true);
      journal.info('bd', `Découpage : ${p.pages.length} page(s), ${p.pages.reduce((n, pg) => n + pg.panels.length, 0)} case(s)`);
      this.step = 'pages';
      toast('Découpage prêt : vérifie et modifie les cases', 'ok');
    });
  }

  private async resetStory() {
    const p = this.p!;
    if (!(await confirmDialog({
      title: 'Réinitialiser l’histoire et les pages ?',
      body: ['Le synopsis, le découpage et toutes les pages seront effacés. Les images des cases seront supprimées. Cette action est irréversible.'],
      ok: 'Tout effacer',
      danger: true,
    }))) return;
    for (const pg of p.pages) for (const pa of pg.panels) if (pa.imageId) await deleteImage(pa.imageId).catch(() => undefined);
    p.synopsis = '';
    p.outline = [];
    p.pages = [];
    this.pageIdx = 0;
    await this.save(true);
    toast('Histoire et pages réinitialisées', 'ok');
    this.render();
  }

  private async addPage() {
    const p = this.p!;
    p.pages.push({ id: uid('g'), layout: 'b3', panels: [newPanel(), newPanel(), newPanel()] });
    this.pageIdx = p.pages.length - 1;
    this.step = 'pages';
    await this.save(true);
    this.render();
  }

  // ---------------------------------------------------------------- pages

  private renderPages(p: Project): HTMLElement {
    if (!p.pages.length) return h('section', { class: 'card' }, h('p', null, 'Aucune page. Découpe l’histoire avec l’IA ou ajoute une page vide (étape Histoire).'));
    this.pageIdx = Math.min(this.pageIdx, p.pages.length - 1);
    const page = p.pages[this.pageIdx];
    const tabs = h('div', { class: 'chips' }, ...p.pages.map((_, i) => h('button', { type: 'button', class: `chip ${i === this.pageIdx ? 'active' : ''}`, 'data-testid': `page-tab-${i + 1}`, on: { click: () => ((this.pageIdx = i), this.render()) } }, `Page ${i + 1}`)));
    const layout = h('select', { class: 'input', 'data-testid': 'page-layout' }) as HTMLSelectElement;
    for (const l of LAYOUTS) layout.append(h('option', { value: l.id, selected: l.id === page.layout }, `${l.label} (${cellRects(l).length} cases)`));
    layout.addEventListener('change', () => {
      page.layout = layout.value;
      this.save();
      this.render();
    });
    const max = cellRects(getLayout(page.layout)).length;
    const preview = h('div', { class: 'page-preview', 'data-testid': 'page-preview' });
    void this.drawPreview(page, preview);
    const genAll = h('button', { type: 'button', class: 'btn btn-primary btn-big', disabled: !!this.busy, 'data-testid': 'gen-page', on: { click: () => void this.generatePage(page, false) } }, 'Générer les cases vides');
    const regenAll = h('button', { type: 'button', class: 'btn', disabled: !!this.busy, on: { click: () => void this.generatePage(page, true) } }, 'Régénérer toute la page');
    const empty = p.pages.reduce((n, pg) => n + pg.panels.slice(0, cellRects(getLayout(pg.layout)).length).filter((x) => !x.imageId).length, 0);
    const genBook = p.pages.length > 1 && empty
      ? h('button', { type: 'button', class: 'btn', disabled: !!this.busy, 'data-testid': 'gen-book', on: { click: () => void this.generateBook() } }, `Générer toutes les pages (${empty} case(s) vide(s))`)
      : null;
    return h(
      'section',
      { class: 'stack' },
      h(
        'div',
        { class: 'card' },
        tabs,
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Mise en page'), layout),
        page.panels.length > max ? h('p', { class: 'msg warn' }, `Ce gabarit n’affiche que ${max} case(s) sur ${page.panels.length}.`) : null,
        preview,
        h('button', { type: 'button', class: 'btn', 'data-testid': 'page-fullscreen', on: { click: () => this.fullscreen(p, this.pageIdx) } }, '⛶ Plein écran (zoom)'),
        h('small', { class: 'hint' }, 'Fais glisser les poignées ✥ pour déplacer les bulles ; touche la page pour la voir en plein écran.'),
        genAll,
        regenAll,
        genBook,
        h('div', { class: 'row-wrap' },
          h('button', { type: 'button', class: 'btn btn-small', on: { click: () => void this.addPage() } }, '+ Page'),
          h('button', { type: 'button', class: 'btn btn-small btn-danger', on: { click: () => void this.removePage(page) } }, 'Supprimer la page')),
      ),
      ...page.panels.map((pa, i) => this.panelCard(p, page, pa, i)),
      h('button', { type: 'button', class: 'btn', 'data-testid': 'add-panel', on: { click: () => ((page.panels.push(newPanel()), page.layout = layoutFor(page.panels.length).id, this.save(), this.render())) } }, '+ Ajouter une case'),
    );
  }

  private async images(page: Page): Promise<(ImageBitmap | null)[]> {
    return Promise.all(page.panels.map(async (pa) => {
      if (!pa.imageId) return null;
      const b = await getImage(pa.imageId).catch(() => null);
      return b ? createImageBitmap(b) : null;
    }));
  }

  /** Visionneuse plein écran : page en haute définition, zoom, pages suivantes au balayage. */
  private fullscreen(p: Project, start: number) {
    if (!p.pages.length) return;
    openViewer({
      count: p.pages.length,
      start,
      title: p.title,
      render: async (i) => {
        const imgs = await this.images(p.pages[i]);
        const { canvas } = await renderPage(p.pages[i], imgs, 1.5);
        for (const b of imgs) b?.close();
        return canvas;
      },
      download: (i) => void (async () => {
        const imgs = await this.images(p.pages[i]);
        const { canvas } = await renderPage(p.pages[i], imgs, 1, false);
        for (const b of imgs) b?.close();
        download(await canvasToBlob(canvas, 'image/png'), `${p.title}_page${i + 1}.png`);
      })(),
    });
  }

  private async drawPreview(page: Page, box: HTMLElement) {
    const { canvas, boxes } = await renderPage(page, await this.images(page), 0.5);
    canvas.className = 'page-canvas';
    canvas.addEventListener('click', () => this.p && this.fullscreen(this.p, Math.max(0, this.p.pages.indexOf(page))));
    replace(box, canvas, ...boxes.map((b) => this.handle(page, b, box)));
  }

  /** Poignée de déplacement d'une bulle (au doigt). */
  private handle(page: Page, b: BubbleBox, box: HTMLElement): HTMLElement {
    const el = h('div', { class: 'bubble-handle', title: 'Déplacer la bulle', 'data-testid': `handle-${b.bubble.id}` }, '✥');
    const place = (px: number, py: number) => {
      el.style.left = `${(px / PAGE_W) * 100}%`;
      el.style.top = `${(py / PAGE_H) * 100}%`;
    };
    // Poignée au coin supérieur gauche de la bulle (le texte reste lisible).
    place(b.x, b.y);
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const rect = box.getBoundingClientRect();
      const cell = cellRects(getLayout(page.layout))[b.panelIndex];
      const move = (ev: PointerEvent) => {
        const px = ((ev.clientX - rect.left) / rect.width) * PAGE_W;
        const py = ((ev.clientY - rect.top) / rect.height) * PAGE_H;
        place(px, py);
        b.bubble.x = Math.max(0, Math.min(1, (px + b.w / 2 - cell.x) / cell.w));
        b.bubble.y = Math.max(0, Math.min(1, (py + b.h / 2 - cell.y) / cell.h));
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        this.save();
        void this.drawPreview(page, box);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    return el;
  }

  private panelCard(p: Project, page: Page, pa: Panel, i: number): HTMLElement {
    const desc = h('textarea', { class: 'input', rows: 3, placeholder: 'Ce qu’on voit : action, décor, expressions, lumière…', 'data-testid': `panel-desc-${i + 1}` }) as HTMLTextAreaElement;
    desc.value = pa.description;
    desc.addEventListener('input', () => {
      pa.description = desc.value;
      this.save();
    });
    const shot = h('select', { class: 'input' }) as HTMLSelectElement;
    for (const [k, label] of SHOTS) shot.append(h('option', { value: k, selected: k === pa.shot }, label));
    shot.addEventListener('change', () => ((pa.shot = shot.value), this.save()));
    const setting = h('select', { class: 'input', 'data-testid': `panel-setting-${i + 1}` }, h('option', { value: '' }, '—')) as HTMLSelectElement;
    for (const st of p.settings) setting.append(h('option', { value: st.id, selected: st.id === pa.setting }, st.name));
    setting.addEventListener('change', () => ((pa.setting = setting.value || undefined), this.save()));
    const chars = h(
      'div',
      { class: 'stack', style: 'gap:6px' },
      ...p.characters.map((c) => {
        const on = pa.characters.includes(c.id);
        return h('div', { class: 'row', style: 'align-items:center; gap:8px' },
          h('span', { class: on ? 'chip active' : 'chip' }, c.name),
          on
            ? h('button', { type: 'button', class: 'btn btn-small btn-danger', 'aria-label': `Retirer ${c.name}`, on: { click: () => {
                pa.characters = pa.characters.filter((x) => x !== c.id);
                this.save();
                this.render();
              } } }, 'Retirer')
            : h('button', { type: 'button', class: 'btn btn-small', on: { click: () => {
                pa.characters = [...pa.characters, c.id];
                this.save();
                this.render();
              } } }, 'Ajouter'),
        );
      }),
    );
    const bubbleRow = (b: Bubble) => {
      const kind = h('select', { class: 'input' }) as HTMLSelectElement;
      for (const [k, l] of [['speech', 'Réplique'], ['thought', 'Pensée'], ['caption', 'Récitatif']]) kind.append(h('option', { value: k, selected: k === b.kind }, l));
      kind.addEventListener('change', () => ((b.kind = kind.value as Bubble['kind']), this.save(), this.render()));
      const txt = h('textarea', { class: 'input', rows: 2, placeholder: 'Texte (en français)' }) as HTMLTextAreaElement;
      txt.value = b.text;
      txt.addEventListener('input', () => ((b.text = txt.value), this.save()));
      txt.addEventListener('change', () => this.render());
      return h('div', { class: 'bubble-row' }, h('div', { class: 'row' }, kind, b.speaker ? h('span', { class: 'hint' }, b.speaker) : null, h('button', { type: 'button', class: 'btn btn-small', 'aria-label': 'Supprimer', on: { click: () => ((pa.bubbles = pa.bubbles.filter((x) => x !== b)), this.save(), this.render()) } }, '✕')), txt);
    };
    const queued = this.bg.some((b) => b.job.outputs.some((o) => o.id === pa.id));
    const status = h('small', { class: `hint ${pa.status === 'error' ? 'err' : ''}`, 'data-testid': `panel-status-${i + 1}` }, pa.status === 'error' ? pa.error ?? 'Erreur' : queued ? 'Dans la file de l’instance…' : pa.imageId ? `Image prête · seed ${pa.seed ?? '?'}` : 'Pas encore générée');
    this.statusEls.set(pa.id, status);
    const move = (d: number) => {
      const j = i + d;
      if (j < 0 || j >= page.panels.length) return;
      [page.panels[i], page.panels[j]] = [page.panels[j], page.panels[i]];
      this.save();
      this.render();
    };
    return h(
      'details',
      { class: 'card panel-card', open: !pa.imageId, 'data-testid': `panel-${i + 1}` },
      h('summary', null, h('span', { class: 'panel-title' }, `Case ${i + 1}`, pa.description ? h('small', { class: 'hint' }, ` · ${pa.description.slice(0, 70)}${pa.description.length > 70 ? '…' : ''}`) : null), pa.imageId ? this.thumb(pa.imageId, `case ${i + 1}`) : null),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Description'), desc),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Personnages présents'), p.characters.length ? chars : h('small', { class: 'hint' }, 'Ajoute des personnages à l’étape Personnages.')),
      p.settings.length ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Décor'), setting) : null,
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Cadrage'), shot),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Bulles'), ...pa.bubbles.map(bubbleRow),
        h('div', { class: 'row-wrap' },
          h('button', { type: 'button', class: 'btn btn-small', on: { click: () => ((pa.bubbles.push({ id: uid('b'), kind: 'speech', text: '', x: 0.5, y: 0.2 }), this.save(), this.render())) } }, '+ Réplique'),
          h('button', { type: 'button', class: 'btn btn-small', on: { click: () => ((pa.bubbles.push({ id: uid('b'), kind: 'caption', text: '', x: 0.3, y: 0.1 }), this.save(), this.render())) } }, '+ Récitatif'))),
      status,
      h('div', { class: 'row-wrap' },
        h('button', { type: 'button', class: 'btn btn-small btn-primary', disabled: !!this.busy, 'data-testid': `panel-gen-${i + 1}`, on: { click: () => void (this.ready('flux') && this.guard(`case ${i + 1}`, () => this.generatePanel(page, pa, true))) } }, pa.imageId ? 'Régénérer' : 'Générer'),
        h('button', { type: 'button', class: 'btn btn-small', 'aria-label': 'Monter', on: { click: () => move(-1) } }, '↑'),
        h('button', { type: 'button', class: 'btn btn-small', 'aria-label': 'Descendre', on: { click: () => move(1) } }, '↓'),
        h('button', { type: 'button', class: 'btn btn-small btn-danger', on: { click: () => void (async () => {
          if (pa.imageId) await deleteImage(pa.imageId).catch(() => undefined);
          page.panels = page.panels.filter((x) => x !== pa);
          await this.save(true);
          this.render();
        })() } }, 'Supprimer')),
    );
  }

  private async removePage(page: Page) {
    const p = this.p!;
    if (!(await confirmDialog({ title: 'Supprimer cette page ?', ok: 'Supprimer', danger: true }))) return;
    for (const pa of page.panels) if (pa.imageId) await deleteImage(pa.imageId).catch(() => undefined);
    p.pages = p.pages.filter((x) => x !== page);
    this.pageIdx = Math.max(0, this.pageIdx - 1);
    await this.save(true);
    this.render();
  }

  /** Génère une case : références des personnages présents (+ style), taille au format de la case. */
  private async generatePanel(page: Page, pa: Panel, newSeed: boolean) {
    const p = this.p!;
    const idx = page.panels.indexOf(pa);
    const rect = cellRects(getLayout(page.layout))[Math.min(idx, cellRects(getLayout(page.layout)).length - 1)];
    const plan = panelPrompt(p, pa);
    const refs: Blob[] = [];
    for (const id of plan.images) {
      const b = await getImage(id);
      if (b) refs.push(b);
    }
    const seed = newSeed || !pa.seed ? randomSeed() : pa.seed;
    pa.status = 'running';
    pa.error = undefined;
    try {
      const blob = await this.runImage(pa.id, `FLUX.2 · page ${p.pages.indexOf(page) + 1}, case ${idx + 1}`, refs, plan.prompt, generationSize(rect), seed, { projectId: p.id, pageId: page.id, panelId: pa.id, seed });
      await this.storePanel(p, pa, blob, seed);
    } catch (e) {
      pa.status = 'error';
      pa.error = e instanceof GenerationError ? e.readable.title : e instanceof Error ? e.message : String(e);
      await this.save(true);
      throw e;
    }
  }

  private async storePanel(p: Project, pa: Panel, blob: Blob, seed: number) {
    const old = pa.imageId;
    pa.imageId = await putImage(p.id, await toJpeg(blob));
    pa.seed = seed;
    pa.status = 'done';
    if (old) await deleteImage(old).catch(() => undefined);
    await this.save(true);
  }

  /** Une page = un seul travail dans la file de l'instance (toutes ses cases, références comprises). */
  private generatePage(page: Page, all: boolean) {
    const p = this.p!;
    if (!this.ready('flux')) return;
    return this.guard(all ? 'régénération de la page' : 'génération de la page', async () => {
      if (all) for (const pa of page.panels) pa.seed = undefined;
      p.seed ??= randomSeed();
      const jobs = planComic(p, { pageIds: [page.id], onlyEmpty: !all, loras: this.styleLoras() });
      if (!jobs.some((j) => j.id.startsWith('page-'))) return void toast('Toutes les cases ont déjà une image', 'info');
      await this.queueJobs(p, jobs);
    });
  }

  private generateBook() {
    const p = this.p!;
    if (!this.ready('flux')) return;
    return this.guard('génération de toutes les pages', async () => {
      p.seed ??= randomSeed();
      const jobs = planComic(p, { onlyEmpty: true, loras: this.styleLoras() });
      if (!jobs.length) return void toast('Toutes les cases ont déjà une image', 'info');
      await this.queueJobs(p, jobs);
    });
  }

  // ---------------------------------------------------------------- travaux dans la file de l'instance

  /**
   * Envoie des travaux d'images dans la file de ComfyUI, dans l'ordre, sans attendre leur fin : l'instance
   * les enchaîne (GPU sans temps mort), même si le téléphone dort. Les images arrivent au fil de l'eau.
   */
  private async queueJobs(p: Project, jobs: ImageJob[]) {
    const c = app.manager.comfy!;
    const flux = this.wf.flux!;
    const inst = app.manager.state.instance!;
    // Cases de ces travaux : on retire la marque d'erreur éventuelle.
    for (const j of jobs) for (const o of j.outputs) if (o.kind === 'panel') {
      const pa = p.pages.flatMap((g) => g.panels).find((x) => x.id === o.id);
      if (pa) {
        pa.status = 'running';
        pa.error = undefined;
      }
    }
    await this.save(true);
    for (const [i, job] of jobs.entries()) {
      const uploads: Blob[] = [];
      for (const id of job.uploads) {
        const b = await getImage(id);
        if (!b) throw new Error('Image de référence introuvable dans le téléphone');
        uploads.push(b);
      }
      const entry = { job, gen: null as unknown as Generation, status: 'Envoi…', projectId: p.id };
      let queued!: () => void;
      const onQueued = new Promise<void>((r) => (queued = r));
      entry.gen = new Generation({
        client: c,
        clientRef: () => app.manager.comfy,
        registry: app.registry!,
        model: { id: 'flux2-bd', label: `FLUX.2 · ${job.label}` },
        workflow: flux,
        params: DUMMY(0),
        uploads,
        prebuilt: (names, prefix) => job.build(flux, names, prefix),
        kind: 'image',
        multi: true,
        stallMinutes: app.settings.stallMinutes,
        instanceId: inst.id,
        meta: { comic: true, express: true, projectId: p.id, label: job.label, outputs: job.outputs },
        events: {
          onStatus: (t) => this.jobStatus(entry, t),
          onProgress: (pr) => this.jobStatus(entry, `${Math.round(pr.overall * 100)} % · ${pr.label}${pr.max ? ` (${pr.value}/${pr.max})` : ''}`),
          onQueued: () => queued(),
        },
      });
      this.track(p, entry);
      this.setStatus('story', `Envoi dans la file de l’instance : ${i + 1}/${jobs.length}…`);
      await Promise.race([onQueued, entry.gen.promise.catch(() => undefined)]);
    }
    journal.info('bd', `${jobs.length} travail(aux) dans la file de l’instance (${countImages(jobs)} image(s))`);
    toast(`${countImages(jobs)} image(s) en file sur l’instance : tu peux verrouiller le téléphone`, 'ok');
  }

  private jobStatus(entry: { status: string; job: ImageJob }, t: string) {
    entry.status = t;
    const el = this.statusEls.get(`job-${entry.job.id}`);
    if (el) el.textContent = `${entry.job.label} · ${t}`;
  }

  private setStatus(key: string, t: string) {
    const el = this.statusEls.get(key);
    if (el) el.textContent = t;
  }

  /** Suit un travail jusqu'à sa fin et range ses images (ou ce qui a pu être produit avant une erreur). */
  private track(p: Project, entry: { job: ImageJob; gen: Generation; status: string; projectId: string }) {
    this.bg.push(entry);
    holdAwake('bd-file');
    this.render();
    entry.gen.promise
      .then(async (r) => {
        await this.applyOutputs(p, entry.job.outputs, r.files ?? [], entry.gen.prefix);
        toast(`${entry.job.label.split(' :')[0]} prête`, 'ok');
      })
      .catch(async (e) => {
        const cancelled = e instanceof GenerationError && e.cancelled;
        const msg = e instanceof GenerationError ? e.readable.title : e instanceof Error ? e.message : String(e);
        // Images déjà produites avant l'erreur : récupérées quand même.
        const salvaged = await this.salvage(p, entry.job.outputs, entry.gen.prefix).catch(() => 0);
        for (const o of entry.job.outputs) if (o.kind === 'panel') {
          const pa = p.pages.flatMap((g) => g.panels).find((x) => x.id === o.id);
          if (pa && pa.status === 'running') {
            pa.status = cancelled ? 'empty' : 'error';
            pa.error = cancelled ? undefined : msg;
          }
        }
        await this.save(true);
        if (!cancelled) toast(`${entry.job.label} : ${msg}${salvaged ? ` (${salvaged} image(s) récupérée(s))` : ''}`, 'error');
      })
      .finally(() => {
        this.bg = this.bg.filter((x) => x !== entry);
        if (!this.bg.length) releaseAwake('bd-file');
        if (app.route === 'comic') this.render();
      });
  }

  private async salvage(p: Project, outputs: OutputTarget[], prefix: string): Promise<number> {
    const c = app.manager.comfy;
    if (!c || !prefix) return 0;
    const files = (await c.listOutputs(prefix)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f.filename));
    const got: { filename: string; blob: Blob }[] = [];
    for (const f of files) got.push({ filename: f.filename, blob: await c.view(f) });
    if (files.length) void c.deleteFiles(files).catch(() => undefined);
    return this.applyOutputs(p, outputs, got, prefix);
  }

  /** Range chaque image reçue à sa place : planche de personnage, image de décor ou case. */
  private async applyOutputs(p: Project, outputs: OutputTarget[], files: { filename: string; blob: Blob }[], prefix: string): Promise<number> {
    let n = 0;
    for (const f of files) {
      const key = outputKey(f.filename, prefix);
      const o = outputs.find((x) => x.key === key);
      if (!o) continue;
      const id = await putImage(p.id, await toJpeg(f.blob));
      n++;
      if (o.kind === 'char') {
        const ch = p.characters.find((x) => x.id === o.id);
        if (ch) ch.imageIds.unshift(id);
      } else if (o.kind === 'setting') {
        const st = p.settings.find((x) => x.id === o.id);
        if (st) st.imageIds.unshift(id);
      } else {
        const pa = p.pages.flatMap((g) => g.panels).find((x) => x.id === o.id);
        if (!pa) continue;
        const old = pa.imageId;
        pa.imageId = id;
        pa.seed = o.seed;
        pa.status = 'done';
        pa.error = undefined;
        if (old) await deleteImage(old).catch(() => undefined);
      }
    }
    await this.save(true);
    if (app.route === 'comic') this.render();
    return n;
  }

  private renderJobs(): HTMLElement {
    return h(
      'div',
      { class: 'msg info', 'data-testid': 'bd-jobs' },
      h('strong', null, `Sur l’instance : ${this.bg.length} travail(aux) dans la file`),
      ...this.bg.map((b) => {
        const el = h('div', { class: 'hint', 'data-testid': 'bd-job' }, `${b.job.label} · ${b.status}`);
        this.statusEls.set(`job-${b.job.id}`, el);
        return el;
      }),
      h('small', { class: 'hint' }, 'Le GPU enchaîne tout, même téléphone verrouillé ; les images arrivent ici au fil de l’eau.'),
      h('button', { type: 'button', class: 'btn btn-small btn-danger', 'data-testid': 'bd-cancel-all', on: { click: async () => {
        if (await confirmDialog({ title: 'Annuler tous les travaux en file ?', body: ['Les images déjà terminées sont gardées.'], ok: 'Tout annuler', danger: true })) for (const b of this.bg) void b.gen.cancel();
      } } }, 'Tout annuler'),
    );
  }

  /** Reprend les cases dont la génération a continué sur l'instance pendant la veille du téléphone. */
  private async resumePending() {
    if (this.resuming) return;
    this.resuming = true;
    try {
      if (!this.loaded) await this.open();
      const jobs = listPending().filter((j) => j.meta?.comic);
      if (!jobs.length || !app.manager.comfy || !app.manager.state.instance || !this.wf.flux) return;
      for (const job of jobs) await this.resumeJob(job);
    } finally {
      this.resuming = false;
      if (app.route === 'comic') this.render();
    }
  }

  private async resumeJob(job: PendingJob) {
    if (job.meta?.express) return this.resumeExpress(job);
    const m = job.meta as { projectId: string; pageId: string; panelId: string; seed: number };
    const p = this.projects.find((x) => x.id === m.projectId) ?? (await listProjects()).find((x) => x.id === m.projectId);
    const pa = p?.pages.find((g) => g.id === m.pageId)?.panels.find((x) => x.id === m.panelId);
    if (!p || !pa || job.instanceId !== app.manager.state.instance?.id) {
      removePending(job.promptId);
      return;
    }
    journal.info('bd', `Reprise de la case en cours (projet « ${p.title} »)`);
    const gen = new Generation({
      client: app.manager.comfy!,
      clientRef: () => app.manager.comfy,
      registry: app.registry!,
      model: { id: job.modelId, label: 'FLUX.2 · reprise' },
      workflow: this.wf.flux!,
      params: job.params,
      kind: 'image',
      stallMinutes: app.settings.stallMinutes,
      instanceId: job.instanceId,
      resume: job,
      events: this.events(pa.id),
    });
    try {
      const r = await gen.promise;
      await this.storePanel(p, pa, r.blob, m.seed);
      if (this.p?.id === p.id) this.p = p;
      toast('Case récupérée après la veille', 'ok');
    } catch (e) {
      journal.warn('bd', 'Reprise de la case impossible', e instanceof Error ? e.message : e);
    }
  }

  private async resumeExpress(job: PendingJob) {
    const m = job.meta as { projectId: string; label: string; outputs: OutputTarget[] };
    const p = this.projects.find((x) => x.id === m.projectId);
    if (!p || job.instanceId !== app.manager.state.instance?.id || this.bg.some((b) => b.gen.id === job.promptId)) {
      if (!p) removePending(job.promptId);
      return;
    }
    journal.info('bd', `Reprise du travail « ${m.label} » (projet « ${p.title} »)`);
    const pseudo: ImageJob = { id: `resume-${job.promptId}`, label: m.label, uploads: [], outputs: m.outputs, build: () => ({}) };
    const entry = { job: pseudo, gen: null as unknown as Generation, status: 'Reprise du suivi…', projectId: p.id };
    entry.gen = new Generation({
      client: app.manager.comfy!,
      clientRef: () => app.manager.comfy,
      registry: app.registry!,
      model: { id: job.modelId, label: `FLUX.2 · ${m.label}` },
      workflow: this.wf.flux!,
      params: job.params,
      kind: 'image',
      multi: true,
      stallMinutes: app.settings.stallMinutes,
      instanceId: job.instanceId,
      resume: job,
      events: { onStatus: (t) => this.jobStatus(entry, t) },
    });
    this.track(p, entry);
  }

  // ---------------------------------------------------------------- export

  private renderExport(p: Project): HTMLElement {
    const status = h('p', { class: 'hint', 'data-testid': 'export-status' });
    const run = (kind: 'pdf' | 'cbz' | 'png') => void this.guard('export', async () => {
      const jpegs: Uint8Array[] = [];
      for (const [i, page] of p.pages.entries()) {
        status.textContent = `Rendu de la page ${i + 1}/${p.pages.length}…`;
        const { canvas } = await renderPage(page, await this.images(page), 1, false);
        if (kind === 'png') {
          download(await canvasToBlob(canvas, 'image/png'), `${p.title}_page${i + 1}.png`);
          continue;
        }
        jpegs.push(new Uint8Array(await (await canvasToBlob(canvas, 'image/jpeg', 0.9)).arrayBuffer()));
      }
      if (kind === 'pdf') download(new Blob([buildPdf(jpegs, p.title)], { type: 'application/pdf' }), `${p.title}.pdf`);
      if (kind === 'cbz') download(new Blob([buildCbz(jpegs, p.title)], { type: 'application/vnd.comicbook+zip' }), `${p.title}.cbz`);
      status.textContent = 'Export terminé.';
      journal.info('bd', `Export ${kind.toUpperCase()} : ${p.pages.length} page(s)`);
    });
    const missing = p.pages.reduce((n, pg) => n + pg.panels.filter((pa) => !pa.imageId).length, 0);
    return h(
      'section',
      { class: 'card' },
      h('h2', null, 'Export'),
      missing ? h('p', { class: 'msg warn' }, `${missing} case(s) sans image : elles seront blanches.`) : null,
      h('button', { type: 'button', class: 'btn btn-primary btn-big', disabled: !p.pages.length || !!this.busy, 'data-testid': 'export-pdf', on: { click: () => run('pdf') } }, 'PDF (A4)'),
      h('button', { type: 'button', class: 'btn btn-big', disabled: !p.pages.length || !!this.busy, 'data-testid': 'export-cbz', on: { click: () => run('cbz') } }, 'CBZ (liseuses de BD)'),
      h('button', { type: 'button', class: 'btn', disabled: !p.pages.length || !!this.busy, 'data-testid': 'export-png', on: { click: () => run('png') } }, 'PNG (une image par page)'),
      h('button', { type: 'button', class: 'btn', disabled: !p.pages.length, 'data-testid': 'read-fullscreen', on: { click: () => this.fullscreen(p, 0) } }, '⛶ Lire la BD en plein écran'),
      status,
      h('small', { class: 'hint' }, 'Les fichiers sont fabriqués dans ton téléphone ; rien n’est envoyé ailleurs.'),
    );
  }
}