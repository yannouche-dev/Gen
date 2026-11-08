// Écran « Générer » : choix du modèle (grisé si absent du serveur), options supportées par le modèle,
// préréglages, lancement, progression en direct, annulation, résultat.
import { h, replace, toast, download, fmtDuration } from './dom.ts';
import { app, type Prefill } from './context.ts';
import { journal } from '../core/journal.ts';
import { loadPresets, savePresets, type GenPreset } from '../core/settings.ts';
import { computeSize, frameCount, randomSeed, readInput, supportedOptions, MAX_SEED, type ModelDef } from '../workflows/build.ts';
import { Generation, GenerationError, type GenEvents, type GenResult } from '../comfy/generate.ts';
import { listPending, removePending } from '../core/pending.ts';
import { holdAwake, releaseAwake } from '../core/wakelock.ts';
import { explainError } from '../comfy/errors.ts';
import { thumbnail, videoMeta, lastFrame } from '../media/frames.ts';
import type { GalleryItem } from '../media/gallery.ts';
import { confirmDialog } from './dialog.ts';
import { loraPicker } from './lora.ts';
import type { LoraChoice } from '../workflows/lora.ts';

interface FormState {
  modelId: string;
  prompt: string;
  negative: string | null;
  preset: string;
  ratio: string;
  duration: number;
  fps: number;
  seed: number;
  randomSeed: boolean;
  steps: number | null;
  cfg: number | null;
  enhancePrompt: boolean;
  fast: boolean;
  startImage: Blob | null;
  endImage: Blob | null;
  middleImage: Blob | null;
  /** Instant de l'image clé intermédiaire (secondes). */
  middleAt: number;
  /** Valeurs des options propres au modèle (son, fidélité à l'image, force des images clés…). */
  extras: Record<string, number | boolean>;
  /** Nombre de variantes à générer à la suite (seeds différentes). */
  variants: number;
  /** LoRA choisies (modèles qui en acceptent). */
  loras: LoraChoice[];
  parentId?: string;
}

const MAX_VARIANTS = 8;
/** Vidéos en attente ou en cours au plus (la file de ComfyUI n'a pas de limite, la mémoire du téléphone si). */
const MAX_QUEUE = 16;

interface FollowCtx {
  model: ModelDef;
  params: GalleryItem['params'];
  startImage: Blob | null;
  endImage: Blob | null;
  middleImage?: Blob | null;
  parentId?: string;
  startedAt: number;
  label?: string;
}

interface QItem {
  gen: Generation;
  ctx: FollowCtx;
  status: string;
  progress: number;
  step: string;
  previewUrl: string | null;
  finished: boolean;
  /** Calcul en cours sur le GPU (sinon en attente). */
  running: boolean;
  /** Position dans la file d'attente de ComfyUI (0 si inconnue ou en cours). */
  position: number;
}

export class GenerateScreen {
  el = h('div', { class: 'screen' });
  private form = h('form', { class: 'card', 'data-testid': 'gen-form' });
  private progressBox = h('section', { class: 'card hidden', 'data-testid': 'gen-progress' });
  private resultBox = h('section', { class: 'card hidden', 'data-testid': 'gen-result' });
  private notice = h('div');
  private st: FormState | null = null;
  private queue: QItem[] = [];
  private queueTimer: ReturnType<typeof setInterval> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private focusId: QItem | null = null;
  private focusEls: { status: HTMLElement; bar: HTMLProgressElement; step: HTMLElement; img: HTMLImageElement; timer: HTMLElement } | null = null;
  private submitBtn: HTMLButtonElement | null = null;
  private resuming = false;
  private assistantOpen = false;
  private imageUrls: string[] = [];

  constructor() {
    this.el.append(this.notice, this.form, this.progressBox, this.resultBox);
    app.on((w) => {
      if (w === 'registry' || w === 'availability' || (w === 'loras' && this.currentModel()?.lora)) this.renderForm();
      if (w === 'route' && app.route === 'generate') this.onShow();
    });
    app.manager.onChange((ms) => {
      this.renderNotice();
      if (ms.phase === 'ready' && app.manager.comfy && listPending().some((j) => !j.meta?.comic)) void this.resumePending();
    });
    this.renderNotice();
    this.renderForm();
  }

  private onShow() {
    if (app.prefill) {
      this.applyPrefill(app.prefill);
      app.prefill = null;
    }
    this.renderNotice();
    if (app.manager.state.phase === 'ready') void app.refreshAvailability().catch((e) => journal.warn('modèles', 'Lecture de /object_info impossible', e));
  }

  private renderNotice() {
    const ph = app.manager.state.phase;
    replace(
      this.notice,
      ph !== 'ready'
        ? h(
            'div',
            { class: 'card msg warn' },
            ph === 'booting' || ph === 'starting' ? 'L’instance démarre… tu peux préparer ta génération.' : 'Aucune instance prête. ',
            ph === 'booting' || ph === 'starting' ? null : h('button', { type: 'button', class: 'btn btn-small', on: { click: () => app.navigate('instance') } }, 'Démarrer'),
          )
        : null,
    );
  }

  private defaults(m: ModelDef): FormState {
    const wf = app.workflows.get(m.id)!;
    const neg = m.params.negative ? String(readInput(wf, m.params.negative.targets[0]) ?? '') : null;
    return {
      modelId: m.id,
      prompt: this.st?.prompt ?? '',
      negative: neg,
      preset: m.resolution.presets.includes(this.st?.preset ?? '') ? this.st!.preset : m.resolution.default,
      ratio: this.st?.ratio ?? '16:9',
      duration: Math.min(m.duration.max, Math.max(m.duration.min, this.st?.duration ?? m.duration.default)),
      fps: m.fps.options.includes(this.st?.fps ?? -1) ? this.st!.fps : m.fps.default,
      seed: this.st?.seed ?? randomSeed(),
      randomSeed: this.st?.randomSeed ?? true,
      steps: m.params.steps?.default ?? null,
      cfg: m.params.cfg?.default ?? null,
      enhancePrompt: m.params.enhancePrompt?.default ?? false,
      fast: m.params.fast?.default ?? false,
      startImage: m.params.startImage ? this.st?.startImage ?? null : null,
      endImage: m.params.endImage ? this.st?.endImage ?? null : null,
      middleImage: m.params.middleImage ? this.st?.middleImage ?? null : null,
      middleAt: this.st?.middleAt ?? Math.round((this.st?.duration ?? m.duration.default) / 2),
      // Valeurs par défaut du modèle, en gardant celles déjà choisies pour une option de même nom (ex. son).
      extras: Object.fromEntries((m.extras ?? []).map((x) => [x.key, this.st?.extras?.[x.key] ?? x.default])),
      variants: this.st?.variants ?? 1,
      // LoRA gardées si le nouveau modèle a la même base (ex. LTX t2v → i2v).
      loras: m.lora && this.st && app.model(this.st.modelId)?.lora?.base === m.lora.base ? this.st.loras.map((l) => ({ ...l })) : [],
    };
  }

  private applyPrefill(p: Prefill) {
    const m = app.model(p.modelId);
    if (!m) return;
    const base = this.defaults(m);
    this.st = {
      ...base,
      ...Object.fromEntries(Object.entries(p.params).filter(([, v]) => v !== undefined)),
      modelId: m.id,
      randomSeed: p.params.seed === undefined,
      startImage: p.startImage ?? base.startImage,
      endImage: p.endImage ?? base.endImage,
      extras: { ...base.extras, ...Object.fromEntries(Object.entries(p.params.extras ?? {}).filter(([k]) => k in base.extras)) },
      parentId: p.parentId,
    } as FormState;
    if (p.note) toast(p.note, 'info');
    this.renderForm();
  }

  private currentModel(): ModelDef | undefined {
    return this.st ? app.model(this.st.modelId) : undefined;
  }

  renderForm(): void {
    const reg = app.registry;
    if (!reg) {
      replace(this.form, h('p', null, 'Chargement des modèles…'));
      return;
    }
    if (!this.st || !app.model(this.st.modelId)) this.st = this.defaults(reg.models[0]);
    const st = this.st;
    const m = this.currentModel()!;
    const opts = supportedOptions(m);
    for (const u of this.imageUrls) URL.revokeObjectURL(u);
    this.imageUrls = [];

    // Sélecteur de modèle
    const select = h('select', { class: 'input', id: 'model', 'data-testid': 'model-select' }) as HTMLSelectElement;
    for (const [famId, fam] of Object.entries(reg.families)) {
      if (!reg.models.some((x) => x.family === famId)) continue; // familles sans modèle vidéo (Studio BD)
      const group = h('optgroup', { label: fam.label });
      for (const mm of reg.models.filter((x) => x.family === famId)) {
        const av = app.availability.get(mm.id);
        const known = app.availability.size > 0;
        const label = `${mm.label}${known && !av?.ok ? ' — absent du serveur' : ''}`;
        group.append(h('option', { value: mm.id, disabled: known && !av?.ok, selected: mm.id === m.id }, label));
      }
      select.append(group);
    }
    select.addEventListener('change', () => {
      const nm = app.model(select.value)!;
      this.st = { ...this.defaults(nm), parentId: undefined };
      this.renderForm();
    });
    const av = app.availability.get(m.id);
    const avMsg =
      av && !av.ok
        ? h('p', { class: 'msg warn' }, `Absent du serveur : ${[...av.missingNodes.map((n) => 'nœud ' + n), ...av.missingFiles].join(', ')}. Active la famille « ${reg.families[m.family]?.label} » dans les réglages de location.`)
        : null;

    // Prompt
    const prompt = h('textarea', { class: 'input', id: 'prompt', rows: 5, placeholder: 'Décris la scène, le mouvement, la caméra… (en anglais de préférence)', 'data-testid': 'prompt' }) as HTMLTextAreaElement;
    prompt.value = st.prompt;
    prompt.addEventListener('input', () => (st.prompt = prompt.value));
    let negBox: HTMLElement | null = null;
    if (opts.negative && st.negative !== null) {
      const neg = h('textarea', { class: 'input', id: 'negative', rows: 3 }) as HTMLTextAreaElement;
      neg.value = st.negative;
      neg.addEventListener('input', () => (st.negative = neg.value));
      negBox = h('details', null, h('summary', null, 'Prompt négatif'), neg);
    }

    // Images
    const imageField = (key: 'startImage' | 'endImage' | 'middleImage', label: string, required: boolean) => {
      const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'input', 'data-testid': key }) as HTMLInputElement;
      const preview = h('div', { class: 'img-preview' });
      const show = () => {
        const b = st[key];
        if (b) {
          const u = URL.createObjectURL(b);
          this.imageUrls.push(u);
          const clearBtn = h('button', { type: 'button', class: 'btn btn-small', on: { click: () => ((st[key] = null), show()) } }, 'Retirer');
          replace(preview, h('img', { src: u, alt: label }), clearBtn);
        } else replace(preview);
      };
      input.addEventListener('change', () => {
        const f = input.files?.[0];
        if (f) st[key] = f;
        show();
      });
      show();
      return h('label', { class: 'field' }, h('span', { class: 'field-label' }, `${label}${required ? ' *' : ''}`), input, preview);
    };

    // Résolution
    const size = computeSize(reg, m, st.preset, st.ratio);
    const presetSel = h('select', { class: 'input', id: 'preset', 'data-testid': 'preset' }) as HTMLSelectElement;
    for (const p of m.resolution.presets) presetSel.append(h('option', { value: p, selected: p === st.preset }, reg.resolutionPresets[p].label));
    presetSel.addEventListener('change', () => {
      st.preset = presetSel.value;
      this.renderForm();
    });
    const ratios = h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': 'Format' },
      ...Object.keys(reg.ratios).map((r) =>
        h('button', { type: 'button', class: `seg ${r === st.ratio ? 'active' : ''}`, 'aria-pressed': String(r === st.ratio), 'data-testid': `ratio-${r}`, on: { click: () => ((st.ratio = r), this.renderForm()) } }, r),
      ),
    );

    // Durée / FPS
    const dur = h('input', { type: 'range', min: m.duration.min, max: m.duration.max, step: 1, value: st.duration, id: 'duration', 'data-testid': 'duration' }) as HTMLInputElement;
    const durLabel = h('span', { class: 'value' });
    const frames = () => `${st.duration} s · ${frameCount(st.duration, st.fps)} images`;
    durLabel.textContent = frames();
    dur.addEventListener('input', () => {
      st.duration = Number(dur.value);
      durLabel.textContent = frames();
    });
    let fpsField: HTMLElement | null = null;
    if (opts.fps.length > 1) {
      const fps = h('select', { class: 'input', id: 'fps' }) as HTMLSelectElement;
      for (const f of opts.fps) fps.append(h('option', { value: f, selected: f === st.fps }, `${f} i/s`));
      fps.addEventListener('change', () => {
        st.fps = Number(fps.value);
        durLabel.textContent = frames();
      });
      fpsField = h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Images par seconde'), fps);
    }

    // Avancé : steps, CFG, seed, options booléennes
    const adv: HTMLElement[] = [];
    const numberField = (key: 'steps' | 'cfg', label: string, p: NonNullable<typeof opts.steps>) => {
      const input = h('input', { type: 'number', class: 'input', min: p.min, max: p.max, step: p.step ?? 1, value: String(st[key] ?? p.default), id: key, inputmode: 'decimal' }) as HTMLInputElement;
      input.addEventListener('change', () => (st[key] = Number(input.value)));
      return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input);
    };
    const boolField = (key: 'enhancePrompt' | 'fast', p: NonNullable<typeof opts.fast>) => {
      const c = h('input', { type: 'checkbox', checked: st[key], id: key }) as HTMLInputElement;
      c.addEventListener('change', () => {
        st[key] = c.checked;
        if (p.hides) this.renderForm();
      });
      return h('label', { class: 'check' }, c, ` ${p.label}`);
    };
    if (opts.fast) adv.push(boolField('fast', opts.fast));

    if (opts.steps && !st.fast) adv.push(numberField('steps', 'Étapes (steps)', opts.steps));
    if (opts.cfg && !st.fast) adv.push(numberField('cfg', 'CFG', opts.cfg));
    const seed = h('input', { type: 'number', class: 'input', min: 0, max: MAX_SEED, value: String(st.seed), id: 'seed', disabled: st.randomSeed, inputmode: 'numeric', 'data-testid': 'seed' }) as HTMLInputElement;
    seed.addEventListener('change', () => (st.seed = Number(seed.value)));
    const rnd = h('input', { type: 'checkbox', checked: st.randomSeed, id: 'random-seed' }) as HTMLInputElement;
    rnd.addEventListener('change', () => {
      st.randomSeed = rnd.checked;
      seed.disabled = rnd.checked;
    });
    adv.push(h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Seed'), h('div', { class: 'row' }, seed, h('label', { class: 'check' }, rnd, ' aléatoire'))));

    // Préréglages
    const presets = loadPresets().filter((p) => p.modelId === m.id);
    const presetPick = h('select', { class: 'input', 'aria-label': 'Préréglage' }) as HTMLSelectElement;
    presetPick.append(h('option', { value: '' }, presets.length ? '— Préréglages —' : 'Aucun préréglage'));
    for (const p of presets) presetPick.append(h('option', { value: p.name }, p.name));
    presetPick.addEventListener('change', () => {
      const p = presets.find((x) => x.name === presetPick.value);
      if (p) {
        this.st = { ...st, ...(p.values as Partial<FormState>), modelId: m.id, startImage: st.startImage, endImage: st.endImage };
        this.st.loras = m.lora ? ((p.values.loras as LoraChoice[] | undefined) ?? []).map((l) => ({ ...l })) : [];
        this.renderForm();
      }
    });
    const savePreset = h('button', { type: 'button', class: 'btn btn-small' }, 'Enregistrer');
    savePreset.addEventListener('click', () => {
      const name = window.prompt('Nom du préréglage', `${m.label.split('·')[0].trim()} ${st.preset} ${st.ratio}`)?.trim();
      if (!name) return;
      const values: Record<string, unknown> = { prompt: st.prompt, negative: st.negative, preset: st.preset, ratio: st.ratio, duration: st.duration, fps: st.fps, steps: st.steps, cfg: st.cfg, enhancePrompt: st.enhancePrompt, fast: st.fast, seed: st.seed, randomSeed: st.randomSeed, extras: { ...st.extras }, middleAt: st.middleAt, variants: st.variants, loras: st.loras.map((l) => ({ ...l })) };
      const all = loadPresets().filter((p) => !(p.modelId === m.id && p.name === name));
      all.push({ name, modelId: m.id, values } as GenPreset);
      savePresets(all);
      toast('Préréglage enregistré', 'ok');
      this.renderForm();
    });
    const delPreset = h('button', { type: 'button', class: 'btn btn-small', disabled: !presets.length }, 'Supprimer');
    delPreset.addEventListener('click', () => {
      if (!presetPick.value) return;
      savePresets(loadPresets().filter((p) => !(p.modelId === m.id && p.name === presetPick.value)));
      this.renderForm();
    });

    const queued = this.queue.filter((q) => !q.finished).length;
    const ready = app.manager.state.phase === 'ready' && !!app.manager.comfy;
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-big', disabled: !ready || (av && !av.ok), 'data-testid': 'generate' }, queued ? `Ajouter à la file (${queued} en cours)` : 'Générer') as HTMLButtonElement;
    this.submitBtn = submit;

    // Capacités du modèle choisi, d'après models.json
    const caps: string[] = [`${m.duration.min}–${m.duration.max} s`, m.fps.options.length > 1 ? `${m.fps.options[0]}–${m.fps.options.at(-1)} i/s` : `${m.fps.options[0]} i/s`, m.resolution.presets.join(' · ')];
    if (m.audio) caps.push('son généré');
    if (opts.enhancePrompt) caps.push('amélioration du prompt');
    if (opts.startImage) caps.push('image de début');
    if (opts.middleImage) caps.push('image clé intermédiaire');
    if (opts.endImage) caps.push('image de fin');
    if (opts.steps) caps.push('steps / CFG');
    const capsBox = h('div', { class: 'chips caps', 'data-testid': 'model-caps' }, ...caps.map((c) => h('span', { class: 'chip static' }, c)));

    // Assistant de prompt : fragments en anglais (les modèles comprennent mieux l'anglais), ajoutés au prompt.
    const addToPrompt = (frag: string) => {
      const cur = prompt.value.trim().replace(/[.,;]$/, '');
      prompt.value = cur ? `${cur}. ${frag}` : frag.charAt(0).toUpperCase() + frag.slice(1);
      st.prompt = prompt.value;
    };
    const group = (title: string, items: [string, string][]) =>
      h('div', { class: 'chip-group' }, h('span', { class: 'chip-title' }, title), h('div', { class: 'chips' }, ...items.map(([lab, frag]) => h('button', { type: 'button', class: 'chip', 'data-testid': `chip-${lab}`, on: { click: () => addToPrompt(frag) } }, lab))));
    const assistant = h(
      'details',
      { class: 'assistant', 'data-testid': 'prompt-assistant', open: this.assistantOpen, on: { toggle: (e: Event) => (this.assistantOpen = (e.target as HTMLDetailsElement).open) } },
      h('summary', null, 'Assistant de prompt'),
      h('p', { class: 'hint' }, m.family === 'ltx25'
        ? 'LTX-2.5 suit mieux un paragraphe précis : action principale, gestes, apparence, décor, mouvement de caméra, lumière, puis le son (bruits, musique, dialogues entre guillemets).'
        : 'Décris l’action, le sujet, le décor, la caméra et la lumière, en anglais de préférence.'),
      group('Caméra', [['Plan fixe', 'static camera'], ['Travelling avant', 'slow dolly-in towards the subject'], ['Travelling arrière', 'slow dolly-out revealing the scene'], ['Panoramique', 'smooth pan from left to right'], ['Orbite', 'the camera slowly orbits around the subject'], ['À l’épaule', 'handheld camera with subtle shake'], ['Drone', 'aerial drone shot gliding forward']]),
      group('Cadrage', [['Gros plan', 'close-up shot'], ['Plan moyen', 'medium shot'], ['Plan large', 'wide establishing shot'], ['Contre-plongée', 'low-angle shot']]),
      group('Lumière & style', [['Cinéma', 'cinematic lighting, shallow depth of field, film grain'], ['Heure dorée', 'warm golden hour sunlight'], ['Nuit néon', 'neon-lit night, reflections on wet ground'], ['Studio', 'soft studio lighting, clean background'], ['Ralenti', 'slow motion'], ['Documentaire', 'natural documentary style']]),
      m.audio ? group('Son (LTX)', [['Ambiance', 'ambient sound: gentle wind and distant birds'], ['Musique', 'soft cinematic music in the background'], ['Dialogue', 'the character says: "…"'], ['Bruitages', 'realistic footsteps and cloth rustle']]) : null,
    );

    // Options propres au modèle (déclarées dans models.json : son, fidélité, force des images clés…)
    const extraFields = (opts.extras ?? [])
      .filter((x) => !x.dependsOn || (x.dependsOn === 'enhancePrompt' ? st.enhancePrompt : !!st.extras[x.dependsOn]))
      .map((x) => {
        if (x.type === 'bool') {
          const c = h('input', { type: 'checkbox', checked: !!st.extras[x.key], id: `x-${x.key}`, 'data-testid': `extra-${x.key}` }) as HTMLInputElement;
          c.addEventListener('change', () => (st.extras[x.key] = c.checked));
          return h('div', { class: 'field' }, h('label', { class: 'check' }, c, ` ${x.label}`), x.help ? h('small', { class: 'hint' }, x.help) : null);
        }
        const val = h('span', { class: 'value' }, String(st.extras[x.key]));
        const r = h('input', { type: 'range', min: x.min, max: x.max, step: x.step ?? 0.05, value: String(st.extras[x.key]), id: `x-${x.key}`, 'data-testid': `extra-${x.key}` }) as HTMLInputElement;
        r.addEventListener('input', () => {
          st.extras[x.key] = Number(r.value);
          val.textContent = r.value;
        });
        return h('label', { class: 'field' }, h('span', { class: 'field-label' }, `${x.label} : `), val, r, x.help ? h('small', { class: 'hint' }, x.help) : null);
      });
    // L'option « créativité » dépend de la case « Améliorer le prompt » : on redessine quand elle change.
    const enhanceBox = opts.enhancePrompt
      ? (() => {
          const c = h('input', { type: 'checkbox', checked: st.enhancePrompt, id: 'enhancePrompt', 'data-testid': 'enhancePrompt' }) as HTMLInputElement;
          c.addEventListener('change', () => {
            st.enhancePrompt = c.checked;
            this.renderForm();
          });
          return h('div', { class: 'field' }, h('label', { class: 'check' }, c, ` ${opts.enhancePrompt!.label}`), h('small', { class: 'hint' }, 'Gemma réécrit et enrichit ton prompt avant la génération ; le prompt utilisé s’affiche avec le résultat.'));
        })()
      : null;
    const loraBox = m.lora ? loraPicker(m.lora.base, st.loras, () => undefined, () => this.renderForm()) : null;
    const modelOptions =
      extraFields.length || enhanceBox || loraBox
        ? h('section', { class: 'model-options', 'data-testid': 'model-options' }, h('h3', null, `Options ${reg.families[m.family]?.label ?? ''}`), enhanceBox, ...extraFields, loraBox)
        : null;

    // Image clé intermédiaire (LTX : images clés à n'importe quel instant)
    let middleBox: HTMLElement | null = null;
    if (opts.middleImage) {
      const at = h('input', { type: 'range', min: 1, max: Math.max(1, st.duration - 1), step: 0.5, value: String(Math.min(st.middleAt, Math.max(1, st.duration - 1))), 'data-testid': 'middleAt' }) as HTMLInputElement;
      const atVal = h('span', { class: 'value' }, `${at.value} s`);
      at.addEventListener('input', () => {
        st.middleAt = Number(at.value);
        atVal.textContent = `${at.value} s`;
      });
      middleBox = h('div', null, imageField('middleImage', 'Image clé intermédiaire (facultative)', false), h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Instant de l’image intermédiaire : '), atVal, at));
    }

    // Variantes : plusieurs générations à la suite avec des seeds différentes
    const variants = h('select', { class: 'input', id: 'variants', 'data-testid': 'variants' }) as HTMLSelectElement;
    for (const n of [1, 2, 3, 4, 6, 8]) variants.append(h('option', { value: n, selected: n === st.variants }, n === 1 ? '1 vidéo' : `${n} variantes (seeds différentes)`));
    variants.addEventListener('change', () => (st.variants = Number(variants.value)));

    replace(
      this.form,
      h('h1', null, 'Générer'),
      st.parentId ? h('p', { class: 'msg info' }, `Prolongation de ${st.parentId} : la dernière image sert d’image de début.`) : null,
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Modèle'), select),
      capsBox,
      avMsg,
      h('div', { class: 'row' }, presetPick, savePreset, delPreset),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Prompt *'), prompt),
      assistant,
      negBox,
      opts.startImage ? imageField('startImage', 'Image de début', !!m.params.startImage?.required) : null,
      middleBox,
      opts.endImage ? imageField('endImage', 'Image de fin', !!m.params.endImage?.required) : null,
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Résolution'), h('div', { class: 'row' }, presetSel, ratios), h('small', { class: 'hint', 'data-testid': 'size' }, `${size.width} × ${size.height}`)),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Durée '), durLabel, dur),
      fpsField,
      modelOptions,
      h('details', { class: 'advanced', open: false }, h('summary', null, 'Options avancées'), ...adv),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Nombre de vidéos'), variants, h('small', { class: 'hint' }, 'Toutes partent dans la file de l’instance : le GPU les enchaîne sans pause, même téléphone verrouillé. Tu peux en ajouter pendant que ça tourne.')),
      submit,
    );
    this.form.onsubmit = (e) => {
      e.preventDefault();
      void this.start();
    };
  }

  private async start() {
    const st = this.st;
    const m = this.currentModel();
    const c = app.manager.comfy;
    const inst = app.manager.state.instance;
    if (!st || !m || !c || !app.registry || !inst) return;
    if (!st.prompt.trim()) return toast('Écris un prompt', 'error');
    if (m.params.startImage?.required && !st.startImage) return toast('Ajoute une image de début', 'error');
    if (m.params.endImage?.required && !st.endImage) return toast('Ajoute une image de fin', 'error');
    const total = Math.max(1, Math.min(MAX_VARIANTS, st.variants));
    const active = this.queue.filter((q) => !q.finished).length;
    if (active + total > MAX_QUEUE) return toast(`File pleine (${MAX_QUEUE} vidéos au plus) : attends la fin de quelques vidéos`, 'error');
    const parentId = st.parentId;
    st.parentId = undefined;
    const baseSeed = st.seed;
    // LoRA supprimées de l'instance depuis leur choix : ignorées (sinon ComfyUI refuserait la requête).
    const installed = new Set(app.loras.list.map((l) => l.name));
    const loras = m.lora ? st.loras.filter((l) => installed.has(l.name)) : [];
    if (m.lora && loras.length < st.loras.length) toast('LoRA absente(s) de l’instance ignorée(s)', 'info');
    const short = st.prompt.trim().slice(0, 40) + (st.prompt.trim().length > 40 ? '…' : '');
    // Toutes les vidéos partent tout de suite dans la file de ComfyUI : le GPU les enchaîne sans temps mort,
    // même si le téléphone se met en veille.
    for (let i = 0; i < total; i++) {
      // Variantes : nouvelle seed aléatoire, ou seed fixe + i pour des variantes reproductibles.
      const seed = st.randomSeed ? randomSeed() : baseSeed + i;
      if (st.randomSeed) st.seed = seed;
      const params = {
        prompt: st.prompt,
        negative: st.negative ?? undefined,
        preset: st.preset,
        ratio: st.ratio,
        duration: st.duration,
        fps: st.fps,
        seed,
        steps: st.steps ?? undefined,
        cfg: st.cfg ?? undefined,
        enhancePrompt: st.enhancePrompt,
        fast: st.fast,
        extras: { ...st.extras },
        middleAt: st.middleImage ? st.middleAt : undefined,
        loras: loras.length ? loras.map((l) => ({ ...l })) : undefined,
      };
      const pid = i === 0 ? parentId : undefined;
      this.enqueue(
        (events) =>
          new Generation({
            client: c,
            registry: app.registry!,
            model: m,
            workflow: app.workflows.get(m.id)!,
            params,
            startImage: st.startImage,
            endImage: st.endImage,
            middleImage: st.middleImage,
            stallMinutes: app.settings.stallMinutes,
            instanceId: inst.id,
            parentId: pid,
            events,
          }),
        { model: m, params, startImage: st.startImage, endImage: st.endImage, middleImage: st.middleImage, parentId: pid, startedAt: Date.now(), label: `${total > 1 ? `Variante ${i + 1}/${total} · ` : ''}${m.label} · « ${short} » · seed ${seed}` },
      );
    }
    if (active > 0) toast(total > 1 ? `${total} vidéos ajoutées à la file` : 'Vidéo ajoutée à la file', 'info');
  }

  /** Reprend les générations lancées avant une mise en veille ou une fermeture de l'onglet. */
  async resumePending(): Promise<void> {
    const c = app.manager.comfy;
    const inst = app.manager.state.instance;
    const jobs = listPending().filter((j) => !j.meta?.comic && !this.queue.some((q) => q.gen.id === j.promptId));
    if (!jobs.length) return;
    if (!c || !inst || !app.registry || this.resuming) return;
    this.resuming = true;
    try {
      let n = 0;
      for (const job of jobs) {
        const m = app.model(job.modelId);
        const known = app.manager.state.all.some((i) => i.id === job.instanceId) || inst.id === job.instanceId;
        if (!m || !known) {
          journal.warn('génération', `Génération ${job.promptId} abandonnée : instance #${job.instanceId} introuvable`);
          removePending(job.promptId);
          continue;
        }
        if (job.instanceId !== inst.id) continue;
        n++;
        this.enqueue((events) => new Generation({
          client: c,
          registry: app.registry!,
          model: m,
          workflow: app.workflows.get(m.id)!,
          params: job.params,
          stallMinutes: app.settings.stallMinutes,
          instanceId: job.instanceId,
          parentId: job.parentId,
          resume: job,
          events,
        }), { model: m, params: job.params, startImage: null, endImage: null, parentId: job.parentId, startedAt: job.startedAt, label: `${m.label} · « ${job.params.prompt.slice(0, 40)} » · seed ${job.params.seed} (reprise)` });
      }
      if (n) toast(n > 1 ? `Reprise de ${n} générations en cours…` : 'Reprise d’une génération en cours…', 'info');
    } finally {
      this.resuming = false;
    }
  }

  /** Ajoute une génération (nouvelle ou reprise) à la file affichée ; le résultat ira dans la galerie. */
  private enqueue(make: (events: GenEvents) => Generation, ctx: FollowCtx): void {
    const item = { ctx, status: 'Préparation…', progress: 0, step: '', previewUrl: null, finished: false, running: false, position: 0 } as unknown as QItem;
    const events: GenEvents = {
      onStatus: (t) => {
        item.status = t;
        if (/en cours/i.test(t) && !/file/i.test(t)) item.running = true;
        this.updateQueue(item);
      },
      onProgress: (pr) => {
        item.running = true;
        item.progress = pr.overall;
        item.step = `${Math.round(pr.overall * 100)} % · ${pr.label}${pr.max ? ` (${pr.value}/${pr.max})` : ''}`;
        this.updateQueue(item);
      },
      onPreview: (b) => {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        item.previewUrl = URL.createObjectURL(b);
        this.updateQueue(item);
      },
    };
    item.gen = make(events);
    if (!this.active().length) this.resultBox.classList.add('hidden');
    this.queue.push(item);
    holdAwake('génération');
    this.startQueuePoll();
    this.renderQueue();
    item.gen.promise.then(
      (r) => void this.onDone(item, r),
      (e) => this.onFail(item, e),
    );
  }

  private active(): QItem[] {
    return this.queue.filter((q) => !q.finished);
  }

  /** Élément suivi en détail : celui qui tourne sur le GPU, sinon le premier de la file. */
  private focus(): QItem | undefined {
    const a = this.active();
    return a.find((q) => q.running) ?? a[0];
  }

  /** Positions dans la file de ComfyUI (interrogée toutes les 5 s tant que la file n'est pas vide). */
  private startQueuePoll() {
    if (this.queueTimer) return;
    const poll = async () => {
      const c = app.manager.comfy;
      if (!this.active().length) {
        clearInterval(this.queueTimer!);
        this.queueTimer = null;
        return;
      }
      if (!c || document.visibilityState !== 'visible') return;
      try {
        const q = await c.queue();
        const running = new Set(q.queue_running.map((e) => String(e[1])));
        const pending = [...q.queue_pending].sort((x, y) => Number(x[0]) - Number(y[0])).map((e) => String(e[1]));
        let changed = false;
        for (const it of this.active()) {
          const id = it.gen.id;
          if (!id) continue;
          const run = running.has(id);
          const pos = pending.indexOf(id) + 1;
          if (run !== it.running || pos !== it.position) changed = true;
          it.running = run || (it.running && pos === 0);
          it.position = pos;
        }
        if (changed) this.renderQueue();
      } catch {
        /* le suivi de chaque génération gère les coupures */
      }
    };
    this.queueTimer = setInterval(() => void poll(), 5000);
  }

  private async onDone(item: QItem, r: GenResult) {
    const { ctx } = item;
    const m = ctx.model;
    try {
      const meta = await videoMeta(r.blob).catch(() => ({ duration: ctx.params.duration, width: 0, height: 0 }));
      const thumb = await thumbnail(r.blob);
      const size = computeSize(app.registry!, m, ctx.params.preset, ctx.params.ratio);
      const g = app.gallery.add({
        kind: 'generated',
        modelId: m.id,
        modelLabel: m.label,
        params: ctx.params,
        seed: r.seed,
        blob: r.blob,
        thumb,
        thumbUrl: null,
        width: meta.width || size.width,
        height: meta.height || size.height,
        duration: meta.duration || ctx.params.duration,
        hasAudio: m.audio && ctx.params.extras?.audio !== false,
        elapsedMs: r.elapsedMs,
        startImage: ctx.startImage,
        endImage: ctx.endImage,
        middleImage: ctx.middleImage,
        parentId: ctx.parentId,
        enhancedPrompt: r.enhancedPrompt,
      });
      this.finish(item);
      this.showResult(g);
      const left = this.active().length;
      toast(left ? `Vidéo prête · ${left} encore dans la file` : 'Vidéo prête', 'ok');
    } catch (e) {
      this.onFail(item, e);
    }
  }

  private onFail(item: QItem, e: unknown) {
    if (item.finished) return;
    const r = e instanceof GenerationError ? e.readable : explainError(e);
    const cancelled = e instanceof GenerationError && e.cancelled;
    this.finish(item);
    if (this.active().length) {
      toast(`${cancelled ? 'Annulée' : 'Échec'} : ${r.title}`, cancelled ? 'info' : 'error');
      return;
    }
    replace(
      this.progressBox,
      h('h2', null, cancelled ? 'Génération annulée' : 'Échec de la génération'),
      h('p', { class: `msg ${cancelled ? 'warn' : 'err'}`, 'data-testid': 'gen-error' }, r.title),
      r.hint ? h('p', null, r.hint) : null,
      r.detail ? h('pre', { class: 'detail' }, r.detail) : null,
      h('button', { type: 'button', class: 'btn', on: { click: () => app.navigate('journal') } }, 'Voir le Journal'),
    );
    this.progressBox.classList.remove('hidden');
  }

  private finish(item: QItem) {
    item.finished = true;
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    item.previewUrl = null;
    this.queue = this.queue.filter((q) => q !== item);
    if (!this.active().length) {
      releaseAwake('génération');
      if (this.tick) clearInterval(this.tick);
      this.tick = null;
      this.progressBox.classList.add('hidden');
    }
    this.renderQueue();
  }

  /** Mise à jour légère (progression) : seulement les éléments affichés de cette génération. */
  private updateQueue(item: QItem) {
    if (this.focus() !== item || this.focusId !== item) return this.renderQueue();
    const f = this.focusEls;
    if (!f) return;
    f.status.textContent = item.status;
    f.bar.value = item.progress;
    f.step.textContent = item.step;
    if (item.previewUrl) {
      f.img.src = item.previewUrl;
      f.img.classList.remove('hidden');
    }
  }

  private renderQueue() {
    this.updateSubmit();
    const items = this.active();
    const fo = this.focus();
    this.focusId = fo ?? null;
    if (!fo) {
      this.focusEls = null;
      return;
    }
    const status = h('p', { class: 'gen-status', 'data-testid': 'gen-status' }, fo.status);
    const bar = h('progress', { max: 1, value: fo.progress, 'data-testid': 'gen-bar' }) as HTMLProgressElement;
    const step = h('p', { class: 'hint' }, fo.step);
    const img = h('img', { class: `gen-preview ${fo.previewUrl ? '' : 'hidden'}`, alt: 'Aperçu', src: fo.previewUrl ?? undefined }) as HTMLImageElement;
    const timer = h('span', { class: 'hint' }, `Écoulé : ${fmtDuration(Date.now() - fo.ctx.startedAt)}`);
    this.focusEls = { status, bar, step, img, timer };
    if (this.tick) clearInterval(this.tick);
    this.tick = setInterval(() => {
      const cur = this.focusId;
      if (cur && this.focusEls) this.focusEls.timer.textContent = `Écoulé : ${fmtDuration(Date.now() - cur.ctx.startedAt)}`;
    }, 1000);
    const cancel = h('button', { type: 'button', class: 'btn btn-danger btn-big', 'data-testid': 'cancel' }, 'Annuler');
    cancel.addEventListener('click', async () => {
      if (await confirmDialog({ title: 'Annuler la génération ?', ok: 'Annuler la génération', cancel: 'Continuer', danger: true })) void fo.gen.cancel();
    });
    const others = items.filter((q) => q !== fo);
    const list = others.length
      ? h(
          'div',
          { class: 'queue', 'data-testid': 'gen-queue' },
          h('h3', null, `File d’attente sur l’instance · ${others.length} autre(s)`),
          ...others.map((q) =>
            h(
              'div',
              { class: 'queue-item', 'data-testid': 'queue-item' },
              h('span', { class: 'queue-pos' }, q.running ? '▶' : q.position ? `#${q.position}` : '…'),
              h('span', { class: 'queue-label' }, q.ctx.label ?? q.ctx.model.label),
              h('button', { type: 'button', class: 'btn btn-small', 'aria-label': 'Retirer de la file', 'data-testid': 'queue-cancel', on: { click: () => void q.gen.cancel() } }, '✕'),
            ),
          ),
          others.length > 1
            ? h('button', { type: 'button', class: 'btn btn-small btn-danger', on: { click: async () => {
                if (await confirmDialog({ title: `Vider la file (${others.length}) ?`, body: ['La génération en cours continue.'], ok: 'Vider la file', danger: true })) for (const q of others) void q.gen.cancel();
              } } }, 'Vider la file')
            : null,
        )
      : null;
    replace(
      this.progressBox,
      h('h2', null, fo.ctx.label ? `Génération · ${fo.ctx.label}` : 'Génération'),
      status,
      bar,
      step,
      timer,
      img,
      h('p', { class: 'hint' }, 'Les vidéos tournent sur l’instance, à la suite et sans pause : tu peux verrouiller le téléphone ou ajouter d’autres vidéos à la file.'),
      cancel,
      list,
    );
    this.progressBox.classList.remove('hidden');
  }

  private updateSubmit() {
    const b = this.submitBtn;
    if (!b) return;
    const n = this.active().length;
    b.textContent = n ? `Ajouter à la file (${n} en cours)` : 'Générer';
  }

  showResult(item: GalleryItem): void {
    const video = h('video', { src: item.url, poster: item.thumbUrl ?? undefined, controls: true, playsinline: true, loop: true, preload: 'metadata', class: 'video', 'data-testid': 'result-video' });
    replace(
      this.resultBox,
      h('h2', null, 'Résultat'),
      video,
      h('p', { class: 'hint' }, `${item.modelLabel} · ${item.width}×${item.height} · ${item.duration.toFixed(1)} s · seed ${item.seed}${item.hasAudio ? ' · avec son' : ''} · ${fmtDuration(item.elapsedMs)}`),
      item.enhancedPrompt && item.params.enhancePrompt
        ? h('details', { class: 'enhanced', 'data-testid': 'enhanced-prompt' }, h('summary', null, 'Prompt utilisé par le modèle (amélioré)'), h('p', null, item.enhancedPrompt))
        : null,
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', class: 'btn btn-primary', 'data-testid': 'download', on: { click: () => download(item.blob, `videogen_${item.modelId}_${item.seed}.mp4`) } }, 'Télécharger'),
        h('button', { type: 'button', class: 'btn', 'data-testid': 'extend', on: { click: () => void extendItem(item) } }, 'Prolonger'),
        h('button', { type: 'button', class: 'btn', on: { click: () => app.navigate('gallery') } }, 'Galerie / timeline'),
      ),
    );
    this.resultBox.classList.remove('hidden');
    this.resultBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/** Prolonger : extrait la dernière image dans le navigateur et prépare un image → vidéo enchaîné. */
export async function extendItem(item: GalleryItem): Promise<void> {
  const m = app.model(item.modelId);
  // Modèle image → vidéo pour enchaîner : celui prévu, sinon un autre de la même famille, sinon n'importe
  // lequel d'installé sur l'instance (ex. Wan 2.1 1.3B → Wan 2.2 5B).
  const usable = (id?: string) => {
    const x = id ? app.model(id) : undefined;
    return x && x.mode === 'i2v' && (app.availability.size === 0 || app.availability.get(x.id)?.ok) ? x : undefined;
  };
  const i2v = app.registry?.models.filter((x) => x.mode === 'i2v') ?? [];
  const target = usable(m?.extendWith) ?? i2v.map((x) => usable(x.id)).find((x) => x && x.family === m?.family) ?? i2v.map((x) => usable(x.id)).find(Boolean);
  if (!target) return toast('Aucun modèle image → vidéo installé sur l’instance pour prolonger (ex. coche « Test léger : Wan 2.2 5B »)', 'error');
  toast('Extraction de la dernière image…', 'info');
  try {
    const frame = await lastFrame(item.blob, (t) => toast(t, 'info'));
    app.prefill = {
      modelId: target.id,
      params: { prompt: item.params.prompt, negative: item.params.negative, preset: item.params.preset, ratio: item.params.ratio, duration: item.params.duration, fps: item.params.fps, extras: item.params.extras },
      startImage: frame,
      parentId: item.id,
      note: `Prolongation de ${item.id} avec ${target.label}`,
    };
    app.navigate('generate');
  } catch (e) {
    journal.error('média', 'Extraction de la dernière image impossible', e);
    toast('Extraction de la dernière image impossible (voir Journal)', 'error');
  }
}

/** Rejouer : mêmes réglages et même seed. */
export function replayItem(item: GalleryItem): void {
  app.prefill = { modelId: item.modelId, params: { ...item.params, seed: item.seed }, startImage: item.startImage, endImage: item.endImage, note: `Réglages de ${item.id} rechargés (seed ${item.seed})` };
  app.navigate('generate');
}
