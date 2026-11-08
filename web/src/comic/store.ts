// Projets de BD conservés DANS LE TÉLÉPHONE (IndexedDB), chiffrés en AES-GCM avec une clé aléatoire de 256 bits
// gardée dans le coffre (elle-même chiffrée par ta phrase de passe). Rien n'est envoyé ailleurs.
import { vault } from '../core/vault.ts';
import { normalizeProject, type Project } from './model.ts';

const DB_NAME = 'videogen-bd';
const enc = new TextEncoder();
const dec = new TextDecoder();
let dbPromise: Promise<IDBDatabase> | null = null;
let cachedKey: { raw: string; key: CryptoKey } | null = null;

interface Sealed {
  id: string;
  projectId?: string;
  iv: Uint8Array<ArrayBuffer>;
  ct: ArrayBuffer;
  mime?: string;
}

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' }).createIndex('project', 'projectId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('IndexedDB indisponible'));
    };
  });
  return dbPromise;
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function key(): Promise<CryptoKey> {
  if (!vault.isUnlocked()) throw new Error('Coffre verrouillé');
  let raw = vault.secrets.projectsKey;
  if (!raw) {
    raw = b64(crypto.getRandomValues(new Uint8Array(32)));
    await vault.update({ projectsKey: raw });
  }
  if (cachedKey?.raw !== raw) {
    cachedKey = { raw, key: await crypto.subtle.importKey('raw', unb64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']) };
  }
  return cachedKey.key;
}

async function seal(data: Uint8Array<ArrayBuffer>): Promise<{ iv: Uint8Array<ArrayBuffer>; ct: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv, ct: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), data) };
}
async function open(s: Sealed): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: s.iv }, await key(), s.ct);
}

function tx<T>(store: 'projects' | 'images', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error ?? new Error('Transaction annulée (stockage plein ?)'));
      }),
  );
}

export async function listProjects(): Promise<Project[]> {
  const rows = await tx<Sealed[]>('projects', 'readonly', (s) => s.getAll() as IDBRequest<Sealed[]>);
  const out: Project[] = [];
  for (const r of rows) {
    try {
      out.push(normalizeProject(JSON.parse(dec.decode(await open(r))) as Project));
    } catch {
      /* chiffré avec une autre clé (coffre recréé) : ignoré */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveProject(p: Project): Promise<void> {
  p.updatedAt = Date.now();
  const sealed = await seal(enc.encode(JSON.stringify(p)));
  await tx('projects', 'readwrite', (s) => s.put({ id: p.id, ...sealed }));
}

export async function deleteProject(p: Project): Promise<void> {
  const ids = await tx<IDBValidKey[]>('images', 'readonly', (s) => s.index('project').getAllKeys(p.id));
  for (const id of ids) await tx('images', 'readwrite', (s) => s.delete(id));
  await tx('projects', 'readwrite', (s) => s.delete(p.id));
}

export async function putImage(projectId: string, blob: Blob): Promise<string> {
  const id = `i${crypto.getRandomValues(new Uint32Array(2)).join('')}`;
  const sealed = await seal(new Uint8Array(await blob.arrayBuffer()));
  await tx('images', 'readwrite', (s) => s.put({ id, projectId, mime: blob.type || 'image/png', ...sealed }));
  return id;
}

export async function getImage(id: string): Promise<Blob | null> {
  const row = await tx<Sealed | undefined>('images', 'readonly', (s) => s.get(id) as IDBRequest<Sealed | undefined>);
  if (!row) return null;
  return new Blob([await open(row)], { type: row.mime || 'image/png' });
}

export async function deleteImage(id: string): Promise<void> {
  await tx('images', 'readwrite', (s) => s.delete(id));
}

/** Efface toute la base (appelé par « Tout effacer »). */
export function wipeComics(): void {
  cachedKey = null;
  const close = dbPromise?.then((db) => db.close()).catch(() => undefined);
  dbPromise = null;
  void Promise.resolve(close).then(() => {
    try {
      indexedDB.deleteDatabase(DB_NAME);
    } catch {
      /* indisponible */
    }
  });
}

/** Réduit une image (PNG reçu de l'instance) en JPEG de qualité pour économiser le stockage du téléphone. */
export async function toJpeg(blob: Blob, quality = 0.92): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close();
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Conversion JPEG impossible'))), 'image/jpeg', quality));
}
