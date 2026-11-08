// Mock de l'instance : Caddy (jeton + CORS) devant ComfyUI (/prompt, /ws, /history, /view, /upload/image,
// /object_info, /interrupt, /queue, /system_stats) et l'agent videogen (/videogen/status, /log, /files/delete).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const OBJECT_INFO = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/object_info.json'), 'utf8'));
const WEIGHTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'instance/weights.json'), 'utf8'));
const FIXTURES = {
  a: fs.readFileSync(path.join(HERE, 'fixtures/a.mp4')),
  b: fs.readFileSync(path.join(HERE, 'fixtures/b.mp4')),
  c: fs.readFileSync(path.join(HERE, 'fixtures/c.mp4')),
};
const PREVIEW = fs.readFileSync(path.join(HERE, 'fixtures/preview.jpg'));
const PANEL = fs.readFileSync(path.join(HERE, 'fixtures/panel.png'));

/** Réponses factices de Qwen 3.5 (TextGenerate) : découpage en pages (JSON) ou description de personnage. */
export function fakeLlm(prompt) {
  if (prompt.includes('story bible')) {
    const n = Number(prompt.match(/exactly (\d+) page/)?.[1] ?? 1);
    const kept = [...prompt.matchAll(/^- ([^:\n]+):/gm)].map((x) => x[1]);
    const characters = kept.length
      ? kept.map((name) => ({ name, description: 'as already described' }))
      : [
          { name: 'Claire', description: 'a woman in her thirties, chestnut bob haircut, round glasses, mustard cardigan over a white blouse, navy skirt' },
          { name: 'Paul', description: 'a man in his forties, short grey hair, beard, blue overalls, tool belt' },
        ];
    return '<think>Je réfléchis {brouillon}</think>' + JSON.stringify({
      synopsis: 'Claire, libraire, invente un admirateur pour rendre Paul jaloux. Paul mène l’enquête. Tout finit par un dîner aux chandelles.',
      pages: Array.from({ length: n }, (_, i) => `Résumé de la page ${i + 1}`),
      characters,
      settings: [
        { name: 'La librairie', description: 'a cozy old bookshop with tall wooden shelves, warm lamps, a green armchair' },
        { name: 'La cuisine', description: 'a small kitchen with yellow tiles and a round table' },
      ],
    });
  }
  const m = prompt.match(/exactly (\d+) comic page/);
  if (!m) return 'A young woman in her twenties with short copper-red hair, green eyes, freckles, slim build, wearing a dark green leather jacket over a white t-shirt, blue jeans and red sneakers.';
  const cast = prompt.split('Characters (use these exact names):')[1]?.split(/\n(?:Settings|Story)/)[0] ?? '';
  const names = [...cast.matchAll(/^- ([^:\n]+):/gm)].map((x) => x[1]).filter((n) => !n.startsWith('('));
  const places = prompt.split('Settings (use these exact names):')[1]?.split('\nStory')[0] ?? '';
  const setting = [...places.matchAll(/^- ([^:\n]+):/gm)].map((x) => x[1])[0];
  const who = names[0] ?? 'Héroïne';
  const other = names[1];
  const pages = Array.from({ length: Number(m[1]) }, (_, p) => ({
    panels: [
      { description: `Page ${p + 1}: wide shot of a rainy harbor at dusk`, characters: [who], ...(setting ? { setting } : {}), shot: 'wide', dialogues: [], caption: p === 0 ? 'Il pleuvait depuis trois jours.' : 'Plus tard…' },
      { description: `${who} looks at a mysterious letter`, characters: [who], ...(setting ? { setting } : {}), shot: 'close-up', dialogues: [{ speaker: who, text: 'Qui a bien pu m’écrire ?' }], caption: '' },
      { description: `${who} runs along the docks`, characters: other ? [who, other] : [who], shot: 'low angle', dialogues: [{ speaker: who, text: 'Je dois y aller, vite !' }], caption: '' },
    ],
  }));
  return 'Voici le découpage :\n```json\n' + JSON.stringify({ pages }) + '\n```';
}

export function createComfyMock({ shared, origin, speed = 1 }) {
  const T = (ms) => Math.max(5, Math.round(ms * speed));
  const st = {
    installed: ['ltx25'],
    downloaded: new Set(),
    bootAt: 0,
    down: false,
    uploads: new Set(),
    history: {},
    running: null,
    pending: [],
    deletions: [],
    views: [],
    prompts: [],
    outputs: [],
    outputCount: 0,
    loras: [],
    loraJobs: [],
    /** Démarrage ralenti (tests des étapes détaillées) : facteur appliqué à la chronologie de l'agent. */
    bootSlow: 1,
  };
  const sockets = new Map(); // clientId -> Set<ws>

  const api = {
    reset() {
      Object.assign(st, { installed: ['ltx25'], downloaded: new Set(), bootAt: 0, down: false, uploads: new Set(), history: {}, running: null, pending: [], deletions: [], views: [], prompts: [], outputs: [], outputCount: 0, loras: [], loraJobs: [], bootSlow: 1 });
    },
    setBootSlow(f) {
      st.bootSlow = f;
    },
    setInstalled(fams) {
      st.installed = fams;
    },
    forgetHistory() {
      st.history = {};
    },
    markDownloaded(fams) {
      for (const f of filesFor(fams)) st.downloaded.add(f.name);
    },
    setDown(v) {
      st.down = v;
      // Coupure du tunnel : les WebSocket ouverts tombent aussi (le calcul continue côté serveur).
      if (v) for (const set of sockets.values()) for (const ws of set) ws.terminate();
    },
    boot() {
      st.bootAt = Date.now();
      st.down = false;
    },
    /** Nouveau tunnel (cloudflared redémarré) : l'ancienne adresse ne répond plus, WebSocket coupés. */
    dropSockets() {
      for (const set of sockets.values()) for (const ws of set) ws.terminate();
    },
    state: st,
  };
  shared.comfy = api;

  function filesFor(fams) {
    return fams.flatMap((f) => WEIGHTS.families[f]?.files ?? []);
  }

  function agentStatus() {
    const t = Date.now() - st.bootAt;
    // Chronologie simulée (comme onstart.sh) : début/fin en secondes, sous-tâche et avancement.
    const at = (ms) => (st.bootAt + ms) / 1000;
    const done = (a, b, msg = '') => ({ state: 'done', msg, ts: Date.now() / 1000, started: at(a), ended: at(b), pct: 1 });
    const run = (a, msg = '', pct) => ({ state: 'running', msg, ts: Date.now() / 1000, started: at(a), ...(pct === undefined ? {} : { pct }) });
    const pend = { state: 'pending' };
    const files = filesFor(st.installed);
    const already = files.every((f) => st.downloaded.has(f.name));
    const S = (ms) => T(ms * st.bootSlow);
    const dlStart = S(2200);
    const instEnd = S(1600);
    const startEnd = S(2000);
    const ip = Math.min(1, t / instEnd);
    const installMsg = ip < 0.6 ? `dépendances : ${Math.round(ip * 70)} paquet(s) analysé(s) · numpy` : ip < 0.8 ? 'téléchargement : torchsde-0.2.6-py3-none-any.whl (61 kB)' : 'installation de 42 paquet(s)…';
    const dlDur = already ? 0 : S(2500);
    const frac = Math.max(0, Math.min(1, (t - dlStart) / Math.max(1, dlDur)));
    const total = files.length * 1e9;
    if (frac >= 1) files.forEach((f) => st.downloaded.add(f.name));
    const steps = {
      tools: done(0, T(300), 'Caddy 2.11.9 · cloudflared 2026.10.7'),
      tunnel: done(T(300), T(1100), shared.comfyUrl),
      comfy_install: t > instEnd ? done(T(300), instEnd, 'v0.44.2') : run(T(300), installMsg, 0.45 + 0.47 * ip),
      comfy_start: t > startEnd ? done(instEnd, startEnd) : t > instEnd ? run(instEnd, `chargement… ${Math.round((t - instEnd) / 1000)} s · Starting server`, Math.min(0.95, (t - instEnd) / (startEnd - instEnd))) : pend,
      models: t < dlStart ? pend : frac < 1 ? run(dlStart, `familles : ${st.installed.join(',')}`) : done(dlStart, dlStart + dlDur),
      ready: frac >= 1 && t > dlStart ? done(dlStart + dlDur, dlStart + dlDur) : pend,
    };
    return {
      version: 1,
      now: Date.now() / 1000,
      steps,
      models: t < dlStart ? null : {
        state: frac >= 1 ? 'done' : 'running',
        families: st.installed,
        total_bytes: total,
        done_bytes: Math.round(total * frac),
        error: null,
        files: files.map((f, i) => ({ family: '', repo: f.repo, name: f.name, size: 1e9, done: Math.round(1e9 * Math.min(1, Math.max(0, frac * files.length - i))), state: frac >= 1 ? 'done' : 'downloading', error: null })),
      },
      tunnel_url: shared.comfyUrl,
      comfy_ready: t > startEnd,
      comfy_version: 'v0.44.2',
      watchdog: { idle_minutes: 20, max_hours: 4, boot_ts: st.bootAt / 1000, idle_since: Date.now() / 1000, stop_at: Date.now() / 1000 + 1200, triggered: false, reason: null },
      disk: { free_bytes: 80e9, total_bytes: 150e9 },
    };
  }

  function objectInfo() {
    // Ne liste dans les combos que les poids des familles installées (comme le vrai /object_info).
    const allowed = new Set(filesFor(st.installed).map((f) => f.name));
    const all = new Set(Object.values(WEIGHTS.families).flatMap((f) => f.files.map((x) => x.name)));
    const out = structuredClone(OBJECT_INFO);
    for (const def of Object.values(out)) {
      for (const group of [def.input.required ?? {}, def.input.optional ?? {}]) {
        for (const spec of Object.values(group)) {
          if (Array.isArray(spec[0])) spec[0] = spec[0].filter((v) => !all.has(v) || allowed.has(v));
        }
      }
    }
    // LoRA installées par l'agent (models/loras/videogen/…), visibles aussitôt comme dans le vrai ComfyUI.
    for (const cls of ['LoraLoaderModelOnly', 'LoraLoader']) {
      const spec = out[cls]?.input.required?.lora_name;
      if (spec && Array.isArray(spec[0])) spec[0] = [...spec[0], ...st.loras.map((l) => l.name)];
    }
    return out;
  }

  const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Cache-Control': 'no-store' };
  function send(res, status, data, type = 'application/json') {
    res.writeHead(status, { 'Content-Type': type, ...cors });
    res.end(type === 'application/json' ? JSON.stringify(data) : data);
  }
  function authed(req, url) {
    const tok = shared.comfyToken;
    return !!tok && (req.headers.authorization === `Bearer ${tok}` || url.searchParams.get('token') === tok);
  }
  function emit(clientId, msg) {
    for (const ws of sockets.get(clientId) ?? []) if (ws.readyState === 1) ws.send(typeof msg === 'string' || Buffer.isBuffer(msg) ? msg : JSON.stringify(msg));
  }

  function textOf(prompt) {
    return Object.values(prompt)
      .flatMap((n) => [n.inputs.value, n.inputs.text, n.inputs.prompt])
      .filter((v) => typeof v === 'string')
      .join(' ');
  }

  function validate(prompt) {
    const info = objectInfo();
    for (const [id, n] of Object.entries(prompt)) {
      if (!info[n.class_type]) return { error: { type: 'missing_node_type', message: `Node '${n.class_type}' not found. The custom node may not be installed.` }, node_errors: {} };
      for (const [name, v] of Object.entries(n.inputs)) {
        if (typeof v !== 'string') continue;
        if (n.class_type === 'LoadImage' && name === 'image') {
          if (!st.uploads.has(v)) return { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' }, node_errors: { [id]: { errors: [{ type: 'custom_validation_failed', message: 'Invalid image file', details: `image - Invalid image file: ${v}` }], class_type: 'LoadImage' } } };
          continue;
        }
        const spec = info[n.class_type].input.required?.[name] ?? info[n.class_type].input.optional?.[name];
        if (spec && Array.isArray(spec[0]) && /\.safetensors$/.test(v) && !spec[0].includes(v)) {
          return { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' }, node_errors: { [id]: { errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: `${name}: '${v}' not in [...]`, extra_info: { input_name: name, received_value: v } }], class_type: n.class_type } } };
        }
      }
    }
    return null;
  }

  function execute(job) {
    const { id, clientId, prompt } = job;
    st.running = job;
    const text = textOf(prompt);
    const slow = text.includes('#slow');
    const oom = text.includes('#oom');
    const saves = Object.entries(prompt).filter(([, n]) => n.class_type === 'SaveVideo' || n.class_type === 'SaveImage');
    const save = saves[0];
    const image = save?.[1].class_type === 'SaveImage';
    const llm = Object.values(prompt).find((n) => n.class_type === 'TextGenerate');
    const samplers = Object.entries(prompt).filter(([, n]) => /Sampler/.test(n.class_type) && !/Select/.test(n.class_type)).map(([k]) => k);
    const steps = slow ? 40 : 6;
    const tick = T(slow ? 300 : 60);
    const audio = Object.values(prompt).some((n) => n.class_type === 'LTXVAudioVAEDecode');
    const timers = [];
    job.timers = timers;
    let t = T(50);
    const at = (fn) => timers.push(setTimeout(fn, (t += tick)));
    at(() => emit(clientId, { type: 'execution_start', data: { prompt_id: id, timestamp: Date.now() } }));
    at(() => emit(clientId, { type: 'execution_cached', data: { nodes: [], prompt_id: id, timestamp: Date.now() } }));
    for (const s of samplers.length ? samplers : ['1']) {
      at(() => emit(clientId, { type: 'executing', data: { node: s, display_node: s, prompt_id: id } }));
      for (let i = 1; i <= steps; i++) {
        at(() => emit(clientId, { type: 'progress', data: { value: i, max: steps, prompt_id: id, node: s } }));
        if (i === 3) {
          at(() => {
            const head = Buffer.alloc(8);
            head.writeUInt32BE(1, 0);
            head.writeUInt32BE(1, 4);
            emit(clientId, Buffer.concat([head, PREVIEW]));
          });
        }
        if (oom && i === 2) {
          at(() => {
            const err = { prompt_id: id, node_id: s, node_type: prompt[s]?.class_type ?? 'SamplerCustomAdvanced', executed: [], exception_message: 'CUDA out of memory. Tried to allocate 12.00 GiB. GPU 0 has a total capacity of 31.36 GiB', exception_type: 'torch.OutOfMemoryError', traceback: ['...'], current_inputs: {}, current_outputs: {}, timestamp: Date.now() };
            st.history[id] = { prompt: [0, id, prompt, {}, []], outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', err]] } };
            emit(clientId, { type: 'execution_error', data: err });
            st.running = null;
            for (const x of timers) clearTimeout(x);
            next();
          });
          return;
        }
      }
    }
    at(() => {
      const fixture = audio ? (st.outputCount % 2 ? 'b' : 'a') : 'c';
      st.outputCount++;
      const outputs = {};
      let out = null;
      for (const sv of saves) {
        const prefix = String(sv[1].inputs.filename_prefix ?? 'videogen/out');
        const [sub, base] = prefix.includes('/') ? [prefix.split('/')[0], prefix.split('/').slice(1).join('/')] : ['', prefix];
        const filename = image ? `${base}_${String(st.outputCount).padStart(5, '0')}_.png` : `${base}_${String(st.outputCount).padStart(5, '0')}_${fixture}.mp4`;
        const o = image ? { images: [{ filename, subfolder: sub, type: 'output' }] } : { images: [{ filename, subfolder: sub, type: 'output' }], animated: [true] };
        out ??= o;
        st.outputs.push({ filename, subfolder: sub });
        outputs[sv[0]] = o;
      }
      // Nœud PreviewAny : prompt réellement utilisé (templates LTX) ou texte généré (Qwen 3.5).
      const preview = Object.entries(prompt).find(([, n]) => n.class_type === 'PreviewAny');
      if (preview) outputs[preview[0]] = { text: [llm ? fakeLlm(String(llm.inputs.prompt ?? '')) : `Enhanced: ${text.slice(0, 200)}`] };
      st.history[id] = { prompt: [0, id, prompt, {}, []], outputs, status: { status_str: 'success', completed: true, messages: [['execution_success', { prompt_id: id }]] } };
      if (out) emit(clientId, { type: 'executed', data: { node: save[0], display_node: save[0], output: out, prompt_id: id } });
      emit(clientId, { type: 'execution_success', data: { prompt_id: id, timestamp: Date.now() } });
      emit(clientId, { type: 'executing', data: { node: null, prompt_id: id } });
      st.running = null;
      next();
    });
  }
  function next() {
    const job = st.pending.shift();
    if (job) execute(job);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (st.down || !st.bootAt || (shared.comfyActivePort && req.socket.localPort !== shared.comfyActivePort)) return req.socket.destroy();
    if (req.method === 'OPTIONS') {
      res.writeHead(req.headers.origin === origin ? 204 : 401, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    if (!authed(req, url)) return send(res, 401, 'unauthorized', 'text/plain');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const json = () => JSON.parse(raw.toString() || '{}');
    const p = url.pathname;
    const comfyUp = Date.now() - st.bootAt > T(2000 * st.bootSlow);

    if (p === '/videogen/status') return send(res, 200, agentStatus());
    if (p === '/videogen/log') return send(res, 200, { lines: ['2026-11-08T10:00:00Z VIDEOGEN_BOOT=1', 'Python : /venv/main/bin/python (2.10.0 12.8)', 'HF_TOKEN=hf_…cdef (masqué)'] });
    if (p === '/videogen/files' && req.method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const files = st.outputs.filter((f) => `${f.subfolder}/${f.filename}`.startsWith(prefix)).map((f) => ({ ...f, type: 'output', size: 1000 }));
      return send(res, 200, { files });
    }
    if (p === '/videogen/files/delete' && req.method === 'POST') {
      const files = json().files ?? [];
      st.deletions.push(...files);
      st.outputs = st.outputs.filter((o) => !files.some((f) => f.filename === o.filename));
      return send(res, 200, { deleted: files.map((f) => f.filename), missing: [], refused: [] });
    }
    // LoRA (agent) : même validation que instance/agent.py, téléchargement simulé.
    if (p === '/videogen/loras' && req.method === 'GET') return send(res, 200, { loras: st.loras, jobs: st.loraJobs.filter((j) => j.state !== 'done'), bases: ['ltx25', 'flux2dev'], max_bytes: 6 * 2 ** 30 });
    if (p === '/videogen/loras' && req.method === 'POST') {
      const b = json();
      if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(b.repo ?? '')) return send(res, 400, { error: 'bad_repo', message: 'dépôt Hugging Face invalide' });
      if (!/\.safetensors$/.test(b.path ?? '') || String(b.path).split('/').includes('..')) return send(res, 400, { error: 'bad_path', message: 'seules les LoRA au format .safetensors sont acceptées' });
      if (!['ltx25', 'flux2dev'].includes(b.base)) return send(res, 400, { error: 'bad_base', message: 'modèle de base inconnu' });
      if (/gated/.test(b.repo)) return send(res, 400, { error: 'hf', message: `accès refusé à ${b.repo} : accepte la licence sur huggingface.co` });
      const stem = String(b.path).split('/').pop().replace(/\.safetensors$/, '');
      const file = `${b.repo.split('/')[1]}__${stem}`.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[._]+|[._]+$/g, '').slice(0, 120) + '.safetensors';
      if (st.loras.some((l) => l.file === file)) return send(res, 200, { name: `videogen/${file}`, state: 'done', already: true });
      const job = { name: `videogen/${file}`, file, repo: b.repo, path: b.path, revision: b.revision ?? 'main', base: b.base, state: 'downloading', size: 300e6, done: 0, error: null };
      st.loraJobs.push(job);
      setTimeout(() => (job.done = 150e6), T(500));
      setTimeout(() => {
        job.state = 'done';
        job.done = job.size;
        st.loras.push({ name: job.name, file, size: job.size, base: job.base, repo: job.repo, path: job.path, revision: job.revision, added: Date.now() / 1000 });
      }, T(1500));
      return send(res, 202, job);
    }
    if (p === '/videogen/loras/delete' && req.method === 'POST') {
      const name = String(json().name ?? '');
      const before = st.loras.length;
      st.loras = st.loras.filter((l) => l.name !== name);
      return before === st.loras.length ? send(res, 404, { error: 'not_found', message: 'LoRA introuvable' }) : send(res, 200, { deleted: name });
    }
    if (!comfyUp) return send(res, 502, 'Bad Gateway', 'text/plain');

    if (p === '/system_stats') return send(res, 200, { system: { comfyui_version: '0.44.2' }, devices: [{ name: 'cuda:0 NVIDIA RTX PRO 6000', vram_total: 96e9, vram_free: 90e9 }] });
    if (p === '/object_info') return send(res, 200, objectInfo());
    if (p === '/queue' && req.method === 'GET') return send(res, 200, { queue_running: st.running ? [[0, st.running.id]] : [], queue_pending: st.pending.map((j, i) => [i + 1, j.id]) });
    if (p === '/queue' && req.method === 'POST') {
      const del = json().delete ?? [];
      st.pending = st.pending.filter((j) => !del.includes(j.id));
      return send(res, 200, {});
    }
    if (p === '/interrupt' && req.method === 'POST') {
      const pid = json().prompt_id;
      const job = st.running;
      if (job && (!pid || pid === job.id)) {
        for (const x of job.timers ?? []) clearTimeout(x);
        st.running = null;
        st.history[job.id] = { prompt: [0, job.id, job.prompt, {}, []], outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_interrupted', { prompt_id: job.id }]] } };
        emit(job.clientId, { type: 'execution_interrupted', data: { prompt_id: job.id, node_id: '1', node_type: 'KSampler', executed: [] } });
        next();
      }
      return send(res, 200, {});
    }
    if (p === '/upload/image' && req.method === 'POST') {
      const text = raw.toString('latin1');
      const name = text.match(/filename="([^"]+)"/)?.[1] ?? 'image.png';
      const sub = text.match(/name="subfolder"\r\n\r\n([^\r]*)/)?.[1] ?? '';
      st.uploads.add(sub ? `${sub}/${name}` : name);
      return send(res, 200, { name, subfolder: sub, type: 'input' });
    }
    if (p === '/prompt' && req.method === 'POST') {
      const body = json();
      st.prompts.push(body);
      if (textOf(body.prompt).includes('#missing')) {
        return send(res, 400, { error: { type: 'missing_node_type', message: "Node 'LTXVMagicNode' not found. The custom node may not be installed.", details: 'Node ID #77' }, node_errors: {} });
      }
      const invalid = validate(body.prompt);
      if (invalid) return send(res, 400, invalid);
      const id = crypto.randomUUID();
      const job = { id, clientId: body.client_id, prompt: body.prompt };
      // Une seule tâche à la fois, comme ComfyUI : la suivante attend dans la file.
      if (st.running) st.pending.push(job);
      else {
        st.running = job;
        setTimeout(() => execute(job), T(30));
      }
      return send(res, 200, { prompt_id: id, number: st.prompts.length, node_errors: {} });
    }
    let m;
    if ((m = p.match(/^\/history\/(.+)$/))) {
      const h = st.history[decodeURIComponent(m[1])];
      return send(res, 200, h ? { [m[1]]: h } : {});
    }
    if (p === '/view') {
      const fn = url.searchParams.get('filename') ?? '';
      st.views.push(fn);
      if (/\.png$/.test(fn) && st.outputs.some((o) => o.filename === fn)) {
        res.writeHead(200, { 'Content-Type': 'image/png', ...cors });
        return res.end(PANEL);
      }
      const key = fn.match(/_([abc])\.mp4$/)?.[1];
      if (!key) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': 'video/mp4', ...cors });
      return res.end(FIXTURES[key]);
    }
    return send(res, 404, { error: 'mock: route inconnue', path: p });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (st.down || url.pathname !== '/ws' || !authed(req, url) || (shared.comfyActivePort && req.socket.localPort !== shared.comfyActivePort)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const cid = url.searchParams.get('clientId') ?? 'anon';
      if (!sockets.has(cid)) sockets.set(cid, new Set());
      sockets.get(cid).add(ws);
      ws.send(JSON.stringify({ type: 'status', data: { status: { exec_info: { queue_remaining: st.pending.length + (st.running ? 1 : 0) } }, sid: cid } }));
      ws.on('close', () => sockets.get(cid)?.delete(ws));
    });
  });
  return server;
}
