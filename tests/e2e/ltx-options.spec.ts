// Vue Générer enrichie : capacités du modèle, assistant de prompt, options LTX-2.5 (son, force des images clés,
// créativité de l'amélioration), image clé intermédiaire, variantes, prompt amélioré affiché.
import { test, expect, type Page } from '@playwright/test';
import { enterKeys, rentAndWaitReady, resetMocks, mockState } from './helpers.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const file = (name: string) => ({ name, mimeType: 'image/png', buffer: PNG });
async function setRange(page: Page, testid: string, value: string) {
  await page.getByTestId(testid).evaluate((el: HTMLInputElement, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

test.beforeEach(async () => {
  await resetMocks();
});

test('options LTX-2.5 : images clés, son coupé, créativité, 2 variantes, prompt amélioré', async ({ page }) => {
  await enterKeys(page);
  await rentAndWaitReady(page);
  await page.getByTestId('tab-generate').click();
  await page.getByTestId('model-select').selectOption('ltx25-flf2v');
  await expect(page.getByTestId('model-caps')).toContainText('son généré');
  await expect(page.getByTestId('model-caps')).toContainText('image clé intermédiaire');

  // Assistant de prompt
  await page.getByTestId('prompt').fill('A robot hand opens slowly');
  await page.getByTestId('prompt-assistant').locator('summary').click();
  await page.getByTestId('chip-Travelling avant').click();
  await page.getByTestId('chip-Ambiance').click();
  await expect(page.getByTestId('prompt')).toHaveValue(/dolly-in.*ambient sound/s);

  // Images : début, intermédiaire (à 2 s), fin
  await page.getByTestId('startImage').setInputFiles(file('start.png'));
  await page.getByTestId('middleImage').setInputFiles(file('middle.png'));
  await page.getByTestId('endImage').setInputFiles(file('end.png'));
  await setRange(page, 'middleAt', '2');

  // Options du modèle
  await expect(page.getByTestId('extra-enhanceCreativity')).toHaveCount(0);
  await page.getByTestId('enhancePrompt').check();
  await setRange(page, 'extra-enhanceCreativity', '1.1');
  await page.getByTestId('extra-audio').uncheck();
  await setRange(page, 'extra-guideStrength', '0.9');
  await page.getByTestId('variants').selectOption('2');
  await page.getByTestId('generate').click();

  await page.getByTestId('tab-gallery').click();
  await expect(page.getByTestId('gallery-grid').locator('.tile')).toHaveCount(2, { timeout: 90_000 });

  const prompts = (await mockState()).comfy!.lastPrompts.slice(-2);
  for (const p of prompts) {
    expect(p['vg-mid:guide'].class_type).toBe('LTXVAddGuide');
    expect(p['vg-mid:guide'].inputs.frame_idx).toBe(48); // 2 s × 24 i/s
    expect(p['251:204'].inputs.positive).toEqual(['vg-mid:guide', 0]);
    expect(p['251:206'].inputs.strength).toBe(0.9);
    expect(p['251:204'].inputs.strength).toBe(0.9);
    expect('audio' in p['251:218'].inputs).toBe(false);
    expect(p['251:250'].inputs.value).toBe(true);
    expect(p['251:247'].inputs['sampling_mode.temperature']).toBe(1.1);
  }
  expect(prompts[0]['251:196'].inputs.noise_seed).not.toBe(prompts[1]['251:196'].inputs.noise_seed);

  // Résultat : prompt amélioré affiché, sans son
  await page.getByTestId('tab-generate').click();
  await expect(page.getByTestId('enhanced-prompt')).toContainText('Prompt utilisé');
  await expect(page.getByTestId('gen-result')).not.toContainText('avec son');
});
