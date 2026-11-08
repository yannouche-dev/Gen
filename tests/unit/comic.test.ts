import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkAvailability, type ApiPrompt } from '../../web/src/workflows/build.ts';
import { buildFlux, buildQwen, mergeGraphs, outputKey, FLUX, QWEN } from '../../web/src/comic/flux.ts';
import {
  LAYOUTS, PAGE_H, PAGE_W, applyBible, biblePrompt, cellRects, generationSize, layoutCount, layoutFor, newPanel, newProject, normalizeProject, panelPrompt,
  parseBible, parseStory, storyPrompt, storyToPages, type Project,
} from '../../web/src/comic/model.ts';
import { countImages, planComic } from '../../web/src/comic/express.ts';
import { buildCbz, buildPdf, buildZip, crc32, jpegSize } from '../../web/src/comic/export.ts';
import { fakeLlm } from '../../mocks/mock-comfy.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const wf = (file: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'web/public', file), 'utf8')) as ApiPrompt;
const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/object_info.json'), 'utf8'));
const flux = wf(FLUX.workflow);
const qwen = wf(QWEN.workflow);

function linksOk(w: ApiPrompt) {
  for (const [id, n] of Object.entries(w)) {
    for (const [k, v] of Object.entries(n.inputs)) {
      if (Array.isArray(v) && typeof v[0] === 'string') expect(w[v[0]], `${id}.${k} → ${v[0]}`).toBeDefined();
    }
  }
}

describe('FLUX.2 Dev : références multiples', () => {
  for (const n of [0, 1, 2, 3, 4]) {
    it(`${n} image(s) de référence`, () => {
      const refs = Array.from({ length: n }, (_, i) => `ref${i}.jpg`);
      const out = buildFlux(flux, { prompt: 'P', refs, width: 832, height: 1216, seed: 42, turbo: false, outputPrefix: 'videogen/bd_x' });
      linksOk(out);
      expect(checkAvailability(out, info).missingNodes).toEqual([]);
      const loads = Object.values(out).filter((x) => x.class_type === 'LoadImage');
      expect(loads.map((x) => x.inputs.image)).toEqual(refs);
      // Chaîne : conditionnement du texte → ref1 → ref2 → … → guider.
      let cur = out[FLUX.sink.node].inputs[FLUX.sink.input] as [string, number];
      const seen: string[] = [];
      while (cur[0] !== FLUX.conditioningSource) {
        expect(out[cur[0]].class_type).toBe('ReferenceLatent');
        seen.unshift(cur[0]);
        cur = out[cur[0]].inputs.conditioning as [string, number];
      }
      expect(seen).toEqual(refs.map((_, i) => `vg-ref${i + 1}:ref`));
      expect(out[FLUX.latent].inputs.width).toBe(832);
      expect(out[FLUX.scheduler].inputs.height).toBe(1216);
      expect(out[FLUX.seed.node].inputs[FLUX.seed.input]).toBe(42);
      expect(out[FLUX.turbo.node].inputs[FLUX.turbo.input]).toBe(false);
      expect(out[FLUX.output.node].inputs[FLUX.output.input]).toBe('videogen/bd_x');
      for (const id of FLUX.sizeProbes) expect(out[id]).toBeUndefined();
    });
  }
  it('ne modifie pas le modèle de workflow', () => {
    const before = JSON.stringify(flux);
    buildFlux(flux, { prompt: 'x', refs: ['a.png'], width: 1024, height: 1024, seed: 1, turbo: true, outputPrefix: 'p' });
    expect(JSON.stringify(flux)).toBe(before);
  });
});

describe('Qwen 3.5 : génération de texte', () => {
  it('avec image', () => {
    const out = buildQwen(qwen, { prompt: 'Décris', image: 'perso.jpg', maxLength: 300, temperature: 0.4, seed: 7 });
    linksOk(out);
    expect(out[QWEN.load].inputs.image).toBe('perso.jpg');
    expect(out[QWEN.gen].inputs.image).toEqual([QWEN.load, 0]);
    expect(out[QWEN.gen].inputs.prompt).toBe('Décris');
    expect(out[QWEN.gen].inputs.max_length).toBe(300);
    expect(checkAvailability(out, info).missingNodes).toEqual([]);
  });
  it('sans image : LoadImage retiré', () => {
    const out = buildQwen(qwen, { prompt: 'Découpe', maxLength: 4096, temperature: 0.6, seed: 7 });
    linksOk(out);
    expect(out[QWEN.load]).toBeUndefined();
    expect(out[QWEN.gen].inputs.image).toBeUndefined();
    expect(out[QWEN.preview].inputs.source).toEqual([QWEN.gen, 0]);
  });
});

describe('Gabarits de page', () => {
  for (const l of LAYOUTS) {
    it(`${l.id} : cases dans la page, sans chevauchement`, () => {
      const r = cellRects(l);
      expect(r).toHaveLength(layoutCount(l));
      for (const a of r) {
        expect(a.x).toBeGreaterThanOrEqual(0);
        expect(a.y).toBeGreaterThanOrEqual(0);
        expect(a.x + a.w).toBeLessThanOrEqual(PAGE_W);
        expect(a.y + a.h).toBeLessThanOrEqual(PAGE_H);
        for (const b of r) {
          if (a === b) continue;
          const overlap = a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
          expect(overlap).toBe(false);
        }
      }
    });
  }
  it('gabarit choisi selon le nombre de cases', () => {
    for (let n = 1; n <= 6; n++) expect(layoutCount(layoutFor(n))).toBe(n);
    expect(layoutFor(9).id).toBe('g6');
  });
  it('taille de génération ≈ 1 Mpx, multiple de 16, au format de la case', () => {
    for (const l of LAYOUTS) {
      for (const r of cellRects(l)) {
        const s = generationSize(r);
        expect(s.width % 16).toBe(0);
        expect(s.height % 16).toBe(0);
        expect(s.width).toBeGreaterThanOrEqual(512);
        expect(s.height).toBeLessThanOrEqual(2048);
        expect(Math.abs(s.width / s.height - r.w / r.h) / (r.w / r.h)).toBeLessThan(0.35);
      }
    }
    const sq = generationSize({ x: 0, y: 0, w: 500, h: 500 });
    expect(sq).toEqual({ width: 1008, height: 1008 });
  });
});

describe('Prompts et découpage', () => {
  const p = newProject('Test');
  p.characters = [
    { id: 'k1', name: 'Léa', description: 'red hair', imageIds: ['a1', 'a2'] },
    { id: 'k2', name: 'Max', description: 'tall man', imageIds: ['b1'] },
  ];
  it('références des personnages présents, image de style en dernier', () => {
    p.style.refImageId = 'style';
    const pa = { ...newPanel(), description: 'They talk', characters: ['k1', 'k2'] };
    const plan = panelPrompt(p, pa);
    expect(plan.images).toEqual(['a1', 'b1', 'a2', 'style']);
    expect(plan.prompt).toContain('Léa is the character shown in reference images 1 and 3');
    expect(plan.prompt).toContain('Max is the character shown in reference image 2');
    expect(plan.prompt).toContain('reference image 4, but not its content');
    expect(plan.prompt).toContain('No text');
    p.style.refImageId = undefined;
    expect(panelPrompt(p, pa, 2).images).toEqual(['a1', 'b1']);
  });
  it('lecture de la réponse du modèle (bloc ```json et texte autour)', () => {
    const text = fakeLlm(storyPrompt(p, 2));
    const story = parseStory(text);
    expect(story.pages).toHaveLength(2);
    expect(story.pages[0].panels[0].shot).toBe('wide');
    const pages = storyToPages(p, story);
    expect(pages[0].layout).toBe('m3');
    expect(pages[0].panels[1].characters).toEqual(['k1']);
    expect(pages[0].panels[0].bubbles[0]).toMatchObject({ kind: 'caption', text: 'Il pleuvait depuis trois jours.' });
    expect(pages[0].panels[1].bubbles[0]).toMatchObject({ kind: 'speech', speaker: 'Léa' });
  });
  it('réponse illisible ou cadrage inconnu', () => {
    expect(() => parseStory('Désolé, je ne peux pas.')).toThrow();
    expect(() => parseStory('{"pages":[]}')).toThrow();
    const s = parseStory('{"pages":[{"panels":[{"description":"x","shot":"dutch","dialogues":[{"speaker":"A"}]}]}]}');
    expect(s.pages[0].panels[0].shot).toBe('medium');
    expect(s.pages[0].panels[0].dialogues).toEqual([]);
  });
});

describe('Export PDF / CBZ', () => {
  const jpeg = new Uint8Array(fs.readFileSync(path.join(ROOT, 'mocks/fixtures/preview.jpg')));
  it('taille JPEG', () => {
    const s = jpegSize(jpeg);
    expect(s.width).toBeGreaterThan(0);
    expect(s.height).toBeGreaterThan(0);
  });
  it('PDF : table xref cohérente', () => {
    const pdf = buildPdf([jpeg, jpeg, jpeg], 'Ma BD (été)');
    const text = Buffer.from(pdf).toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    const startxref = Number(text.match(/startxref\n(\d+)/)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    const entries = [...text.slice(startxref).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
    expect(entries).toHaveLength(3 + 3 * 3);
    entries.forEach((off, i) => expect(text.slice(off, off + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
    expect(text).toContain('/Count 3');
    expect(text).toContain('/Filter /DCTDecode');
  });
  it('CRC32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('CBZ lisible par un outil ZIP standard', () => {
    const cbz = buildCbz([jpeg, jpeg], 'Ma BD');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbz-'));
    const f = path.join(dir, 'bd.cbz');
    fs.writeFileSync(f, cbz);
    const out = execFileSync('python3', ['-I', '-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(",".join(z.namelist()))', f]).toString().trim();
    expect(out).toBe('page001.jpg,page002.jpg,ComicInfo.xml');
    fs.rmSync(dir, { recursive: true });
  });
  it('ZIP vide', () => {
    expect(buildZip([]).length).toBe(22);
  });
});

describe('BD express : bible, décors, travaux fusionnés', () => {
  const p = newProject('Express');
  p.seed = 7;
  p.characters = [
    { id: 'k1', name: 'Claire', description: 'bob haircut', imageIds: [] },
    { id: 'k2', name: 'Paul', description: 'grey beard', imageIds: ['photo'] },
  ];
  p.settings = [{ id: 's1', name: 'La librairie', description: 'cozy bookshop', imageIds: [] }];
  p.pages = [
    { id: 'g1', layout: 'm3', panels: [
      { ...newPanel(), id: 'c1', description: 'Claire reads', characters: ['k1'], setting: 's1' },
      { ...newPanel(), id: 'c2', description: 'Paul enters', characters: ['k1', 'k2'], setting: 's1' },
      { ...newPanel(), id: 'c3', description: 'street', characters: [], imageId: 'done' },
    ] },
    { id: 'g2', layout: 'p1', panels: [{ ...newPanel(), id: 'c4', description: 'kitchen', characters: ['k2'] }] },
  ];

  it('bible : JSON lu malgré un raisonnement <think> contenant des accolades', () => {
    const b = parseBible(fakeLlm(biblePrompt(newProject('x'), 'La libraire veut rendre son mari jaloux', 3)), 3);
    expect(b.pages).toHaveLength(3);
    expect(b.characters.map((c) => c.name)).toEqual(['Claire', 'Paul']);
    expect(b.settings).toHaveLength(2);
    const q = newProject('x');
    q.characters = [{ id: 'k', name: 'claire', description: '', imageIds: ['img'] }];
    applyBible(q, b);
    expect(q.characters).toHaveLength(2); // Claire existante complétée, Paul ajouté
    expect(q.characters[0].imageIds).toEqual(['img']);
    expect(q.characters[0].description).toContain('bob haircut');
    expect(q.settings.map((s) => s.name)).toEqual(['La librairie', 'La cuisine']);
    expect(q.outline).toHaveLength(3);
  });

  it('découpage relié aux décors par leur nom', () => {
    const q = newProject('x');
    q.characters = [{ id: 'k', name: 'Claire', description: '', imageIds: [] }];
    q.settings = [{ id: 's', name: 'La librairie', description: '', imageIds: [] }];
    const prompt = storyPrompt(q, 1);
    expect(prompt).toContain('Settings (use these exact names):');
    expect(prompt).toContain('no explicit sexual content');
    const pages = storyToPages(q, parseStory(fakeLlm(prompt)));
    expect(pages[0].panels[0].setting).toBe('s');
  });

  it('prompt de case : personnage, puis décor en référence', () => {
    const q = structuredClone(p);
    q.characters[0].imageIds = ['claire'];
    q.settings[0].imageIds = ['shop'];
    const plan = panelPrompt(q, q.pages[0].panels[1]);
    expect(plan.images).toEqual(['claire', 'photo', 'shop']);
    expect(plan.prompt).toContain('takes place in La librairie, shown in reference image 3');
  });

  it('plan : un travail « planches » puis un travail par page, références branchées dans le graphe', () => {
    const jobs = planComic(p, { onlyEmpty: true });
    expect(jobs.map((j) => j.id)).toEqual(['planches', 'page-g1', 'page-g2']);
    expect(jobs[0].outputs.map((o) => o.key)).toEqual(['k-k1', 's-s1']);
    expect(jobs[1].outputs.map((o) => o.key)).toEqual(['p-c1', 'p-c2']); // c3 a déjà une image
    expect(jobs[1].uploads).toEqual(['photo']);
    expect(countImages(jobs)).toBe(5);

    const planches = jobs[0].build(flux, [], 'videogen/bd_1');
    linksOk(planches);
    expect(Object.values(planches).filter((n) => n.class_type === 'UNETLoader')).toHaveLength(1);
    expect(Object.values(planches).filter((n) => n.class_type === 'SaveImage').map((n) => n.inputs.filename_prefix).sort()).toEqual(['videogen/bd_1_k-k1', 'videogen/bd_1_s-s1']);

    const page = jobs[1].build(flux, ['videogen/photo.png'], 'videogen/bd_2');
    linksOk(page);
    expect(checkAvailability(page, info).missingNodes).toEqual([]);
    expect(Object.values(page).filter((n) => n.class_type === 'UNETLoader')).toHaveLength(1);
    expect(Object.values(page).filter((n) => n.class_type === 'SamplerCustomAdvanced')).toHaveLength(4); // planche, décor, 2 cases
    expect(Object.values(page).filter((n) => n.class_type === 'SaveImage').map((n) => n.inputs.filename_prefix).sort()).toEqual(['videogen/bd_2_p-c1', 'videogen/bd_2_p-c2']);
    // La case 2 utilise la planche de Claire (générée dans le graphe), la photo de Paul et le décor.
    const sources: string[] = [];
    let cur = page['p-c2:62:22'].inputs.conditioning as [string, number];
    while (page[cur[0]].class_type === 'ReferenceLatent') {
      const enc = page[(page[cur[0]].inputs.latent as [string, number])[0]];
      const scale = page[(enc.inputs.pixels as [string, number])[0]];
      sources.unshift((scale.inputs.image as [string, number])[0]);
      cur = page[cur[0]].inputs.conditioning as [string, number];
    }
    expect(sources).toHaveLength(3);
    expect(sources[0]).toBe('k-k1:62:8'); // planche de Claire, décodée dans le même graphe
    expect(page[sources[1]].class_type).toBe('LoadImage');
    expect(page[sources[1]].inputs.image).toBe('videogen/photo.png');
    expect(sources[2]).toBe('s-s1:62:8'); // décor
    // La référence commune aux cases 1 et 2 (planche de Claire) n'est encodée qu'une fois.
    expect(Object.values(page).filter((n) => n.class_type === 'VAEEncode')).toHaveLength(3);
    // Mêmes seeds d'un travail à l'autre : la planche est reprise du cache de ComfyUI.
    const sheetSeed = (g: ApiPrompt) => Object.entries(g).find(([k, n]) => k.startsWith('k-k1') && n.class_type === 'RandomNoise')![1].inputs.noise_seed;
    expect(sheetSeed(page)).toBe(sheetSeed(planches));
  });

  it('fusion : référence inconnue refusée, clé de fichier reconnue', () => {
    expect(() => mergeGraphs([{ key: 'p-x', graph: buildFlux(flux, { prompt: 'x', refs: [['@nope', 0]], width: 1024, height: 1024, seed: 1, turbo: true, outputPrefix: 'x' }), save: true }], 'v/b')).toThrow(/inconnue/);
    expect(outputKey('flux2-bd_123_p-c1x_00004_.png', 'videogen/flux2-bd_123')).toBe('p-c1x');
    expect(outputKey('autre_00001_.png', 'videogen/flux2-bd_123')).toBeNull();
  });

  it('projets anciens : décors ajoutés', () => {
    const old = { ...newProject('vieux') } as Partial<Project>;
    delete old.settings;
    expect(normalizeProject(old as Project).settings).toEqual([]);
  });
});

describe('Bulles : typographie française', () => {
  it('espace insécable avant la ponctuation haute et dans les guillemets', async () => {
    const { frenchSpacing } = await import('../../web/src/comic/render.ts');
    expect(frenchSpacing('Qui a bien pu m’écrire ?')).toBe('Qui a bien pu m’écrire\u202f?');
    expect(frenchSpacing('Vite ! Il dit : « non »')).toBe('Vite\u202f! Il dit\u202f: «\u202fnon\u202f»');
    expect(frenchSpacing('Déjà collé?')).toBe('Déjà collé?');
  });
});
