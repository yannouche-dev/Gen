// Parcours de test léger : seule la famille « Test minimal : Wan 2.1 1.3B » (≈ 10 Go) est installée.
import { test, expect } from '@playwright/test';
import { enterKeys, rentAndWaitReady, generate, resetMocks, mockState } from './helpers.ts';

test.beforeEach(async () => {
  await resetMocks();
});

test('famille de test minimale : location, génération Wan 2.1 1.3B, LTX grisé', async ({ page }) => {
  await enterKeys(page);
  await page.locator('details', { hasText: 'Réglages de location' }).locator('summary').click();
  await page.getByTestId('family-ltx25').uncheck();
  await page.getByTestId('family-wan21s').check();
  await rentAndWaitReady(page, 503);
  expect((await mockState()).creates[0].body.env.MODELS).toBe('wan21s');

  await page.getByTestId('tab-generate').click();
  const select = page.getByTestId('model-select');
  const disabled = (v: string) => select.locator(`option[value="${v}"]`).evaluate((o: HTMLOptionElement) => o.disabled);
  await expect.poll(() => disabled('ltx25-t2v')).toBe(true);
  expect(await disabled('wan21-1.3b-t2v')).toBe(false);
  await select.selectOption('wan21-1.3b-t2v');
  await expect(page.getByTestId('size')).toHaveText('848 × 480');
  await expect(page.locator('#steps')).toHaveCount(1); // ce modèle expose steps et CFG (options avancées)
  await generate(page, 'a small paper boat on a pond');
  await expect(page.getByTestId('result-video')).toBeVisible({ timeout: 60_000 });

  // Prolonger : pas de modèle image → vidéo installé → message clair
  await page.getByTestId('extend').click();
  await expect(page.locator('.toast-error', { hasText: 'Aucun modèle image → vidéo' })).toBeVisible();
});
