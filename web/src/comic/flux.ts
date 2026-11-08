// Construction des requêtes /prompt du Studio BD à partir des workflows officiels convertis :
// - FLUX.2 Dev (template image_flux2_fp8.json) : 0 à N images de référence (chaîne ReferenceLatent) ;
// - Qwen 3.5 4B (template llm_qwen3_5_text_gen.json) : texte, avec ou sans image.
import type { ApiPrompt } from '../workflows/build.ts';

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

export interface FluxInput {
  prompt: string;
  /** Noms des images envoyées (reference image 1, 2, …), dans l'ordre. */
  refs: string[];
  width: number;
  height: number;
  seed: number;
  turbo: boolean;
  outputPrefix: string;
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
  f.refs.forEach((name, i) => {
    const k = `vg-ref${i + 1}`;
    const load = structuredClone(tpl.load);
    load.inputs.image = name;
    load._meta = { title: `Référence ${i + 1}` };
    const scale = structuredClone(tpl.scale);
    scale.inputs.image = [`${k}:load`, 0];
    const encode = structuredClone(tpl.encode);
    encode.inputs.pixels = [`${k}:scale`, 0];
    const ref = structuredClone(tpl.ref);
    ref.inputs.conditioning = prev;
    ref.inputs.latent = [`${k}:encode`, 0];
    wf[`${k}:load`] = load;
    wf[`${k}:scale`] = scale;
    wf[`${k}:encode`] = encode;
    wf[`${k}:ref`] = ref;
    prev = [`${k}:ref`, 0];
  });
  wf[FLUX.sink.node].inputs[FLUX.sink.input] = prev;

  // Aucun lien ne doit pointer vers un nœud supprimé.
  for (const [id, n] of Object.entries(wf)) {
    for (const [k, v] of Object.entries(n.inputs)) {
      if (Array.isArray(v) && typeof v[0] === 'string' && !wf[v[0]]) throw new Error(`Lien cassé ${id}.${k} → ${v[0]}`);
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
