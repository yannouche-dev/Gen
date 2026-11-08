// Client de l'API REST Vast.ai (via le Worker proxy : l'API Vast n'autorise pas les appels navigateur).
// Routes vérifiées dans la documentation officielle (docs.vast.ai, novembre 2026).
import { request, requestJson, HttpError } from '../core/http.ts';

export interface VastOffer {
  id: number;
  gpu_name: string;
  num_gpus: number;
  gpu_ram: number;
  dph_total: number;
  reliability?: number;
  reliability2?: number;
  inet_down: number;
  inet_up?: number;
  disk_space: number;
  geolocation?: string;
  cuda_max_good?: number;
  storage_cost?: number;
  verification?: string;
  machine_id?: number;
  datacenter?: unknown;
  [k: string]: unknown;
}

export interface VastInstance {
  id: number;
  label?: string | null;
  actual_status?: string | null;
  intended_status?: string | null;
  cur_state?: string | null;
  status_msg?: string | null;
  gpu_name?: string;
  num_gpus?: number;
  dph_total?: number;
  disk_space?: number;
  start_date?: number;
  uptime_mins?: number | null;
  storage_cost?: number;
  extra_env?: [string, string][];
  image_uuid?: string;
  geolocation?: string;
  [k: string]: unknown;
}

export interface CreateBody {
  image: string;
  disk: number;
  label: string;
  runtype: 'ssh' | 'args' | 'jupyter';
  onstart: string;
  env: Record<string, string>;
  target_state?: 'running' | 'stopped';
  cancel_unavail?: boolean;
}

export class VastApi {
  private base: string;
  private getKey: () => string;
  constructor(proxyUrl: string, getKey: () => string) {
    this.base = proxyUrl.replace(/\/+$/, '');
    this.getKey = getKey;
  }

  private headers(): Record<string, string> {
    const key = this.getKey();
    if (!key) throw new HttpError('http', 'Clé API Vast manquante', this.base, 401);
    return { Authorization: `Bearer ${key}` };
  }

  currentUser(quiet = false): Promise<{ id?: number; email?: string; credit?: number; balance?: number; username?: string }> {
    return requestJson(`${this.base}/api/v0/users/current/`, { cat: 'vast', headers: this.headers(), quiet });
  }

  async searchOffers(query: Record<string, unknown>): Promise<VastOffer[]> {
    const res = await requestJson<{ offers?: VastOffer[] }>(`${this.base}/api/v0/bundles/`, {
      cat: 'vast',
      method: 'POST',
      headers: this.headers(),
      json: query,
    });
    return res.offers ?? [];
  }

  async createInstance(offerId: number, body: CreateBody): Promise<{ success: boolean; new_contract: number; instance_api_key?: string }> {
    return requestJson(`${this.base}/api/v0/asks/${offerId}/`, {
      cat: 'vast',
      method: 'PUT',
      headers: this.headers(),
      json: body,
      timeoutMs: 60000,
    });
  }

  /** Liste v1 paginée (GET /api/v1/instances/) : /api/v0/instances/ répond désormais 410 « deprecated ». */
  async listInstances(quiet = false, selectFilters: Record<string, unknown> = {}): Promise<VastInstance[]> {
    const out: VastInstance[] = [];
    let after: string | null = null;
    // On suit TOUTES les pages : aucune instance ne doit passer inaperçue.
    for (let page = 0; page < 200; page++) {
      const q = new URLSearchParams({
        select_filters: JSON.stringify(selectFilters),
        order_by: JSON.stringify([{ col: 'id', dir: 'desc' }]),
        limit: '25',
      });
      if (after) q.set('after_token', after);
      const res: { instances?: VastInstance[]; next_token?: string | null } = await requestJson(`${this.base}/api/v1/instances/?${q}`, {
        cat: 'vast',
        headers: this.headers(),
        quiet,
      });
      out.push(...(res.instances ?? []));
      after = res.next_token || null;
      if (!after) return out;
    }
    throw new HttpError('http', 'Liste des instances incomplète (plus de 200 pages)', this.base);
  }

  /** Détail d'une instance (v0, encore utilisé par la CLI officielle) ; repli sur la liste v1 si retiré. */
  async getInstance(id: number, quiet = false): Promise<VastInstance | null> {
    try {
      const res = await requestJson<{ instances?: VastInstance | null }>(`${this.base}/api/v0/instances/${id}/?owner=me`, {
        cat: 'vast',
        headers: this.headers(),
        quiet,
        silentStatuses: [410],
      });
      return res.instances ?? null;
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 410) throw e;
      const list = await this.listInstances(quiet, { id: { eq: id } });
      return list.find((i) => i.id === id) ?? null;
    }
  }

  setState(id: number, state: 'running' | 'stopped'): Promise<{ success?: boolean }> {
    return requestJson(`${this.base}/api/v0/instances/${id}/`, { cat: 'vast', method: 'PUT', headers: this.headers(), json: { state } });
  }

  setLabel(id: number, label: string): Promise<{ success?: boolean }> {
    return requestJson(`${this.base}/api/v0/instances/${id}/`, { cat: 'vast', method: 'PUT', headers: this.headers(), json: { label } });
  }

  destroy(id: number): Promise<{ success?: boolean }> {
    return requestJson(`${this.base}/api/v0/instances/${id}/`, { cat: 'vast', method: 'DELETE', headers: this.headers() });
  }

  /** Demande les logs du conteneur puis les lit (l'URL S3 renvoyée n'est prête qu'après quelques secondes). */
  async logs(id: number, opts: { tail?: number; filter?: string } = {}): Promise<string> {
    const body: Record<string, string> = { tail: String(opts.tail ?? 400) };
    if (opts.filter) body.filter = opts.filter;
    const res = await requestJson<{ success?: boolean; result_url?: string; msg?: string }>(
      `${this.base}/api/v0/instances/request_logs/${id}/`,
      { cat: 'vast', method: 'PUT', headers: this.headers(), json: body, quiet: true },
    );
    if (!res.result_url) throw new HttpError('http', res.msg || 'Pas d’URL de logs', this.base);
    const url = `${this.base}/logs?url=${encodeURIComponent(res.result_url)}`;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? 700 : 1000));
      try {
        const r = await request(url, { cat: 'vast', quiet: true, timeoutMs: 15000, silentStatuses: [403, 404] });
        return await r.text();
      } catch (e) {
        if (!(e instanceof HttpError) || (e.status !== 403 && e.status !== 404)) throw e;
      }
    }
    throw new HttpError('timeout', 'Logs non disponibles', url);
  }
}
