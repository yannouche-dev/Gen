// Étapes de démarrage détaillées : avancement global, sous-tâches de l'installation (dépendances pip, démarrage
// de ComfyUI), débit et temps restant des modèles, durée de chaque étape.
import { test, expect, type Page } from '@playwright/test';
import { enterKeys, resetMocks, MOCK } from './helpers.ts';

test.beforeEach(async () => {
  await resetMocks();
});

/** Relève les textes successifs d'un élément (les étapes changent vite). */
async function watchText(page: Page, testid: string) {
  await page.evaluate((id) => {
    const w = window as unknown as { __seen: Record<string, string[]> };
    w.__seen ??= {};
    w.__seen[id] = [];
    setInterval(() => {
      const t = document.querySelector(`[data-testid="${id}"]`)?.textContent;
      const list = w.__seen[id];
      if (t && list[list.length - 1] !== t) list.push(t);
    }, 50);
  }, testid);
}
const seen = (page: Page, testid: string) => page.evaluate((id) => (window as unknown as { __seen: Record<string, string[]> }).__seen[id], testid);

test('étapes détaillées : dépendances, démarrage de ComfyUI, débit et temps restant, durées', async ({ page }) => {
  await enterKeys(page);
  await fetch(`${MOCK}/__mock/slow-boot`, { method: 'POST', body: JSON.stringify({ factor: 8 }) });
  await page.getByTestId('tab-instance').click();
  for (const id of ['step-detail-comfy', 'step-detail-models', 'boot-percent']) await watchText(page, id);
  await page.getByTestId('start').click();
  await page.getByTestId('offer-502').click();
  await page.getByTestId('dialog-ok').click();

  await expect(page.getByTestId('boot-overall')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('step-progress-comfy')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('phase')).toHaveText('Prête', { timeout: 90_000 });

  const comfy = await seen(page, 'step-detail-comfy');
  expect(comfy.some((t) => /^Installation : dépendances : \d+ paquet\(s\) analysé\(s\)/.test(t))).toBe(true);
  expect(comfy.some((t) => /^Installation : (téléchargement|installation de \d+ paquet)/.test(t))).toBe(true);
  expect(comfy.some((t) => /^Démarrage : chargement… \d+ s · Starting server/.test(t))).toBe(true);
  expect(comfy.at(-1)).toBe('ComfyUI v0.44.2');
  const models = await seen(page, 'step-detail-models');
  expect(models.some((t) => /\d+ % · [\d,]+ \/ [\d,]+ Go · [\d,]+ [MG]o\/s · reste ≈ \d+ (s|min)/.test(t))).toBe(true);
  const pct = (await seen(page, 'boot-percent')).map((t) => Number(t.replace(/\D/g, '')));
  expect(pct.length).toBeGreaterThan(3);
  expect(pct.every((v, i) => i === 0 || v >= pct[i - 1] - 1)).toBe(true); // l'avancement global ne recule pas
  await expect(page.getByTestId('boot-overall')).toBeHidden();
  for (const id of ['container', 'tools', 'tunnel', 'comfy', 'models']) {
    await expect(page.locator(`[data-step="${id}"] .step-time`)).toHaveText(/^\d+ s$|^\d+:\d\d$/);
  }
});
