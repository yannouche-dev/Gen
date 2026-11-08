// État partagé de l'application (réglages, gestionnaire d'instance, registre des modèles, galerie).
import { journal } from '../core/journal.ts';
import { loadSettings, saveSettings, type Settings } from '../core/settings.ts';
import { vault } from '../core/vault.ts';
import { InstanceManager } from '../vast/manager.ts';
import type { BuildInfo } from '../vast/onstart.ts';
import { checkAvailability, type ApiPrompt, type Availability, type GenParams, type ModelDef, type Registry } from '../workflows/build.ts';
import type { ObjectInfo } from '../comfy/client.ts';
import { gallery } from '../media/gallery.ts';
import type { LoraInfo, LoraJob } from '../workflows/lora.ts';

declare const __BUILD__: BuildInfo;
export const BUILD: BuildInfo = __BUILD__;

export type Route = 'instance' | 'generate' | 'comic' | 'gallery' | 'journal' | 'keys';

/** Pré-remplissage du formulaire de génération (Rejouer / Prolonger). */
export interface Prefill {
  modelId: string;
  params: Partial<Omit<GenParams, 'startImage' | 'endImage' | 'middleImage' | 'outputPrefix'>>;
  startImage?: Blob | null;
  endImage?: Blob | null;
  parentId?: string;
  note?: string;
}

type Listener = (what: string) => void;

class AppContext {
  settings: Settings = loadSettings(BUILD.proxyUrl);
  manager = new InstanceManager(BUILD, () => this.settings);
  registry: Registry | null = null;
  workflows = new Map<string, ApiPrompt>();
  objectInfo: ObjectInfo | null = null;
  availability = new Map<string, Availability>();
  gallery = gallery;
  route: Route = 'instance';
  /** LoRA installées sur l'instance prête, et téléchargements en cours. */
  loras: { list: LoraInfo[]; jobs: LoraJob[]; loaded: boolean } = { list: [], jobs: [], loaded: false };
  private loraTimer: ReturnType<typeof setTimeout> | null = null;
  prefill: Prefill | null = null;
  private listeners = new Set<Listener>();
  private objectInfoFor: string | null = null;

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(what: string): void {
    for (const l of this.listeners) l(what);
  }

  saveSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.settings);
    this.emit('settings');
  }

  navigate(r: Route): void {
    this.route = r;
    this.emit('route');
  }

  async loadRegistry(): Promise<void> {
    if (this.registry) return;
    const reg = (await (await fetch('models.json', { cache: 'no-cache' })).json()) as Registry;
    await Promise.all(
      reg.models.map(async (m) => {
        const wf = (await (await fetch(m.workflow, { cache: 'no-cache' })).json()) as ApiPrompt;
        this.workflows.set(m.id, wf);
      }),
    );
    this.registry = reg;
    journal.debug('modèles', `${reg.models.length} workflows chargés (ComfyUI ${reg.comfyVersion}, templates ${reg.templatesVersion})`);
    this.emit('registry');
  }

  model(id: string): ModelDef | undefined {
    return this.registry?.models.find((m) => m.id === id);
  }

  /** Interroge /object_info (une fois par URL d'instance) et calcule la disponibilité de chaque modèle. */
  async refreshAvailability(force = false): Promise<void> {
    const c = this.manager.comfy;
    if (!c || !this.registry) return;
    if (!force && this.objectInfoFor === c.base && this.objectInfo) return;
    const info = await c.objectInfo();
    this.objectInfo = info;
    this.objectInfoFor = c.base;
    for (const m of this.registry.models) {
      const av = checkAvailability(this.workflows.get(m.id)!, info, m);
      this.availability.set(m.id, av);
      if (!av.ok) journal.info('modèles', `${m.label} indisponible sur le serveur`, av);
    }
    this.emit('availability');
  }

  /** Relit les LoRA de l'instance ; suit les téléchargements en cours (toutes les 2 s) jusqu'à leur fin. */
  async refreshLoras(): Promise<void> {
    const c = this.manager.comfy;
    if (this.loraTimer) clearTimeout(this.loraTimer);
    this.loraTimer = null;
    if (!c) {
      this.loras = { list: [], jobs: [], loaded: false };
      this.emit('loras');
      return;
    }
    const before = new Set(this.loras.list.map((l) => l.name));
    try {
      const r = await c.listLoras();
      this.loras = { list: r.loras ?? [], jobs: r.jobs ?? [], loaded: true };
    } catch {
      /* agent momentanément injoignable : nouvel essai au prochain passage */
    }
    const added = this.loras.list.some((l) => !before.has(l.name));
    if (added || this.loras.list.length !== before.size) void this.refreshAvailability(true).catch(() => undefined);
    this.emit('loras');
    if (this.loras.jobs.some((j) => j.state === 'downloading')) this.loraTimer = setTimeout(() => void this.refreshLoras(), 2000);
  }

  /** LoRA installées pour un modèle de base (ltx25, flux2dev). */
  lorasFor(base: string): LoraInfo[] {
    return this.loras.list.filter((l) => l.base === base);
  }

  invalidateAvailability(): void {
    this.objectInfo = null;
    this.objectInfoFor = null;
    this.availability.clear();
    this.emit('availability');
  }

  vastReady(): boolean {
    return vault.isUnlocked() && !!vault.secrets.vastKey && !!this.settings.proxyUrl;
  }
}

export const app = new AppContext();
