// LoRA Hugging Face : installation sur l'instance (dépôt ou lien direct), refus, utilisation dans Générer (LTX-2.5)
// et dans le Style du Studio BD (FLUX.2), suppression, réinstallation sur une instance qui ne les a pas.
import { test, expect, type Page } from '@playwright/test';
import { enterKeys, rentAndWaitReady, generate, resetMocks, mockState, PASS } from './helpers.ts';

async function setRange(page: Page, testid: string, value: string) {
  await page.getByTestId(testid).evaluate((el: HTMLInputElement, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
const saved = (page: Page) => page.evaluate(() => (JSON.parse(localStorage.getItem('videogen.settings.v1') || '{}').savedLoras ?? []).length as number);

test.beforeEach(async () => {
  await resetMocks();
});

test('LoRA : installation depuis Hugging Face, Générer (LTX) et Studio BD (FLUX.2), suppression, réinstallation', async ({ page }) => {
  await enterKeys(page);
  await rentAndWaitReady(page);
  const card = page.getByTestId('lora-card');
  await expect(card).toContainText('Aucune LoRA installée');

  // Lien vers un dépôt : choix du fichier, base devinée (LTX)
  await page.getByTestId('lora-link').fill('https://huggingface.co/org/ltx-ink');
  await page.getByTestId('lora-link').press('Tab');
  await expect(page.getByTestId('lora-base')).toHaveValue('ltx25');
  await page.getByTestId('lora-install').click();
  await expect(page.getByTestId('lora-file').locator('option')).toHaveCount(2);
  await page.getByTestId('lora-file').selectOption('v2/ltx25-ink-style-v2.safetensors');
  await page.getByTestId('lora-install').click();
  await expect(page.getByTestId('lora-item')).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId('lora-item')).toContainText('ltx-ink__ltx25-ink-style-v2');
  await expect(page.getByTestId('lora-item')).toContainText('LTX-2.5');

  // Lien direct vers un fichier FLUX.2
  await page.getByTestId('lora-link').fill('https://huggingface.co/org/flux2-comic-ink/blob/main/ink.safetensors');
  await page.getByTestId('lora-link').press('Tab');
  await expect(page.getByTestId('lora-base')).toHaveValue('flux2dev');
  await page.getByTestId('lora-install').click();
  await expect(page.getByTestId('lora-item')).toHaveCount(2, { timeout: 20_000 });
  expect(await saved(page)).toBe(2);

  // Refus : dépôt protégé (licence non acceptée), autre site
  await page.getByTestId('lora-link').fill('https://huggingface.co/org/gated-lora/blob/main/x.safetensors');
  await page.getByTestId('lora-install').click();
  await expect(page.locator('.toast-error', { hasText: 'accès refusé' })).toBeVisible();
  await page.getByTestId('lora-link').fill('https://civitai.com/models/1234');
  await page.getByTestId('lora-install').click();
  await expect(page.locator('.toast-error', { hasText: 'Seuls les liens huggingface.co' })).toBeVisible();
  await expect(page.getByTestId('lora-item')).toHaveCount(2);

  // Générer (LTX-2.5) : seule la LoRA LTX est proposée, branchée entre le modèle et les guiders
  await page.getByTestId('tab-generate').click();
  await page.getByTestId('lora-add').click();
  await expect(page.getByTestId('lora-name-1').locator('option')).toHaveCount(1);
  await setRange(page, 'lora-strength-1', '0.6');
  await generate(page, 'a lighthouse in the fog');
  await expect(page.getByTestId('result-video')).toBeVisible({ timeout: 60_000 });
  let wf = (await mockState()).comfy!.lastPrompts.at(-1)!;
  expect(wf['vg-lora1'].inputs).toEqual({ model: ['405:384', 0], lora_name: 'videogen/ltx-ink__ltx25-ink-style-v2.safetensors', strength_model: 0.6 });
  expect(Object.values(wf).filter((n) => n.class_type === 'LTXVDualCFGGuider').map((n) => n.inputs.model)).toEqual([['vg-lora1', 0], ['vg-lora1', 0]]);

  // Studio BD : LoRA de style FLUX.2 appliquée aux cases (avant la LoRA Turbo)
  await page.getByTestId('tab-comic').click();
  page.once('dialog', (d) => d.accept('Encre'));
  await page.getByTestId('new-project').click();
  await page.getByTestId('step-style').click();
  await page.getByTestId('style-lora-add').click();
  await expect(page.getByTestId('style-lora-name-1').locator('option')).toHaveCount(1);
  await setRange(page, 'style-lora-strength-1', '0.85');
  await page.getByTestId('step-story').click();
  await page.getByTestId('add-page').click();
  await page.getByTestId('panel-desc-1').fill('a quiet harbor at dawn');
  await page.getByTestId('panel-gen-1').click();
  await expect(page.getByTestId('panel-status-1')).toContainText('Image prête', { timeout: 60_000 });
  wf = (await mockState()).comfy!.lastPrompts.at(-1)!;
  expect(wf['vg-lora1'].inputs).toEqual({ model: ['62:12', 0], lora_name: 'videogen/flux2-comic-ink__ink.safetensors', strength_model: 0.85 });
  expect(wf['62:88'].inputs.model).toEqual(['vg-lora1', 0]);

  // Suppression : effacée de l'instance et oubliée par le navigateur
  await page.getByTestId('tab-instance').click();
  await page.getByTestId('lora-delete').first().click();
  await page.getByTestId('dialog-ok').click();
  await expect(page.getByTestId('lora-item')).toHaveCount(1);
  expect(await saved(page)).toBe(1);

  // Nouvelle instance sans les LoRA mémorisées : bouton « Réinstaller »
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('videogen.settings.v1') || '{}');
    s.savedLoras.push({ repo: 'org/ltx-extra', path: 'extra.safetensors', revision: 'main', base: 'ltx25' });
    localStorage.setItem('videogen.settings.v1', JSON.stringify(s));
  });
  await page.reload();
  await page.fill('#unlock-pass', PASS);
  await page.getByTestId('unlock').click();
  await page.getByTestId('tab-instance').click();
  await expect(page.getByTestId('lora-reinstall')).toHaveText('Réinstaller mes LoRA (1)', { timeout: 30_000 });
  await page.getByTestId('lora-reinstall').click();
  await expect(page.getByTestId('lora-item')).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByTestId('lora-reinstall')).toHaveCount(0);
});
