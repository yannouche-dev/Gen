// Garde l'écran allumé pendant le démarrage de l'instance et les générations (Screen Wake Lock API,
// Chrome Android et Safari iOS 16.4+). Si le téléphone est verrouillé quand même, le travail continue
// sur l'instance et l'interface reprend le suivi au réveil.
import { journal } from './journal.ts';

const reasons = new Set<string>();
let sentinel: { release(): Promise<void>; addEventListener(t: 'release', cb: () => void): void } | null = null;
let pending = false;

async function acquire(): Promise<void> {
  if (sentinel || pending || !reasons.size || document.visibilityState !== 'visible') return;
  const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<NonNullable<typeof sentinel>> } }).wakeLock;
  if (!wl) return;
  pending = true;
  try {
    sentinel = await wl.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
    journal.debug('app', `Écran maintenu allumé (${[...reasons].join(', ')})`);
  } catch {
    /* refusé (économie d'énergie…) : sans conséquence, le suivi reprend au réveil */
  } finally {
    pending = false;
  }
}

export function holdAwake(reason: string): void {
  reasons.add(reason);
  void acquire();
}

export function releaseAwake(reason: string): void {
  reasons.delete(reason);
  if (!reasons.size && sentinel) {
    const s = sentinel;
    sentinel = null;
    void s.release().catch(() => undefined);
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void acquire();
  });
}
