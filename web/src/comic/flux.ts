// Construction des requêtes /prompt du Studio BD à partir des workflows officiels convertis :
// - FLUX.2 Dev (template image_flux2_fp8.json) : 0 à N images de référence (chaîne ReferenceLatent) ;
// - Qwen 3.5 4B (template llm_qwen3_5_text_gen.json) : texte, avec ou sans image.
import type { ApiPrompt } from '../workflows/build.ts';
import { insertLoras, type LoraChoice } from '../workflows/lora.ts';

/** Repères dans workflows/flux2-dev-ref.json (identifiants issus de la conversion du template officiel). */
export const FLUX = {
  workflow: 'workflows/flux2-dev-ref.json',
  prompt: { node: '62:6', input: 'text' },
  seed: { node: '62:25', input: 'noise_seed' },
  latent: '62:47',
  scheduler: '62:48',
  turbo: { node: '62:95', input: 'value' },
  output: { node: '9', input: 'filename_prefix' },
  /** Chaînes de référence du template, de la plus proche du texte à la plus proche du guider. */
  chains: [
    { load: '42', scale: '62:45', encode: '62:44', ref: '62:43' },
    { load: '46', scale: '62:41', encode: '62:40', ref: '62:39' },
  ],
  conditioningSource: '62:26',
  /** Chargement du modèle (les LoRA choisies se branchent juste après, avant la LoRA Turbo du template). */
  unet: '62:12',
  sink: { node: '62:22', input: 'conditioning' },
  /** Nœuds qui lisaient la taille d'une image de référence (remplacés par une taille explicite). */
  sizeProbes: ['62:66'],
};

/** Repères dans workflows/qwen35-text.json. */
export const QWEN = {
  workflow: 'workflows/qwen35-text.json',
  load: '2',
  gen: '3',
  preview: '4',
};

/** Référence : nom d'une image envoyée, ou lien vers l'image produite par une autre partie du même travail. */
export type FluxRef = string | [string, number];

export interface FluxInput {
  prompt: string;
  /** Références (reference image 1, 2, …), dans l'ordre. */
  refs: FluxRef[];
  width: number;
  height: number;
  seed: number;
  turbo: boolean;
  outputPrefix: string;
  /** LoRA de style du projet (FLUX.2 Dev). */
  loras?: LoraChoice[];
}

export function buildFlux(template: ApiPrompt, f: FluxInput): ApiPrompt {
  const wf = structuredClone(template);
  for (const n of [FLUX.prompt.node, FLUX.seed.node, FLUX.latent, FLUX.scheduler, FLUX.turbo.node, FLUX.output.node, FLUX.conditioningSource, FLUX.sink.node]) {
    if (!wf[n]) throw new Error(`Nœud ${n} absent du workflow FLUX.2`);
  }
  wf[FLUX.prompt.node].inputs[FLUX.prompt.input] = f.prompt;
  wf[FLUX.seed.node].inputs[FLUX.seed.input] = f.seed;
  wf[FLUX.turbo.node].inputs[FLUX.turbo.input] = f.turbo;
  wf[FLUX.output.node].inputs[FLUX.output.input] = f.outputPrefix;
  for (const n of [FLUX.latent, FLUX.scheduler]) {
    wf[n].inputs.width = f.width;
    wf[n].inputs.height = f.height;
  }
  // Modèle de chaîne (la première du template), puis suppression des chaînes et sondes de taille du template.
  const proto = FLUX.chains[0];
  const tpl = { load: wf[proto.load], scale: wf[proto.scale], encode: wf[proto.encode], ref: wf[proto.ref] };
  for (const c of FLUX.chains) for (const id of [c.load, c.scale, c.encode, c.ref]) delete wf[id];
  for (const id of FLUX.sizeProbes) delete wf[id];

  let prev: [string, number] = [FLUX.conditioningSource, 0];
  f.refs.forEach((src, i) => {
    const k = `vg-ref${i + 1}`;
    const scale = structuredClone(tpl.scale);
    if (typeof src === 'string') {
      const load = structuredClone(tpl.load);
      load.inputs.image = src;
      load._meta = { title: `Référence ${i + 1}` };
      wf[`${k}:load`] = load;
      scale.inputs.image = [`${k}:load`, 0];
    } else scale.inputs.image = src; // image générée dans le même travail (planche de personnage, décor)
    const encode = structuredClone(tpl.encode);
    encode.inputs.pixels = [`${k}:scale`, 0];
    const ref = structuredClone(tpl.ref);
    ref.inputs.conditioning = prev;
    ref.inputs.latent = [`${k}:encode`, 0];
    wf[`${k}:scale`] = scale;
    wf[`${k}:encode`] = encode;
    wf[`${k}:ref`] = ref;
    prev = [`${k}:ref`, 0];
  });
  wf[FLUX.sink.node].inputs[FLUX.sink.input] = prev;
  insertLoras(wf, FLUX.unet, f.loras);

  // Aucun lien ne doit pointer vers un nœud supprimé.
  for (const [id, n] of Object.entries(wf)) {
    for (const [k, v] of Object.entries(n.inputs)) {
      if (Array.isArray(v) && typeof v[0] === 'string' && !v[0].startsWith('@') && !wf[v[0]]) throw new Error(`Lien cassé ${id}.${k} → ${v[0]}`);
    }
  }
  return wf;
}

export interface QwenInput {
  prompt: string;
  image?: string;
  maxLength: number;
  temperature: number;
  seed: number;
}

export function buildQwen(template: ApiPrompt, q: QwenInput): ApiPrompt {
  const wf = structuredClone(template);
  const gen = wf[QWEN.gen];
  if (!gen || !wf[QWEN.preview]) throw new Error('Workflow Qwen 3.5 incomplet');
  gen.inputs.prompt = q.prompt;
  gen.inputs.max_length = q.maxLength;
  gen.inputs['sampling_mode.temperature'] = q.temperature;
  gen.inputs['sampling_mode.seed'] = q.seed;
  if (q.image) wf[QWEN.load].inputs.image = q.image;
  else {
    delete wf[QWEN.load];
    delete gen.inputs.image;
  }
  return wf;
}

/** Nœud qui produit l'image décodée d'un travail FLUX.2 (avant SaveImage). */
export const FLUX_IMAGE: [string, number] = ['62:8', 0];

export interface GraphPart {
  /** Clé unique (lettres, chiffres, tirets) : préfixe des nœuds et du nom de fichier de sortie. */
  key: string;
  graph: ApiPrompt;
  /** Garder le nœud de sortie (SaveImage) ? Sinon la partie ne sert que de référence aux suivantes. */
  save: boolean;
}

/**
 * Fusionne plusieurs générations FLUX.2 en UN travail ComfyUI (une seule entrée dans la file) :
 * - les nœuds identiques (chargeurs de modèles, encodage d'une même référence…) ne sont gardés qu'une fois ;
 * - un lien `['@clé', 0]` pointe vers l'image produite par la partie `clé` (planche de personnage, décor),
 *   sans aller-retour par le disque ;
 * - chaque SaveImage gardé écrit `<préfixe>_<clé>_…png`, ce qui permet de ranger les images reçues.
 * ComfyUI met en cache les nœuds identiques d'un travail à l'autre : une planche présente dans plusieurs
 * travaux successifs n'est calculée qu'une fois.
 */
export function mergeGraphs(parts: GraphPart[], outputPrefix: string): ApiPrompt {
  const out: ApiPrompt = {};
  const bySig = new Map<string, string>();
  const exports = new Map<string, string>();
  for (const part of parts) {
    if (!/^[A-Za-z0-9-]+$/.test(part.key)) throw new Error(`Clé invalide : ${part.key}`);
    const g = structuredClone(part.graph);
    if (!part.save) delete g[FLUX.output.node];
    else g[FLUX.output.node].inputs[FLUX.output.input] = `${outputPrefix}_${part.key}`;
    const ids = new Map<string, string>();
    const visit = (id: string, path: string[] = []): string => {
      const done = ids.get(id);
      if (done) return done;
      if (path.includes(id)) throw new Error(`Cycle dans le workflow (${id})`);
      const n = g[id];
      if (!n) throw new Error(`Nœud ${id} absent (${part.key})`);
      const inputs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(n.inputs)) {
        if (Array.isArray(v) && typeof v[0] === 'string' && v.length === 2 && typeof v[1] === 'number') {
          if (v[0].startsWith('@')) {
            const src = exports.get(v[0].slice(1));
            if (!src) throw new Error(`Référence ${v[0]} inconnue (elle doit venir d'une partie précédente)`);
            inputs[k] = [src, v[1]];
          } else inputs[k] = [visit(v[0], [...path, id]), v[1]];
        } else inputs[k] = v;
      }
      const isOutput = n.class_type === 'SaveImage';
      const sig = JSON.stringify([n.class_type, inputs]);
      let mid = isOutput ? undefined : bySig.get(sig);
      if (!mid) {
        mid = `${part.key}:${id}`;
        out[mid] = { ...n, inputs } as ApiPrompt[string];
        if (!isOutput) bySig.set(sig, mid);
      }
      ids.set(id, mid);
      return mid;
    };
    for (const id of Object.keys(g)) visit(id);
    exports.set(part.key, ids.get(FLUX_IMAGE[0])!);
  }
  return out;
}

/** Clé d'une image reçue, d'après son nom de fichier `<base>_<clé>_00001_.png`. */
export function outputKey(filename: string, outputPrefix: string): string | null {
  const base = outputPrefix.split('/').pop()!;
  if (!filename.startsWith(`${base}_`)) return null;
  const m = filename.slice(base.length + 1).match(/^([A-Za-z0-9-]+)_\d+_?\.(png|jpe?g|webp)$/i);
  return m ? m[1] : null;
}
