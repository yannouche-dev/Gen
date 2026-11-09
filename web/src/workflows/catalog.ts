// Catalogue des LoRA publiées sur Hugging Face pour un modèle de base (API publique, appelée depuis le navigateur).
// Deux sources fusionnées : les dépôts qui déclarent le modèle de base (`base_model:adapter:…`) et une recherche par
// nom limitée aux LoRA. Module pur, testé.

export interface CatalogBase {
  label: string;
  /** Identifiants Hugging Face du modèle de base (déclarés par les LoRA dans `base_model`). */
  ids: string[];
  /** Recherches par nom (LoRA dont l'auteur n'a pas renseigné le modèle de base). */
  search: string[];
  /** Le nom du dépôt doit évoquer ce modèle pour un résultat de recherche par nom. */
  nameRe: RegExp;
}

export const CATALOG_BASES: Record<string, CatalogBase> = {
  ltx25: { label: 'LTX-2.5 (vidéo)', ids: ['Lightricks/LTX-2.5'], search: ['ltx-2.5', 'ltx2.5'], nameRe: /ltx[-_. ]?2[-_. ]?5/i },
  flux2dev: { label: 'FLUX.2 Dev (Studio BD)', ids: ['black-forest-labs/FLUX.2-dev'], search: ['flux.2', 'flux2'], nameRe: /flux[-_. ]?2(?![0-9])/i },
  // Recherche par nom : « 5B » ou « TI2V » dans le nom → modèle 5B, sinon 14B (high / low noise).
  wan22: { label: 'Wan 2.2 (14B)', ids: ['Wan-AI/Wan2.2-I2V-A14B', 'Wan-AI/Wan2.2-T2V-A14B'], search: ['wan2.2', 'wan 2.2'], nameRe: /^(?!.*(5b|ti2v)).*wan[-_. ]?2[-_. ]?2/i },
  wan22s: { label: 'Wan 2.2 (5B)', ids: ['Wan-AI/Wan2.2-TI2V-5B'], search: ['wan2.2', 'wan 2.2 5b'], nameRe: /^(?=.*(5b|ti2v)).*wan[-_. ]?2[-_. ]?2/i },
};

export type CatalogSort = 'downloads' | 'likes' | 'lastModified';

export interface CatalogItem {
  id: string;
  author: string;
  name: string;
  downloads: number;
  likes: number;
  /** Date de dernière mise à jour (ou de création), ISO. */
  updated: string | null;
}

/** Page Hugging Face listant les LoRA d'un modèle de base (à ouvrir dans le navigateur). */
export function catalogPage(base: string): string {
  const b = CATALOG_BASES[base];
  return `https://huggingface.co/models?other=base_model:adapter:${encodeURIComponent(b.ids[0])}&sort=downloads`;
}

/** Chemins d'API à interroger (préfixe : https://huggingface.co). */
export function catalogQueries(base: string, sort: CatalogSort, text = ''): string[] {
  const b = CATALOG_BASES[base];
  if (!b) throw new Error(`Modèle de base inconnu : ${base}`);
  const common = `sort=${sort}&direction=-1&limit=100`;
  const q = text.trim();
  const out = b.ids.map((id) => `/api/models?filter=${encodeURIComponent(`base_model:adapter:${id}`)}${q ? `&search=${encodeURIComponent(q)}` : ''}&${common}`);
  for (const s of q ? [q] : b.search) out.push(`/api/models?search=${encodeURIComponent(s)}&filter=lora&${common}`);
  return out;
}

interface RawModel {
  id?: string;
  modelId?: string;
  downloads?: number;
  likes?: number;
  tags?: string[];
  lastModified?: string;
  createdAt?: string;
  private?: boolean;
}

/**
 * Fusionne les réponses : doublons retirés, modèles de base exclus, dépôts « adultes » exclus, résultats de recherche
 * gardés seulement s'ils visent ce modèle (déclaration ou nom), tri demandé.
 */
export function mergeCatalog(lists: unknown[], base: string, sort: CatalogSort): CatalogItem[] {
  const b = CATALOG_BASES[base];
  const byId = new Map<string, CatalogItem>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list as RawModel[]) {
      const id = raw?.id ?? raw?.modelId;
      if (typeof id !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(id) || byId.has(id) || raw.private) continue;
      const tags = Array.isArray(raw.tags) ? raw.tags.map(String) : [];
      if (b.ids.some((x) => x.toLowerCase() === id.toLowerCase())) continue;
      const declares = tags.some((t) => b.ids.some((x) => t.toLowerCase() === `base_model:adapter:${x}`.toLowerCase() || t.toLowerCase() === `base_model:${x}`.toLowerCase()));
      const isLora = tags.includes('lora') || tags.some((t) => t.startsWith('base_model:adapter:'));
      if (!isLora) continue;
      if (!declares && !b.nameRe.test(id)) continue;
      // Une LoRA qui déclare un AUTRE modèle de base (ex. FLUX.1) n'est pas pour celui-ci, même si son nom ressemble.
      const otherBase = tags.some((t) => t.startsWith('base_model:adapter:')) && !declares;
      if (otherBase) continue;
      const [author, name] = id.split('/');
      byId.set(id, {
        id,
        author,
        name,
        downloads: Number(raw.downloads) || 0,
        likes: Number(raw.likes) || 0,
        updated: raw.lastModified ?? raw.createdAt ?? null,
      });
    }
  }
  const items = [...byId.values()];
  const key = (x: CatalogItem) => (sort === 'likes' ? x.likes : sort === 'lastModified' ? Date.parse(x.updated ?? '') || 0 : x.downloads);
  return items.sort((a, c) => key(c) - key(a) || c.downloads - a.downloads);
}
