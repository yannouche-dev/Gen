import type { SavedLora } from '../workflows/lora.ts';
// Réglages non secrets, conservés en clair dans localStorage (préfixe « videogen. »).

export interface Settings {
  /** URL du Worker Cloudflare qui relaie l'API Vast (ex. https://videogen-vast-proxy.xxx.workers.dev). */
  proxyUrl: string;
  /** Noms de GPU Vast acceptés, par ordre de préférence. */
  gpuNames: string[];
  numGpus: number;
  minReliability: number;
  minInetDown: number;
  diskGB: number;
  maxPrice: number;
  minCuda: number;
  /** Image Docker de l'instance. */
  image: string;
  comfyVersion: string;
  families: string[];
  idleMinutes: number;
  maxHours: number;
  label: string;
  /** Délai sans progression avant d'abandonner une génération (minutes). */
  stallMinutes: number;
  /** LoRA Hugging Face installées depuis ce navigateur (pour les réinstaller sur une nouvelle instance). */
  savedLoras: SavedLora[];
  /** Version des valeurs par défaut déjà appliquées (migration des anciens réglages). */
  defaultsVersion: number;
}

export const GPU_PRO6000 = ['RTX PRO 6000 WS', 'RTX PRO 6000 S', 'RTX PRO 6000', 'RTX PRO 6000 Max-Q'];
export const GPU_5090 = ['RTX 5090'];

export const DEFAULT_SETTINGS: Settings = {
  proxyUrl: '',
  gpuNames: [...GPU_PRO6000, ...GPU_5090],
  numGpus: 1,
  minReliability: 0.99,
  minInetDown: 500,
  // LTX-2.5 (≈ 52 Go) + Studio BD : FLUX.2 Dev (≈ 57 Go) et Qwen 3.5 (≈ 9 Go), plus le système.
  diskGB: 200,
  maxPrice: 2.5,
  minCuda: 12.9,
  image: 'vastai/pytorch:2.10.0-cu128-cuda-12.9-mini-py312-2026-10-23',
  comfyVersion: 'v0.44.2',
  families: ['ltx25', 'flux2dev', 'qwen35'],
  idleMinutes: 20,
  maxHours: 4,
  label: 'videogen',
  stallMinutes: 15,
  savedLoras: [],
  defaultsVersion: 2,
};

const KEY = 'videogen.settings.v1';

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = storage()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function saveJson(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage plein ou indisponible */
  }
}

export function loadSettings(defaultProxy = ''): Settings {
  const stored = loadJson<Partial<Settings>>(KEY, {});
  const s = { ...DEFAULT_SETTINGS, ...stored };
  // v2 : le Studio BD est installé par défaut. Seuls les réglages encore sur l'ancien défaut (LTX-2.5 seul)
  // sont mis à jour ; un choix personnel (ex. famille de test légère) est respecté.
  if ((stored.defaultsVersion ?? 1) < 2) {
    if (stored.families && stored.families.length === 1 && stored.families[0] === 'ltx25') {
      s.families = [...DEFAULT_SETTINGS.families];
      s.diskGB = Math.max(s.diskGB, DEFAULT_SETTINGS.diskGB);
    }
    s.defaultsVersion = 2;
  }
  s.savedLoras ??= [];
  if (!s.proxyUrl && defaultProxy) s.proxyUrl = defaultProxy;
  return s;
}
export function saveSettings(s: Settings): void {
  saveJson(KEY, s);
}

// ------------------------------------------------------------ préréglages de génération

export interface GenPreset {
  name: string;
  modelId: string;
  values: Record<string, unknown>;
}
const PRESETS_KEY = 'videogen.presets.v1';
export function loadPresets(): GenPreset[] {
  return loadJson<GenPreset[]>(PRESETS_KEY, []);
}
export function savePresets(p: GenPreset[]): void {
  saveJson(PRESETS_KEY, p);
}

// ------------------------------------------------------------ suivi de session (coût)

export interface SessionMeta {
  instanceId: number;
  /** Début de la période « allumée » en cours (ms). */
  runningSince: number | null;
  dph: number;
}
const SESSION_KEY = 'videogen.session.v1';
export function loadSession(): SessionMeta | null {
  return loadJson<SessionMeta | null>(SESSION_KEY, null);
}
export function saveSession(s: SessionMeta | null): void {
  if (s) saveJson(SESSION_KEY, s);
  else storage()?.removeItem(SESSION_KEY);
}
