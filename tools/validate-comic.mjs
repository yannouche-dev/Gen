#!/usr/bin/env node
// Valide les requêtes du Studio BD (FLUX.2 Dev à 0–4 références, Qwen 3.5 avec/sans image) contre un VRAI
// ComfyUI de la version de l'instance. Usage : COMFY=http://127.0.0.1:8188 node tools/validate-comic.mjs
import fs from 'node:fs';
import path from 'node:path';
import { buildFlux, buildQwen, FLUX, QWEN } from '../web/src/comic/flux.ts';
import { cellRects, generationSize, getLayout, LAYOUTS, newProject, panelPrompt, newPanel, storyPrompt, describeCharacterPrompt } from '../web/src/comic/model.ts';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const COMFY = process.env.COMFY || 'http://127.0.0.1:8188';
const load = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'web/public', f), 'utf8'));
const flux = load(FLUX.workflow);
const qwen = load(QWEN.workflow);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function upload(name) {
  const fd = new FormData();
  fd.append('image', new Blob([PNG], { type: 'image/png' }), name);
  fd.append('subfolder', 'videogen');
  fd.append('type', 'input');
  fd.append('overwrite', 'true');
  const j = await (await fetch(`${COMFY}/upload/image`, { method: 'POST', body: fd })).json();
  return `${j.subfolder}/${j.name}`;
}
async function check(label, prompt) {
  const r = await fetch(`${COMFY}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, client_id: 'videogen-validate' }) });
  const body = await r.json();
  const ok = r.ok && Object.keys(body.node_errors || {}).length === 0;
  console.log(`${ok ? '✓' : '✗'} ${label}`, ok ? '' : JSON.stringify(body).slice(0, 700));
  await fetch(`${COMFY}/queue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clear: true }) });
  await fetch(`${COMFY}/interrupt`, { method: 'POST' });
  return ok;
}

const refs = [];
for (let i = 0; i < 4; i++) refs.push(await upload(`vg_comic_ref${i}.png`));
let failures = 0;
const p = newProject('validation');
p.characters.push({ id: 'a', name: 'Léa', description: 'young woman, red coat', imageIds: ['img1'] });
const panel = { ...newPanel(), description: 'Léa runs in the rain', characters: ['a'] };
const plan = panelPrompt(p, panel);
for (const l of LAYOUTS) {
  const size = generationSize(cellRects(l)[0]);
  for (const n of [0, 1, 2, 3, 4]) {
    if (n > 0 && l.id !== 'p1' && l.id !== 'g6') continue;
    const wf = buildFlux(flux, { prompt: plan.prompt, refs: refs.slice(0, n), width: size.width, height: size.height, seed: 42 + n, turbo: n % 2 === 0, outputPrefix: 'videogen/comic_validate' });
    if (!(await check(`FLUX.2 ${l.id} ${size.width}×${size.height} ${n} réf.`, wf))) failures++;
  }
}
if (!(await check('Qwen 3.5 description (image)', buildQwen(qwen, { prompt: describeCharacterPrompt('Léa'), image: refs[0], maxLength: 300, temperature: 0.4, seed: 1 })))) failures++;
p.synopsis = 'Léa cherche son chat sous la pluie.';
if (!(await check('Qwen 3.5 découpage (texte seul)', buildQwen(qwen, { prompt: storyPrompt(p, 2), maxLength: 4096, temperature: 0.7, seed: 2 })))) failures++;
console.log(failures ? `${failures} échec(s)` : 'Toutes les requêtes BD sont valides.');
process.exit(failures ? 1 : 0);
