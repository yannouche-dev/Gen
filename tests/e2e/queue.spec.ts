// File d'attente vidéo : toutes les vidéos partent tout de suite sur l'instance (GPU sans temps mort),
// on peut en ajouter pendant le calcul et en retirer une de la file.
import { test, expect } from '@playwright/test';
import { enterKeys, rentAndWaitReady, generate, resetMocks, mockState } from './helpers.ts';

test.beforeEach(async () => {
  await resetMocks();
});

test('file d’attente : variantes envoyées d’un coup, ajout pendant le calcul, retrait d’une vidéo', async ({ page }) => {
  await enterKeys(page);
  await rentAndWaitReady(page);
  await page.getByTestId('tab-generate').click();
  await page.getByTestId('variants').selectOption('2');
  await generate(page, 'a red fox in the snow #slow');
  // Les deux variantes sont dans la file de ComfyUI pendant que la première tourne.
  await expect.poll(async () => (await mockState()).comfy!.prompts, { timeout: 15_000 }).toBe(2);
  expect((await mockState()).comfy!.running).toBe(true);
  await expect(page.getByTestId('queue-item')).toHaveCount(1);
  await expect(page.getByTestId('generate')).toHaveText('Ajouter à la file (2 en cours)');

  // Ajout pendant le calcul, puis retrait de la file.
  await page.getByTestId('variants').selectOption('1');
  await page.getByTestId('prompt').fill('a heron on a lake');
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('queue-item')).toHaveCount(2);
  await expect.poll(async () => (await mockState()).comfy!.prompts).toBe(3);
  await expect(page.getByTestId('queue-item').last()).toContainText('heron');
  await page.getByTestId('queue-cancel').last().click();
  await expect(page.getByTestId('queue-item')).toHaveCount(1);
  await expect(page.locator('.toast', { hasText: 'Annulée' })).toBeVisible();

  await page.getByTestId('tab-gallery').click();
  await expect(page.getByTestId('gallery-grid').locator('.tile')).toHaveCount(2, { timeout: 90_000 });
  const st = await mockState();
  expect(st.comfy!.running).toBe(false);
  expect(st.comfy!.outputs).toHaveLength(0); // récupérées puis supprimées de l'instance
});
