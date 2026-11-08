import { describe, it, expect } from 'vitest';
import worker from '../../worker/src/index.js';
import { buildOfferQuery, rankOffers } from '../../web/src/vast/offers.ts';
import { buildEnv, buildOnstart, ONSTART_LIMIT } from '../../web/src/vast/onstart.ts';
import { parseBootLog, tunnelFromLabel } from '../../web/src/vast/bootlog.ts';
import { DEFAULT_SETTINGS } from '../../web/src/core/settings.ts';
import type { VastOffer } from '../../web/src/vast/api.ts';

const ORIGIN = 'https://yannouche-dev.github.io';
const env = { ALLOWED_ORIGIN: ORIGIN };

describe('Worker proxy Vast', () => {
  const call = (path: string, init: RequestInit & { origin?: string | null } = {}) => {
    const headers = new Headers(init.headers);
    if (init.origin !== null) headers.set('Origin', init.origin ?? ORIGIN);
    return worker.fetch(new Request(`https://proxy.example${path}`, { ...init, headers }), env);
  };

  it('refuse les autres origines et les requêtes sans origine', async () => {
    expect((await call('/api/v0/users/current/', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('/api/v0/users/current/', { origin: null })).status).toBe(403);
  });
  it('répond aux pré-requêtes CORS de l’origine autorisée', async () => {
    const r = await call('/api/v0/bundles/', { method: 'OPTIONS' });
    expect(r.status).toBe(204);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(r.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });
  it('ne relaie que les routes nécessaires', async () => {
    expect((await call('/api/v0/machines/', { headers: { Authorization: 'Bearer abcdefgh123' } })).status).toBe(404);
    expect((await call('/api/v0/auth/apikeys/', { method: 'POST', headers: { Authorization: 'Bearer abcdefgh123' } })).status).toBe(404);
    expect((await call('/api/v0/instances/1/', { method: 'POST', headers: { Authorization: 'Bearer abcdefgh123' } })).status).toBe(404);
    expect((await call('/api/v0/instances/?api_key=x', { headers: { Authorization: 'Bearer abcdefgh123' } })).status).toBe(404);
    expect((await call('/api/v1/instances/?api_key=x', { headers: { Authorization: 'Bearer abcdefgh123' } })).status).toBe(400);
    expect((await call('/api/v1/instances/?limit=25&q=' + 'x'.repeat(3000), { headers: { Authorization: 'Bearer abcdefgh123' } })).status).toBe(400);
    expect((await call('/api/v0/users/current/')).status).toBe(401);
  });
  it('limite les URL de logs à S3 Vast', async () => {
    expect((await call('/logs?url=' + encodeURIComponent('https://evil.example/x.log'))).status).toBe(400);
    expect((await call('/logs?url=' + encodeURIComponent('https://s3.amazonaws.com/vast.ai/instance_logs/../../x'))).status).toBe(400);
  });
  it('accepte les logs du seau public.vast.ai (constaté en réel) et convertit les exceptions en JSON + CORS', async () => {
    const orig = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input instanceof Request ? input.url : input));
      return new Response('VIDEOGEN_BOOT=1\n', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }) as typeof fetch;
    try {
      const u = 'https://s3.amazonaws.com/public.vast.ai/instance_logs/8affd769f4f2062e2c109732b8b4eb513e1c74314ffc7293c76416f52fe8c3cd.log';
      const r = await call('/logs?url=' + encodeURIComponent(u));
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('VIDEOGEN_BOOT');
      expect(seen[0]).toBe(u);
      globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
      expect((await call('/api/v0/users/current/', { headers: { Authorization: 'Bearer abcdefgh123' } })).status).toBe(204);
    } finally {
      globalThis.fetch = orig;
    }
    const broken = await worker.fetch(new Request('https://proxy.example/api/v0/users/current/', { headers: { Origin: ORIGIN } }), {
      get ALLOWED_ORIGIN(): string {
        throw new Error('boom');
      },
    } as unknown as { ALLOWED_ORIGIN: string });
    expect(broken.status).toBe(502);
  });

  it('relaie vers Vast avec la clé, sans cookie, avec CORS', async () => {
    const seen: Request[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return new Response('{"credit":1}', { status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'a=b' } });
    }) as typeof fetch;
    try {
      const r = await call('/api/v0/users/current/', { headers: { Authorization: 'Bearer abcdefgh123', Cookie: 'x=y' } });
      expect(r.status).toBe(200);
      expect(r.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
      expect(r.headers.get('Set-Cookie')).toBeNull();
      expect(seen[0].url).toBe('https://console.vast.ai/api/v0/users/current/');
      expect(seen[0].headers.get('Authorization')).toBe('Bearer abcdefgh123');
      expect(seen[0].headers.get('Cookie')).toBeNull();
      const q = '?select_filters=%7B%7D&order_by=%5B%7B%22col%22%3A%22id%22%2C%22dir%22%3A%22desc%22%7D%5D&limit=25&after_token=abc';
      const r2 = await call('/api/v1/instances/' + q, { headers: { Authorization: 'Bearer abcdefgh123' } });
      expect(r2.status).toBe(200);
      expect(seen[1].url).toBe('https://console.vast.ai/api/v1/instances/' + q);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('offres Vast', () => {
  const s = DEFAULT_SETTINGS;
  it('requête : on-demand, fiabilité, débit, disque, prix', () => {
    const q = buildOfferQuery(s) as Record<string, any>;
    expect(q.type).toBe('on-demand');
    expect(q.reliability).toEqual({ gte: 0.99 });
    expect(q.inet_down).toEqual({ gte: 500 });
    expect(q.disk_space).toEqual({ gte: 150 });
    expect(q.gpu_name.in).toContain('RTX PRO 6000 WS');
    expect(q.gpu_name.in).toContain('RTX 5090');
    expect(q.num_gpus).toEqual({ eq: 1 });
  });
  it('RTX PRO 6000 d’abord, puis RTX 5090, filtres réappliqués', () => {
    const o = (id: number, gpu_name: string, dph_total: number, extra: Partial<VastOffer> = {}): VastOffer =>
      ({ id, gpu_name, dph_total, num_gpus: 1, gpu_ram: 1, reliability: 0.995, inet_down: 900, disk_space: 500, ...extra }) as VastOffer;
    const r = rankOffers([o(1, 'RTX 5090', 0.5), o(2, 'RTX PRO 6000 WS', 1.3), o(3, 'RTX PRO 6000 S', 1.1), o(4, 'RTX 5090', 0.4, { reliability: 0.95 }), o(5, 'RTX 4090', 0.2)], s);
    expect(r.map((x) => x.id)).toEqual([3, 2, 1]);
  });
});

describe('amorce onstart et environnement', () => {
  const build = {
    test: false,
    repo: 'yannouche-dev/videogen',
    ref: '0123456789abcdef0123456789abcdef01234567',
    instanceBase: '',
    instanceFiles: { 'onstart.sh': 'a'.repeat(64), 'agent.py': 'b'.repeat(64), Caddyfile: 'c'.repeat(64), 'weights.json': 'd'.repeat(64) },
    proxyUrl: '',
    hfBase: '',
    builtAt: '',
  };
  it('tient dans la limite de Vast et vérifie les empreintes au commit exact', () => {
    const s = buildOnstart(build);
    expect(s.length).toBeLessThan(ONSTART_LIMIT);
    expect(s).toContain('https://raw.githubusercontent.com/yannouche-dev/videogen/0123456789abcdef0123456789abcdef01234567/instance');
    expect(s).toContain(`${'a'.repeat(64)}  onstart.sh.new`);
    expect(s).toContain('sha256sum -c');
  });
  it('n’a ni clé Vast ni « ; » dans l’environnement', () => {
    const e = buildEnv({ hfToken: 'hf_x0123456789', comfyToken: 'tok_0123456789', allowedOrigin: ORIGIN, idleMinutes: 20, maxHours: 4, families: ['ltx25', 'wan22'], comfyVersion: 'v0.44.2' });
    expect(Object.keys(e).sort()).toEqual(['ALLOWED_ORIGIN', 'COMFY_ACCESS_TOKEN', 'COMFY_VERSION', 'HF_TOKEN', 'IDLE_MINUTES', 'MAX_HOURS', 'MODELS']);
    expect(e.MODELS).toBe('ltx25,wan22');
    expect(() => buildEnv({ hfToken: 'a;b', comfyToken: 'x', allowedOrigin: ORIGIN, idleMinutes: 1, maxHours: 1, families: [], comfyVersion: 'v' })).toThrow(/;/);
  });
});

describe('logs de démarrage', () => {
  it('prend le dernier démarrage et son URL de tunnel', () => {
    const log = [
      'VIDEOGEN_BOOT=100',
      'VIDEOGEN_TUNNEL_URL=https://old-words-here.trycloudflare.com',
      'VIDEOGEN_STEP=auto_stop:file vide depuis 20 min',
      'VIDEOGEN_BOOT=200',
      'bruit sans rapport https://evil.example',
      'VIDEOGEN_STEP=tools:done',
      'VIDEOGEN_STEP=comfy_install:error clonage de ComfyUI impossible',
      'VIDEOGEN_TUNNEL_URL=https://new-words-here.trycloudflare.com',
    ].join('\n');
    const b = parseBootLog(log);
    expect(b.bootTs).toBe(200);
    expect(b.tunnelUrl).toBe('https://new-words-here.trycloudflare.com');
    expect(b.steps.comfy_install).toEqual({ state: 'error', msg: 'clonage de ComfyUI impossible' });
    expect(b.autoStop).toBeNull();
  });
  it('n’accepte que des URL trycloudflare', () => {
    expect(parseBootLog('VIDEOGEN_TUNNEL_URL=https://evil.example').tunnelUrl).toBeNull();
    expect(tunnelFromLabel('videogen https://a-b-c.trycloudflare.com')).toBe('https://a-b-c.trycloudflare.com');
    expect(tunnelFromLabel('videogen')).toBeNull();
  });
});
