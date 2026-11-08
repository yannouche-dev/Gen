import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkAvailability, type ApiPrompt } from '../../web/src/workflows/build.ts';
import { buildFlux, buildQwen, FLUX, QWEN } from '../../web/src/comic/flux.ts';
import {
  LAYOUTS, PAGE_H, PAGE_W, cellRects, generationSize, layoutCount, layoutFor, newPanel, newProject, panelPrompt, parseStory, storyPrompt, storyToPages,
} from '../../web/src/comic/model.ts';
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
