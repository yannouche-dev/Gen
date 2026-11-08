import { describe, it, expect } from 'vitest';
import { catalogPage, catalogQueries, mergeCatalog } from '../../web/src/workflows/catalog.ts';

const declared = (id: string, base: string, extra: Partial<{ downloads: number; likes: number; tags: string[]; createdAt: string }> = {}) => ({
  id,
  downloads: 10,
  likes: 1,
  tags: ['lora', `base_model:adapter:${base}`],
  createdAt: '2026-10-01T00:00:00Z',
  ...extra,
});

describe('catalogue de LoRA Hugging Face', () => {
  it('requêtes : modèle de base déclaré, puis recherche par nom limitée aux LoRA', () => {
    const q = catalogQueries('ltx25', 'downloads');
    expect(q[0]).toBe('/api/models?filter=base_model%3Aadapter%3ALightricks%2FLTX-2.5&sort=downloads&direction=-1&limit=100');
    expect(q.slice(1)).toEqual([
      '/api/models?search=ltx-2.5&filter=lora&sort=downloads&direction=-1&limit=100',
      '/api/models?search=ltx2.5&filter=lora&sort=downloads&direction=-1&limit=100',
    ]);
    const t = catalogQueries('flux2dev', 'likes', 'ink');
    expect(t).toHaveLength(2);
    expect(t[0]).toContain('base_model%3Aadapter%3Ablack-forest-labs%2FFLUX.2-dev');
    expect(t[0]).toContain('&search=ink&sort=likes');
    expect(t[1]).toContain('search=ink&filter=lora');
    expect(catalogPage('ltx25')).toBe('https://huggingface.co/models?other=base_model:adapter:Lightricks%2FLTX-2.5&sort=downloads');
    expect(() => catalogQueries('sdxl', 'downloads')).toThrow();
  });

  it('fusion : doublons, modèle de base, dépôts adultes et LoRA d’autres modèles exclus', () => {
    const a = [
      declared('org/ltx25-dolly', 'Lightricks/LTX-2.5', { downloads: 500 }),
      declared('nsfw/ltx25-x', 'Lightricks/LTX-2.5', { downloads: 9999, tags: ['lora', 'base_model:adapter:Lightricks/LTX-2.5', 'not-for-all-audiences'] }),
      { id: 'Lightricks/LTX-2.5', downloads: 1e6, tags: ['diffusers'] },
      { id: 'org/private', downloads: 5, tags: ['lora', 'base_model:adapter:Lightricks/LTX-2.5'], private: true },
    ];
    const b = [
      declared('org/ltx25-dolly', 'Lightricks/LTX-2.5', { downloads: 500 }), // doublon
      { id: 'someone/LTX-2.5-anime', downloads: 200, likes: 90, tags: ['lora'], createdAt: '2026-11-02T00:00:00Z' }, // nom seulement
      { id: 'x/ltx-2-19b-cam', downloads: 7000, tags: ['lora', 'base_model:adapter:Lightricks/LTX-2'] }, // autre modèle
      { id: 'y/ltx25-not-a-lora', downloads: 50, tags: ['diffusers'] }, // pas une LoRA
      'garbage',
      { id: '../evil' },
    ];
    const byDl = mergeCatalog([a, b, { error: 'x' }], 'ltx25', 'downloads');
    expect(byDl.map((x) => x.id)).toEqual(['org/ltx25-dolly', 'someone/LTX-2.5-anime']);
    expect(byDl[0]).toMatchObject({ author: 'org', name: 'ltx25-dolly', downloads: 500 });
    expect(mergeCatalog([a, b], 'ltx25', 'likes').map((x) => x.id)).toEqual(['someone/LTX-2.5-anime', 'org/ltx25-dolly']);
    expect(mergeCatalog([a, b], 'ltx25', 'lastModified')[0].id).toBe('someone/LTX-2.5-anime');
  });

  it('FLUX.2 : les LoRA FLUX.1 sont exclues', () => {
    const list = [
      declared('org/flux2-ink', 'black-forest-labs/FLUX.2-dev'),
      { id: 'z/FLUX.2-watercolor', downloads: 3, tags: ['lora'] },
      declared('q/flux1-anime', 'black-forest-labs/FLUX.1-dev', { downloads: 1e5 }),
      { id: 'w/flux-anime', downloads: 9, tags: ['lora'] }, // nom sans « 2 »
      { id: 'v/flux21-thing', downloads: 9, tags: ['lora'] }, // « flux21 » n'est pas FLUX.2
    ];
    expect(mergeCatalog([list], 'flux2dev', 'downloads').map((x) => x.id)).toEqual(['org/flux2-ink', 'z/FLUX.2-watercolor']);
  });
});
