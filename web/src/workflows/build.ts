// Registre des modèles (models.json) et construction des requêtes /prompt à partir des workflows API.
// Module pur (sans DOM) : utilisé par l'interface, les tests unitaires et la validation contre un vrai ComfyUI.
import { insertLoras, type LoraChoice } from './lora.ts';
import { comboOptions, type ObjectInfo } from '../comfy/client.ts';

export interface Target {
  node: string;
  input: string;
}
export interface NumericParam {
  targets: Target[];
  min?: number;
  max?: number;
  step?: number;
  default?: number;
  half?: Target[];
}
export interface BoolParam {
  targets: Target[];
  label: string;
  default: boolean;
  hides?: string[];
}
/** Option propre à un modèle (affichée seulement pour lui), déclarée dans models.json. */
export interface ExtraParam {
  key: string;
  label: string;
  type: 'number' | 'bool';
  min?: number;
  max?: number;
  step?: number;
  default: number | boolean;
  help?: string;
  /** N'afficher / n'appliquer que si cette option booléenne est active (ex. enhancePrompt). */
  dependsOn?: string;
  targets?: Target[];
  /** Pour un booléen : entrées à débrancher quand il est faux (ex. audio de CreateVideo). */
  unlinkWhenFalse?: Target[];
}
/** Image clé intermédiaire : copie de la chaîne officielle « image de fin » insérée entre deux guides. */
export interface InsertGuide {
  after: string;
  before: string;
  load: string;
  resize: string;
  preprocess: string;
}
export interface ModelDef {
  id: string;
  family: string;
  label: string;
  mode: 't2v' | 'i2v' | 'flf2v';
  audio: boolean;
  workflow: string;
  template: string;
  extendWith?: string;
  output: Target[];
  resolution: { multiple: number; presets: string[]; default: string };
  duration: { min: number; max: number; default: number; targets?: Target[]; frames?: Target[] };
  fps: { options: number[]; default: number; targets: Target[] };
  params: {
    prompt: { targets: Target[] };
    negative?: { targets: Target[] };
    width: { targets: Target[] };
    height: { targets: Target[] };
    seed: { targets: Target[] };
    startImage?: { targets: Target[]; required?: boolean };
    endImage?: { targets: Target[]; required?: boolean };
    steps?: NumericParam;
    cfg?: NumericParam;
    enhancePrompt?: BoolParam;
    fast?: BoolParam;
    middleImage?: { required?: boolean; insertGuide: InsertGuide };
  };
  extras?: ExtraParam[];
  /** Nœud PreviewAny qui renvoie le prompt réellement utilisé (amélioré par Gemma). */
  enhancedPromptNode?: string;
  /** LoRA acceptées : modèle de base (ex. ltx25) et nœud de chargement du modèle (UNETLoader). */
  lora?: { base: string; node: string };
}
export interface Registry {
  version: number;
  comfyVersion: string;
  templatesVersion: string;
  families: Record<string, { label: string; approxGB: number; default: boolean; note?: string }>;
  resolutionPresets: Record<string, { label: string; pixels: number }>;
  ratios: Record<string, number>;
  models: ModelDef[];
}

export type ApiPrompt = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }>;

export interface GenParams {
  prompt: string;
  negative?: string;
  preset: string;
  ratio: string;
  duration: number;
  fps: number;
  seed: number;
  steps?: number;
  cfg?: number;
  enhancePrompt?: boolean;
  fast?: boolean;
  /** Noms de fichiers (sous-dossier compris) déjà envoyés via /upload/image. */
  startImage?: string;
  endImage?: string;
  /** Image clé intermédiaire (nom envoyé) et son instant en secondes. */
  middleImage?: string;
  middleAt?: number;
  /** Valeurs des options propres au modèle (clé de ExtraParam). */
  extras?: Record<string, number | boolean>;
  /** LoRA choisies (noms vus par ComfyUI) et leur force. */
  loras?: LoraChoice[];
  outputPrefix: string;
}

export const MAX_SEED = 2 ** 48;

export function randomSeed(): number {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return (a[0] * 2 ** 16 + (a[1] & 0xffff)) % MAX_SEED;
}

function roundTo(v: number, m: number): number {
  return Math.max(m, Math.round(v / m) * m);
}

/** Largeur et hauteur pour un préréglage (nombre de pixels) et un ratio, arrondies au multiple du modèle. */
export function computeSize(reg: Registry, model: ModelDef, preset: string, ratio: string): { width: number; height: number } {
  const px = reg.resolutionPresets[preset]?.pixels ?? reg.resolutionPresets[model.resolution.default].pixels;
  const r = reg.ratios[ratio] ?? 16 / 9;
  const m = model.resolution.multiple;
  return { width: roundTo(Math.sqrt(px * r), m), height: roundTo(Math.sqrt(px / r), m) };
}

/** Nombre d'images généré pour une durée donnée (formule des templates : durée × fps + 1). */
export function frameCount(duration: number, fps: number): number {
  return Math.round(duration * fps) + 1;
}

/** Options affichées pour un modèle (uniquement ce que le workflow supporte). */
export function supportedOptions(model: ModelDef) {
  const p = model.params;
  return {
    negative: !!p.negative,
    steps: p.steps ?? null,
    cfg: p.cfg ?? null,
    startImage: !!p.startImage,
    endImage: !!p.endImage,
    middleImage: !!p.middleImage,
    extras: model.extras ?? [],
    enhancePrompt: p.enhancePrompt ?? null,
    fast: p.fast ?? null,
    fps: model.fps.options,
    duration: model.duration,
    presets: model.resolution.presets,
  };
}

/** Valeur actuelle d'une entrée dans le workflow (ex. prompt négatif par défaut du template). */
export function readInput(wf: ApiPrompt, t: Target): unknown {
  return wf[t.node]?.inputs[t.input];
}

function set(wf: ApiPrompt, targets: Target[] | undefined, value: unknown) {
  for (const t of targets ?? []) {
    const node = wf[t.node];
    if (!node) throw new Error(`Nœud ${t.node} absent du workflow`);
    node.inputs[t.input] = value;
  }
}

/** Construit la requête API à partir du workflow officiel converti et des réglages choisis. */
export function buildPrompt(reg: Registry, model: ModelDef, workflow: ApiPrompt, g: GenParams): ApiPrompt {
  const wf = structuredClone(workflow);
  const p = model.params;
  if (!g.prompt.trim()) throw new Error('Le prompt est vide');
  set(wf, p.prompt.targets, g.prompt);
  if (p.negative && g.negative !== undefined) set(wf, p.negative.targets, g.negative);
  const { width, height } = computeSize(reg, model, g.preset, g.ratio);
  set(wf, p.width.targets, width);
  set(wf, p.height.targets, height);

  const duration = Math.min(model.duration.max, Math.max(model.duration.min, Math.round(g.duration)));
  const fps = model.fps.options.includes(g.fps) ? g.fps : model.fps.default;
  // Les primitives « Duration » des templates sont entières (LTX) ou décimales (Wan) : même valeur.
  set(wf, model.duration.targets, duration);
  set(wf, model.duration.frames, frameCount(duration, fps));
  set(wf, model.fps.targets, fps);

  const seed = Math.max(0, Math.min(MAX_SEED, Math.floor(g.seed)));
  set(wf, p.seed.targets, seed);

  if (p.enhancePrompt) set(wf, p.enhancePrompt.targets, !!(g.enhancePrompt ?? p.enhancePrompt.default));
  const fast = p.fast ? !!(g.fast ?? p.fast.default) : false;
  if (p.fast) set(wf, p.fast.targets, fast);
  if (p.steps && g.steps !== undefined && !fast) {
    const steps = Math.min(p.steps.max ?? 100, Math.max(p.steps.min ?? 1, Math.round(g.steps)));
    set(wf, p.steps.targets, steps);
    if (p.steps.half) set(wf, p.steps.half, Math.max(1, Math.floor(steps / 2)));
  }
  if (p.cfg && g.cfg !== undefined && !fast) {
    set(wf, p.cfg.targets, Math.min(p.cfg.max ?? 30, Math.max(p.cfg.min ?? 0, Number(g.cfg))));
  }

  if (p.startImage) {
    if (!g.startImage) throw new Error('Image de début requise pour ce modèle');
    set(wf, p.startImage.targets, g.startImage);
  }
  if (p.endImage) {
    if (!g.endImage) throw new Error('Image de fin requise pour ce modèle');
    set(wf, p.endImage.targets, g.endImage);
  }
  if (p.middleImage && g.middleImage) {
    const total = frameCount(duration, fps);
    const at = Math.round((g.middleAt ?? duration / 2) * fps);
    insertKeyframe(wf, p.middleImage.insertGuide, g.middleImage, Math.min(total - 2, Math.max(1, at)));
  }

  for (const x of model.extras ?? []) {
    const enabledBy = x.dependsOn ? (x.dependsOn === 'enhancePrompt' ? !!(g.enhancePrompt ?? p.enhancePrompt?.default) : !!g.extras?.[x.dependsOn]) : true;
    const raw = g.extras?.[x.key] ?? x.default;
    if (x.type === 'bool') {
      const on = !!raw;
      set(wf, x.targets, on);
      if (!on) for (const t of x.unlinkWhenFalse ?? []) delete wf[t.node]?.inputs[t.input];
    } else if (enabledBy) {
      const v = Math.min(x.max ?? Infinity, Math.max(x.min ?? -Infinity, Number(raw)));
      set(wf, x.targets, v);
    }
  }

  set(wf, model.output, g.outputPrefix);
  if (model.lora && g.loras?.length) insertLoras(wf, model.lora.node, g.loras);
  return wf;
}

/**
 * Insère une image clé intermédiaire dans la chaîne officielle de guides LTX (LTXVAddGuide) :
 * on duplique la branche de l'image de fin (LoadImage → Resize → Preprocess → AddGuide), on la place
 * entre les guides « after » et « before », avec frame_idx = instant demandé.
 */
export function insertKeyframe(wf: ApiPrompt, ig: InsertGuide, image: string, frameIdx: number, id = 'vg-mid'): void {
  const need = [ig.after, ig.before, ig.load, ig.resize, ig.preprocess];
  for (const n of need) if (!wf[n]) throw new Error(`Nœud ${n} absent du workflow`);
  const clone = (src: string) => structuredClone(wf[src]);
  const load = clone(ig.load);
  load.inputs.image = image;
  const resize = clone(ig.resize);
  resize.inputs.input = [`${id}:load`, 0];
  const pre = clone(ig.preprocess);
  pre.inputs.image = [`${id}:resize`, 0];
  const guide = clone(ig.before);
  guide.inputs.positive = [ig.after, 0];
  guide.inputs.negative = [ig.after, 1];
  guide.inputs.latent = [ig.after, 2];
  guide.inputs.image = [`${id}:pre`, 0];
  guide.inputs.frame_idx = frameIdx;
  guide._meta = { title: 'Image clé intermédiaire' };
  wf[`${id}:load`] = load;
  wf[`${id}:resize`] = resize;
  wf[`${id}:pre`] = pre;
  wf[`${id}:guide`] = guide;
  wf[ig.before].inputs.positive = [`${id}:guide`, 0];
  wf[ig.before].inputs.negative = [`${id}:guide`, 1];
  wf[ig.before].inputs.latent = [`${id}:guide`, 2];
}

/** Prompt réellement utilisé, renvoyé par le nœud PreviewAny du workflow (après amélioration). */
export function findEnhancedPrompt(outputs: Record<string, Record<string, unknown>>, node?: string): string | null {
  if (!node) return null;
  const t = outputs[node]?.text;
  if (Array.isArray(t) && typeof t[0] === 'string') return t[0];
  return typeof t === 'string' ? t : null;
}

export interface Availability {
  ok: boolean;
  missingNodes: string[];
  missingFiles: string[];
}

/** Le modèle est-il utilisable sur ce serveur ? (nœuds présents et fichiers de poids listés par /object_info) */
export function checkAvailability(workflow: ApiPrompt, info: ObjectInfo, model?: ModelDef): Availability {
  const missingNodes = new Set<string>();
  const missingFiles = new Set<string>();
  const imageTargets = new Set(
    [...(model?.params.startImage?.targets ?? []), ...(model?.params.endImage?.targets ?? [])].map((t) => `${t.node}.${t.input}`),
  );
  for (const [id, node] of Object.entries(workflow)) {
    const def = info[node.class_type];
    if (!def) {
      missingNodes.add(node.class_type);
      continue;
    }
    for (const [name, value] of Object.entries(node.inputs)) {
      if (typeof value !== 'string' || imageTargets.has(`${id}.${name}`)) continue;
      const spec = def.input.required?.[name] ?? def.input.optional?.[name];
      const opts = comboOptions(spec as unknown[] | undefined);
      if (opts && !opts.includes(value) && /\.(safetensors|ckpt|pt|pth|bin|gguf|sft)$/i.test(value)) missingFiles.add(value);
    }
  }
  return { ok: missingNodes.size === 0 && missingFiles.size === 0, missingNodes: [...missingNodes], missingFiles: [...missingFiles] };
}

/** Trouve les sorties vidéo d'une entrée d'historique (SaveVideo : images + animated, ou videos/gifs). */
export function findVideoOutputs(outputs: Record<string, Record<string, unknown>>): { filename: string; subfolder: string; type: string }[] {
  const out: { filename: string; subfolder: string; type: string }[] = [];
  for (const o of Object.values(outputs)) {
    for (const key of ['videos', 'gifs', 'images']) {
      const arr = o[key];
      if (!Array.isArray(arr)) continue;
      for (const f of arr as { filename?: string; subfolder?: string; type?: string }[]) {
        if (f?.filename && /\.(mp4|webm|mov|mkv|gif)$/i.test(f.filename)) {
          out.push({ filename: f.filename, subfolder: f.subfolder ?? '', type: f.type ?? 'output' });
        }
      }
    }
  }
  return out;
}

/** Images produites (SaveImage) dans une entrée d'historique. */
export function findImageOutputs(outputs: Record<string, Record<string, unknown>>): { filename: string; subfolder: string; type: string }[] {
  const out: { filename: string; subfolder: string; type: string }[] = [];
  for (const o of Object.values(outputs)) {
    const arr = o.images;
    if (!Array.isArray(arr)) continue;
    for (const f of arr as { filename?: string; subfolder?: string; type?: string }[]) {
      if (f?.filename && /\.(png|jpe?g|webp)$/i.test(f.filename) && (f.type ?? 'output') === 'output') {
        out.push({ filename: f.filename, subfolder: f.subfolder ?? '', type: f.type ?? 'output' });
      }
    }
  }
  return out;
}
