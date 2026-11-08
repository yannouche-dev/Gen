// BD express : plan des travaux d'images d'un projet, prêts à être mis TOUS dans la file de ComfyUI.
// - Un travail « Planches » : planche de poses de chaque personnage sans photo, image de chaque décor.
// - Un travail par page : toutes ses cases, avec les planches et décors recalculés dans le même graphe
//   (ComfyUI les reprend de son cache : nœuds identiques au travail précédent) et branchés directement
//   comme images de référence. Le téléphone peut dormir : l'instance enchaîne tout.
// Module pur (sans DOM) : testé unitairement et validé contre un vrai ComfyUI (tools/validate-comic.mjs).
import type { ApiPrompt } from '../workflows/build.ts';
import { buildFlux, mergeGraphs, type FluxRef, type GraphPart } from './flux.ts';
import {
  cellRects, generationSize, getLayout, panelPrompt, settingPrompt, turnaroundPrompt, SETTING_SIZE, SHEET_SIZE,
  type Character, type Project, type Setting,
} from './model.ts';

export interface OutputTarget {
  key: string;
  kind: 'char' | 'setting' | 'panel';
  id: string;
  /** Page de la case (pour les cases). */
  pageId?: string;
  seed: number;
}

export interface ImageJob {
  id: string;
  label: string;
  /** Images du téléphone (identifiants du stockage) à envoyer, dans l'ordre des noms reçus par `build`. */
  uploads: string[];
  outputs: OutputTarget[];
  build(flux: ApiPrompt, names: string[], outputPrefix: string): ApiPrompt;
}

/** Seed stable dérivée de la seed du projet et d'une clé. */
export function seedFor(base: number, key: string): number {
  let h = 2166136261 ^ base;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) % 2 ** 32;
}

interface Asset {
  key: string;
  kind: 'char' | 'setting';
  id: string;
  prompt: string;
  size: { width: number; height: number };
  seed: number;
}

const charKey = (c: Character) => `k-${c.id}`;
const settingKey = (s: Setting) => `s-${s.id}`;

/**
 * Prépare les travaux d'images d'un projet. Les personnages et décors sans image reçoivent une image de
 * référence générée ; `pageIds` limite aux pages voulues (défaut : toutes) ; `onlyEmpty` saute les cases
 * qui ont déjà une image.
 */
export function planComic(p: Project, opts: { pageIds?: string[]; onlyEmpty?: boolean; loras?: { name: string; strength: number }[] } = {}): ImageJob[] {
  const base = p.seed ?? 1;
  const turbo = p.style.turbo;
  const loras = opts.loras ?? p.style.loras;
  const assets: Asset[] = [
    ...p.characters
      .filter((c) => !c.imageIds.length)
      .map((c): Asset => ({ key: charKey(c), kind: 'char', id: c.id, prompt: turnaroundPrompt(p, c, false), size: SHEET_SIZE, seed: seedFor(base, charKey(c)) })),
    ...(p.settings ?? [])
      .filter((s) => !s.imageIds.length)
      .map((s): Asset => ({ key: settingKey(s), kind: 'setting', id: s.id, prompt: settingPrompt(p, s), size: SETTING_SIZE, seed: seedFor(base, settingKey(s)) })),
  ];
  // Projet « virtuel » : les références à générer sont désignées par '@clé'.
  const virt: Project = {
    ...p,
    characters: p.characters.map((c) => (c.imageIds.length ? c : { ...c, imageIds: [`@${charKey(c)}`] })),
    settings: (p.settings ?? []).map((s) => (s.imageIds.length ? s : { ...s, imageIds: [`@${settingKey(s)}`] })),
  };
  const assetGraph = (flux: ApiPrompt, a: Asset) => buildFlux(flux, { prompt: a.prompt, refs: [], ...a.size, seed: a.seed, turbo, loras, outputPrefix: 'x' });
  const jobs: ImageJob[] = [];
  if (assets.length) {
    jobs.push({
      id: 'planches',
      label: `Planches : ${assets.length} référence(s) (personnages, décors)`,
      uploads: [],
      outputs: assets.map((a) => ({ key: a.key, kind: a.kind, id: a.id, seed: a.seed })),
      build: (flux, _names, prefix) => mergeGraphs(assets.map((a) => ({ key: a.key, graph: assetGraph(flux, a), save: true })), prefix),
    });
  }

  const pages = p.pages.filter((pg) => !opts.pageIds || opts.pageIds.includes(pg.id));
  for (const page of pages) {
    const pageNo = p.pages.indexOf(page) + 1;
    const rects = cellRects(getLayout(page.layout));
    const panels = page.panels.slice(0, rects.length).map((pa, i) => ({ pa, rect: rects[i], idx: i })).filter(({ pa }) => !opts.onlyEmpty || !pa.imageId);
    if (!panels.length) continue;
    const plans = panels.map(({ pa, rect, idx }) => {
      const plan = panelPrompt(virt, pa);
      const seed = pa.seed ?? seedFor(base, `p-${pa.id}`);
      return { pa, idx, plan, size: generationSize(rect), seed };
    });
    const used = new Set(plans.flatMap((x) => x.plan.images).filter((i) => i.startsWith('@')).map((i) => i.slice(1)));
    const uploads = [...new Set(plans.flatMap((x) => x.plan.images).filter((i) => !i.startsWith('@')))];
    const needed = assets.filter((a) => used.has(a.key));
    jobs.push({
      id: `page-${page.id}`,
      label: `Page ${pageNo} : ${plans.length} case(s)`,
      uploads,
      outputs: plans.map((x) => ({ key: `p-${x.pa.id}`, kind: 'panel', id: x.pa.id, pageId: page.id, seed: x.seed })),
      build: (flux, names, prefix) => {
        const parts: GraphPart[] = needed.map((a) => ({ key: a.key, graph: assetGraph(flux, a), save: false }));
        for (const x of plans) {
          const refs: FluxRef[] = x.plan.images.map((img) => (img.startsWith('@') ? [img, 0] : names[uploads.indexOf(img)]));
          parts.push({ key: `p-${x.pa.id}`, graph: buildFlux(flux, { prompt: x.plan.prompt, refs, ...x.size, seed: x.seed, turbo, loras, outputPrefix: 'x' }), save: true });
        }
        return mergeGraphs(parts, prefix);
      },
    });
  }
  return jobs;
}

/** Nombre d'images que produira un plan (pour l'annoncer avant de lancer). */
export function countImages(jobs: ImageJob[]): number {
  return jobs.reduce((n, j) => n + j.outputs.length, 0);
}
