// Veille du téléphone : la génération continue sur l'instance et l'interface reprend toujours le suivi,
// que le réseau ait été coupé, que l'onglet ait été fermé, ou que l'historique de ComfyUI ait été perdu.
import { test, expect, type Page } from '@playwright/test';
import { enterKeys, rentAndWaitReady, generate, resetMocks, mockState, MOCK, PASS } from './helpers.ts';

test.beforeEach(async () => {
  await resetMocks();
});

const pending = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('videogen.pending.v1') || '[]').length as number);

async function waitProgress(page: Page) {
  await expect.poll(async () => page.getByTestId('gen-bar').evaluate((b: HTMLProgressElement) => b.value)).toBeGreaterThan(0);
}

async function unlock(page: Page) {
  await expect(page.getByRole('heading', { name: 'Déverrouiller' })).toBeVisible();
  await page.fill('#unlock-pass', PASS);
  await page.getByTestId('unlock').click();
}

test('coupure réseau pendant la génération : jamais d’échec, reprise automatique', async ({ page }) => {
  await enterKeys(page);
  await rentAndWaitReady(page);
  await generate(page, 'a slow fox in the snow #slow');
  await waitProgress(page);
  // Tunnel injoignable (téléphone en veille, réseau mobile perdu…) ; le calcul continue sur l'instance.
  await fetch(`${MOCK}/__mock/comfy-down`, { method: 'POST' });
  // La génération se termine sur l'instance pendant la coupure.
  await expect.poll(async () => (await mockState()).comfy!.outputs.length, { timeout: 30_000 }).toBe(1);
  await expect(page.getByTestId('gen-status')).toContainText('Connexion perdue', { timeout: 15_000 });
  await page.waitForTimeout(3000);
  await expect(page.getByTestId('gen-error')).toHaveCount(0);
  await fetch(`${MOCK}/__mock/comfy-up`, { method: 'POST' });
  await expect(page.getByTestId('result-video')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('gen-error')).toHaveCount(0);
  expect(await pending(page)).toBe(0);
});

test('onglet fermé pendant la génération : reprise et résultat à la réouverture', async ({ page }) => {
  await enterKeys(page);
  await rentAndWaitReady(page);
  await generate(page, 'a slow river at dusk #slow');
  await waitProgress(page);
  expect(await pending(page)).toBe(1);
  await page.reload();
  await unlock(page);
  await page.getByTestId('tab-gallery').click();
  await expect(page.getByTestId('gallery-grid').locator('.tile')).toHaveCount(1, { timeout: 60_000 });
  expect(await pending(page)).toBe(0);
  const st = await mockState();
  expect(st.comfy!.outputs).toHaveLength(0); // supprimée de l'instance après récupération
});

test('historique ComfyUI perdu pendant la veille : vidéo retrouvée par son nom', async ({ page }) => {
  await enterKeys(page);
  await rentAndWaitReady(page);
  await generate(page, 'a slow city at night #slow');
  await waitProgress(page);
  await page.goto('about:blank'); // onglet fermé
  await expect.poll(async () => (await mockState()).comfy!.outputs.length, { timeout: 30_000 }).toBe(1);
  await fetch(`${MOCK}/__mock/forget-history`, { method: 'POST' });
  await page.goto('/');
  await unlock(page);
  await page.getByTestId('tab-gallery').click();
  await expect(page.getByTestId('gallery-grid').locator('.tile')).toHaveCount(1, { timeout: 60_000 });
  expect(await pending(page)).toBe(0);
});
