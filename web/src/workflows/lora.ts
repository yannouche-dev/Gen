// LoRA : lecture des liens Hugging Face, insertion dans un workflow (nœuds officiels LoraLoaderModelOnly
// branchés juste après le chargement du modèle). Module pur, testé unitairement.
import type { ApiPrompt } from './build.ts';

/** Modèles de base qui acceptent des LoRA dans l'interface. */
export const LORA_BASES: Record<string, string> = {
  ltx25: 'LTX-2.5 (vidéo)',
  flux2dev: 'FLUX.2 Dev (Studio BD)',
  wan22: 'Wan 2.2 (14B)',
  wan22s: 'Wan 2.2 (5B)',
};

export interface LoraChoice {
  /** Nom vu par ComfyUI, ex. « videogen/style__ink.safetensors ». */
  name: string;
  strength: number;
}

export interface LoraInfo {
  name: string;
  file: string;
  size: number;
  base: string | null;
  repo?: string | null;
  path?: string | null;
  revision?: string | null;
}

export interface LoraJob {
  name: string;
  file: string;
  repo: string;
  path: string;
  base: string;
  state: 'downloading' | 'error' | 'done';
  size: number | null;
  done: number;
  error: string | null;
}

/** LoRA mémorisée dans le navigateur, pour la réinstaller sur une nouvelle instance. */
export interface SavedLora {
  repo: string;
  path: string;
  revision: string;
  base: string;
}

export interface HfLink {
  repo: string;
  path: string | null;
  revision: string;
}

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

/**
 * Comprend un lien Hugging Face :
 * - https://huggingface.co/org/repo/blob/main/dossier/fichier.safetensors (ou /resolve/…)
 * - https://huggingface.co/org/repo (le fichier sera choisi dans la liste)
 * - org/repo ou org/repo/fichier.safetensors
 * Tout autre site est refusé.
 */
export function parseHfLink(input: string): HfLink {
  let s = input.trim();
  if (!s) throw new Error('Colle un lien Hugging Face');
  if (/^https?:\/\//i.test(s)) {
    const u = new URL(s);
    if (u.hostname !== 'huggingface.co' && u.hostname !== 'www.huggingface.co') throw new Error('Seuls les liens huggingface.co sont acceptés');
    s = decodeURIComponent(u.pathname).replace(/^\/+|\/+$/g, '');
    if (s.startsWith('models/')) s = s.slice(7);
    if (/^(datasets|spaces)\//.test(s)) throw new Error('Ce lien n’est pas un dépôt de modèle');
  }
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('Lien incomplet : il faut au moins propriétaire/dépôt');
  const repo = `${parts[0]}/${parts[1]}`;
  if (!REPO_RE.test(repo)) throw new Error('Nom de dépôt invalide');
  let revision = 'main';
  let rest = parts.slice(2);
  if (rest[0] === 'blob' || rest[0] === 'resolve' || rest[0] === 'tree') {
    revision = rest[1] ?? 'main';
    rest = rest.slice(2);
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(revision)) throw new Error('Révision invalide');
  const path = rest.length ? rest.join('/') : null;
  if (path && !path.endsWith('.safetensors')) throw new Error('Seuls les fichiers .safetensors sont acceptés');
  if (path && path.split('/').some((x) => x === '..' || x === '.')) throw new Error('Chemin invalide');
  return { repo, path, revision };
}

/** Base probable d'après le nom du dépôt et du fichier (modifiable par l'utilisateur). */
export function guessBase(link: HfLink): string {
  const t = `${link.repo}/${link.path ?? ''}`.toLowerCase();
  if (/flux[._-]?2|flux2/.test(t)) return 'flux2dev';
  if (/ltx/.test(t)) return 'ltx25';
  if (/wan[-_. ]?2[-_. ]?2|wan22/.test(t)) return 'wan22';
  return 'ltx25';
}

/** Nom de fichier sur l'instance (même règle que l'agent : dépôt__fichier.safetensors). */
export function loraFileName(repo: string, path: string): string {
  const stem = path.split('/').pop()!.replace(/\.safetensors$/, '');
  const name = `${repo.split('/')[1]}__${stem}`.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[._]+|[._]+$/g, '').slice(0, 120);
  return `${name || 'lora'}.safetensors`;
}

export const MAX_LORAS = 3;

/**
 * Branche des LoRA après le nœud de chargement du modèle (UNETLoader) : chaque consommateur du modèle
 * (guider, autre LoRA du template, commutateur Turbo…) reçoit la sortie de la dernière LoRA.
 */
export function insertLoras(wf: ApiPrompt, modelNode: string, loras: LoraChoice[] | undefined): ApiPrompt {
  const list = (loras ?? []).filter((l) => l.name && Number.isFinite(l.strength) && l.strength !== 0).slice(0, MAX_LORAS);
  if (!list.length) return wf;
  if (!wf[modelNode]) throw new Error(`Nœud de modèle ${modelNode} absent du workflow`);
  const consumers: [string, string][] = [];
  for (const [id, n] of Object.entries(wf)) {
    for (const [k, v] of Object.entries(n.inputs)) {
      if (Array.isArray(v) && v[0] === modelNode && v[1] === 0) consumers.push([id, k]);
    }
  }
  let prev: [string, number] = [modelNode, 0];
  list.forEach((l, i) => {
    const id = `vg-lora${i + 1}`;
    wf[id] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: prev, lora_name: l.name, strength_model: Math.round(Math.max(-4, Math.min(4, l.strength)) * 100) / 100 },
      _meta: { title: `LoRA ${i + 1}` },
    };
    prev = [id, 0];
  });
  for (const [id, k] of consumers) wf[id].inputs[k] = prev;
  return wf;
}
