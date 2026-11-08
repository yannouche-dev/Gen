// Générations en cours, mémorisées dans ce navigateur : si le téléphone se met en veille ou si le
// navigateur ferme l'onglet en arrière-plan, la génération continue sur l'instance et l'interface la
// reprend (progression, puis récupération du résultat) à la réouverture.
import { loadJson, saveJson } from './settings.ts';
import type { FileRef } from '../comfy/client.ts';
import type { GenParams } from '../workflows/build.ts';

export interface PendingJob {
  promptId: string;
  instanceId: number;
  modelId: string;
  params: Omit<GenParams, 'startImage' | 'endImage' | 'middleImage' | 'outputPrefix'>;
  outputPrefix: string;
  uploaded: FileRef[];
  startedAt: number;
  parentId?: string;
}

const KEY = 'videogen.pending.v1';

export function listPending(): PendingJob[] {
  return loadJson<PendingJob[]>(KEY, []);
}
export function addPending(job: PendingJob): void {
  saveJson(KEY, [...listPending().filter((j) => j.promptId !== job.promptId), job]);
}
export function removePending(promptId: string): void {
  saveJson(KEY, listPending().filter((j) => j.promptId !== promptId));
}
