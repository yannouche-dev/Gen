// Lance l'environnement de test complet : site (dist-test), mock Vast + HF, Worker (proxy réel exécuté dans
// Node), mock de l'instance (Caddy + ComfyUI + agent). Usage : npm run mocks
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createVastMock } from './mock-vast.mjs';
import { createComfyMock } from './mock-comfy.mjs';
import { startWorker } from '../worker/dev-server.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const PORTS = { site: 4173, vast: 4310, worker: 4311, comfy: 4312, comfy2: 4313 };
const ORIGIN = `http://127.0.0.1:${PORTS.site}`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.sh': 'text/plain', '.py': 'text/plain' };

function staticServer(dir) {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = path.normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(dir, p);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

export async function startAll({ speed = Number(process.env.MOCK_SPEED || 1) } = {}) {
  const comfyUrl1 = `http://127.0.0.1:${PORTS.comfy}`;
  // Seconde adresse du même faux ComfyUI : simule un nouveau tunnel (cloudflared redémarré).
  const shared = { vastUrl: `http://127.0.0.1:${PORTS.vast}`, comfyUrl: comfyUrl1, comfyUrl1, comfyUrl2: `http://127.0.0.1:${PORTS.comfy2}`, comfyActivePort: null };
  const servers = [];
  servers.push(await listen(staticServer(path.join(ROOT, 'dist-test')), PORTS.site));
  servers.push(await listen(createVastMock({ shared, origin: ORIGIN, speed }), PORTS.vast));
  const comfy = createComfyMock({ shared, origin: ORIGIN, speed });
  servers.push(await listen(comfy, PORTS.comfy));
  const comfy2 = http.createServer((req, res) => comfy.emit('request', req, res));
  comfy2.on('upgrade', (req, socket, head) => comfy.emit('upgrade', req, socket, head));
  servers.push(await listen(comfy2, PORTS.comfy2));
  servers.push(
    await startWorker({
      port: PORTS.worker,
      env: { ALLOWED_ORIGIN: ORIGIN, VAST_BASE: shared.vastUrl, LOG_URL_PREFIXES: `${shared.vastUrl}/s3/vast.ai/instance_logs/` },
    }),
  );
  return {
    shared,
    close: () => Promise.all(servers.map((s) => new Promise((r) => (s.closeAllConnections?.(), s.close(r))))),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startAll();
  console.log(`Site de test : ${ORIGIN}  (build : npm run build:test)`);
  console.log(`Proxy (Worker) : http://127.0.0.1:${PORTS.worker} · clé Vast de test : test-vast-key-0123456789abcdef · token HF : hf_TestToken0123456789abcdef`);
}
