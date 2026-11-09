import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { installStorage } from './setup-storage.ts';
import { guessBase, guessTarget, insertLoras, loraFileName, parseHfLink, MAX_LORAS } from '../../web/src/workflows/lora.ts';
import { buildPrompt, checkAvailability, type ApiPrompt, type Registry } from '../../web/src/workflows/build.ts';
import { buildFlux, FLUX } from '../../web/src/comic/flux.ts';
import { loadSettings, DEFAULT_SETTINGS } from '../../web/src/core/settings.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/public/models.json'), 'utf8')) as Registry;
const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/object_info.json'), 'utf8'));
const wf = (file: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'web/public', file), 'utf8')) as ApiPrompt;

describe('liens Hugging Face', () => {
  it('lien vers un fichier (blob, resolve, révision, sous-dossier, espaces)', () => {
    expect(parseHfLink('https://huggingface.co/org/ltx-styles/blob/main/ink/Ink%20Style.safetensors')).toEqual({ repo: 'org/ltx-styles', path: 'ink/Ink Style.safetensors', revision: 'main' });
    expect(parseHfLink('https://huggingface.co/org/x/resolve/0123abc/a.safetensors?download=true')).toEqual({ repo: 'org/x', path: 'a.safetensors', revision: '0123abc' });
    expect(parseHfLink('org/x/a.safetensors')).toEqual({ repo: 'org/x', path: 'a.safetensors', revision: 'main' });
  });
  it('lien vers un dépôt : fichier à choisir', () => {
    expect(parseHfLink('https://huggingface.co/org/x')).toEqual({ repo: 'org/x', path: null, revision: 'main' });
    expect(parseHfLink('https://huggingface.co/org/x/tree/dev')).toEqual({ repo: 'org/x', path: null, revision: 'dev' });
  });
  it('refus : autre site, format, dataset, chemin', () => {
    expect(() => parseHfLink('https://civitai.com/models/123')).toThrow(/huggingface/);
    expect(() => parseHfLink('https://evil.example/org/x/a.safetensors')).toThrow(/huggingface/);
    expect(() => parseHfLink('https://huggingface.co/org/x/blob/main/model.ckpt')).toThrow(/safetensors/);
    expect(() => parseHfLink('https://huggingface.co/datasets/org/x')).toThrow(/modèle/);
    expect(() => parseHfLink('org')).toThrow();
    expect(() => parseHfLink('org/x/../../a.safetensors')).toThrow();
  });
  it('base devinée et nom de fichier identique à celui de l’agent', () => {
    expect(guessBase(parseHfLink('org/flux2-comic-ink/a.safetensors'))).toBe('flux2dev');
    expect(guessBase(parseHfLink('org/LTX-2.5-dolly/a.safetensors'))).toBe('ltx25');
    expect(loraFileName('org/comic-style', 'loras/Ink Style.safetensors')).toBe('comic-style__Ink_Style.safetensors'); // cf. tests/instance/test_agent.py
  });
});

describe('insertion des LoRA', () => {
  for (const m of reg.models.filter((x) => x.lora && !x.lora.pair)) {
    it(`${m.id} : LoRA branchées entre le modèle et ses utilisateurs`, () => {
      const out = buildPrompt(reg, m, wf(m.workflow), {
        prompt: 'x', preset: m.resolution.default, ratio: '16:9', duration: m.duration.default, fps: m.fps.default, seed: 1, outputPrefix: 'p',
        loras: [{ name: 'videogen/a.safetensors', strength: 0.75 }, { name: 'videogen/b.safetensors', strength: 0 }, { name: 'videogen/c.safetensors', strength: 9 }],
        startImage: 's.png', endImage: 'e.png',
      });
      expect(out['vg-lora1'].inputs).toEqual({ model: [m.lora!.node, 0], lora_name: 'videogen/a.safetensors', strength_model: 0.75 });
      expect(out['vg-lora2'].inputs).toEqual({ model: ['vg-lora1', 0], lora_name: 'videogen/c.safetensors', strength_model: 4 }); // force 0 ignorée, bornée à 4
      expect(out['vg-lora3']).toBeUndefined();
      const users = Object.values(out).flatMap((n) => Object.values(n.inputs)).filter((v) => Array.isArray(v) && v[0] === m.lora!.node);
      expect(users).toEqual([[m.lora!.node, 0]]); // seul vg-lora1 lit encore le modèle
      expect(Object.values(out).filter((n) => n.class_type === 'LTXVDualCFGGuider').every((n) => (n.inputs.model as [string, number])[0] === 'vg-lora2')).toBe(true);
      expect(checkAvailability(out, info).missingNodes).toEqual([]);
    });
  }
  for (const m of reg.models.filter((x) => x.lora?.pair)) {
    it(`${m.id} (Wan 2.2 14B) : chaque LoRA sur l’expert visé, avant la LoRA lightx2v du mode rapide`, () => {
      const { high, low } = m.lora!.pair!;
      const out = buildPrompt(reg, m, wf(m.workflow), {
        prompt: 'x', preset: m.resolution.default, ratio: '16:9', duration: m.duration.default, fps: m.fps.default, seed: 1, outputPrefix: 'p', fast: true, startImage: 's.png',
        loras: [
          { name: 'videogen/orbit__high.safetensors', strength: 1, target: 'high' },
          { name: 'videogen/orbit__low.safetensors', strength: 0.8, target: 'low' },
          { name: 'videogen/style.safetensors', strength: 0.5 },
        ],
      });
      expect(out['vg-lora-high1'].inputs).toEqual({ model: [high, 0], lora_name: 'videogen/orbit__high.safetensors', strength_model: 1 });
      expect(out['vg-lora-high2'].inputs).toEqual({ model: ['vg-lora-high1', 0], lora_name: 'videogen/style.safetensors', strength_model: 0.5 });
      expect(out['vg-lora-low1'].inputs).toEqual({ model: [low, 0], lora_name: 'videogen/orbit__low.safetensors', strength_model: 0.8 });
      expect(out['vg-lora-low2'].inputs.lora_name).toBe('videogen/style.safetensors');
      expect(out['vg-lora-high3']).toBeUndefined();
      // La LoRA lightx2v (mode rapide) et le commutateur lisent la sortie des LoRA choisies.
      const users = (node: string) => Object.entries(out).flatMap(([k, n]) => Object.entries(n.inputs).filter(([, v]) => Array.isArray(v) && v[0] === node).map(([i]) => `${out[k].class_type}.${i}`));
      expect(users(high)).toEqual(['LoraLoaderModelOnly.model']);
      expect(users('vg-lora-high2').sort()).toEqual(['ComfySwitchNode.on_false', 'LoraLoaderModelOnly.model']);
      expect(users('vg-lora-low2').sort()).toEqual(['ComfySwitchNode.on_false', 'LoraLoaderModelOnly.model']);
      expect(checkAvailability(out, info).missingNodes).toEqual([]);
    });
  }
  it('Wan 2.2 5B : une seule chaîne ; expert deviné d’après le nom de fichier', () => {
    const m = reg.models.find((x) => x.id === 'wan22-5b-t2v')!;
    const out = buildPrompt(reg, m, wf(m.workflow), { prompt: 'x', preset: m.resolution.default, ratio: '16:9', duration: m.duration.default, fps: m.fps.default, seed: 1, outputPrefix: 'p', loras: [{ name: 'videogen/a.safetensors', strength: 1 }] });
    expect(out['vg-lora1'].inputs.model).toEqual(['37', 0]);
    expect(out['48'].inputs.model).toEqual(['vg-lora1', 0]);
    expect(guessTarget('videogen/orbit__Wan22_high_noise.safetensors')).toBe('high');
    expect(guessTarget('videogen/orbit-LOW-noise.safetensors')).toBe('low');
    expect(guessTarget('videogen/cinematic.safetensors')).toBe('both');
    expect(guessBase(parseHfLink('org/wan2.2-ti2v-5b-ink/a.safetensors'))).toBe('wan22s');
    expect(guessBase(parseHfLink('org/Wan2.2-orbit/high.safetensors'))).toBe('wan22');
  });
  it('modèle sans LoRA (Wan 2.1 1.3B) : option ignorée', () => {
    const m = reg.models.find((x) => x.id === 'wan21-1.3b-t2v')!;
    const out = buildPrompt(reg, m, wf(m.workflow), { prompt: 'x', preset: m.resolution.default, ratio: '16:9', duration: m.duration.default, fps: m.fps.default, seed: 1, outputPrefix: 'p', loras: [{ name: 'videogen/a.safetensors', strength: 1 }] });
    expect(Object.keys(out).some((k) => k.startsWith('vg-lora'))).toBe(false);
  });
  it(`au plus ${MAX_LORAS} LoRA`, () => {
    const out = insertLoras(structuredClone(wf('workflows/ltx25-t2v.json')), '405:384', Array.from({ length: 5 }, (_, i) => ({ name: `videogen/${i}.safetensors`, strength: 1 })));
    expect(Object.keys(out).filter((k) => k.startsWith('vg-lora'))).toHaveLength(MAX_LORAS);
  });
  it('FLUX.2 (Studio BD) : LoRA de style avant la LoRA Turbo et le commutateur', () => {
    const flux = wf(FLUX.workflow);
    const out = buildFlux(flux, { prompt: 'x', refs: [], width: 1024, height: 1024, seed: 1, turbo: true, outputPrefix: 'p', loras: [{ name: 'videogen/ink.safetensors', strength: 0.8 }] });
    expect(out['vg-lora1'].inputs.model).toEqual([FLUX.unet, 0]);
    expect(out['62:88'].inputs.model).toEqual(['vg-lora1', 0]); // LoRA Turbo du template
    expect(out['62:93'].inputs.on_false).toEqual(['vg-lora1', 0]); // Turbo désactivé
  });
});

describe('réglages par défaut : Studio BD installé', () => {
  beforeEach(() => installStorage());
  it('nouveaux réglages', () => {
    const s = loadSettings();
    expect(s.families).toEqual(['ltx25', 'flux2dev', 'qwen35']);
    expect(s.diskGB).toBe(200);
  });
  it('anciens réglages sur l’ancien défaut : mis à jour', () => {
    localStorage.setItem('videogen.settings.v1', JSON.stringify({ families: ['ltx25'], diskGB: 150, idleMinutes: 30 }));
    const s = loadSettings();
    expect(s.families).toEqual(DEFAULT_SETTINGS.families);
    expect(s.diskGB).toBe(200);
    expect(s.idleMinutes).toBe(30);
    expect(s.savedLoras).toEqual([]);
  });
  it('choix personnel respecté (famille de test légère)', () => {
    localStorage.setItem('videogen.settings.v1', JSON.stringify({ families: ['wan21s'], diskGB: 60 }));
    const s = loadSettings();
    expect(s.families).toEqual(['wan21s']);
    expect(s.diskGB).toBe(60);
  });
});
