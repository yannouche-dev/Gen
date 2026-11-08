// Studio BD : projet chiffré, personnage de référence décrit par l'IA, découpage de l'histoire (Qwen 3.5),
// génération des cases avec références (FLUX.2 Dev), export PDF / CBZ, persistance après rechargement.
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { enterKeys, rentAndWaitReady, resetMocks, mockState, PASS } from './helpers.ts';

const PNG = path.resolve(import.meta.dirname, '../../mocks/fixtures/panel.png');

test.beforeEach(async () => {
  await resetMocks();
});

async function readDownload(page: Page, click: () => Promise<void>): Promise<{ name: string; data: Buffer }> {
  const [dl] = await Promise.all([page.waitForEvent('download'), click()]);
  return { name: dl.suggestedFilename(), data: fs.readFileSync((await dl.path())!) };
}

test('Studio BD : personnage, découpage IA, cases avec références, export, persistance', async ({ page }) => {
  await enterKeys(page);
  await page.locator('details', { hasText: 'Réglages de location' }).locator('summary').click();
  await page.getByTestId('family-ltx25').uncheck();
  await page.getByTestId('family-flux2dev').check();
  await page.getByTestId('family-qwen35').check();
  await rentAndWaitReady(page);
  expect((await mockState()).creates[0].body.env.MODELS).toBe('flux2dev,qwen35');

  // Projet
  await page.getByTestId('tab-comic').click();
  await expect(page.getByRole('heading', { name: 'Studio BD' })).toBeVisible();
  page.once('dialog', (d) => d.accept('Les docks'));
  await page.getByTestId('new-project').click();
  await expect(page.getByTestId('project-select')).toHaveValue(/^p/);

  // Personnage : image de référence, description par l'IA
  await page.getByTestId('add-char').click();
  const name = page.locator('[data-testid^="char-name-"]');
  await name.fill('Léa');
  await page.locator('[data-testid^="char-image-"]').setInputFiles(PNG);
  await expect(page.locator('.thumb-box img')).toHaveCount(1);
  await page.locator('[data-testid^="char-describe-"]').click();
  await expect(page.locator('[data-testid^="char-desc-"]')).toHaveValue(/copper-red hair/, { timeout: 60_000 });
  let st = await mockState();
  const describe = st.comfy!.lastPrompts.at(-1)!;
  expect(Object.values(describe).some((n) => n.class_type === 'TextGenerate')).toBe(true);
  expect(Object.values(describe).find((n) => n.class_type === 'LoadImage')?.inputs.image).toMatch(/\.jpe?g$|\.png$/);

  // Style
  await page.getByTestId('step-style').click();
  await page.getByTestId('style-manga').click();
  await expect(page.getByTestId('style-manga')).toHaveClass(/active/);

  // Histoire découpée par l'IA
  await page.getByTestId('step-story').click();
  await page.getByTestId('synopsis').fill('Léa reçoit une lettre mystérieuse et part la nuit sur les docks.');
  await page.getByTestId('story-pages').selectOption('2');
  await page.getByTestId('story-split').click();
  await expect(page.getByTestId('page-tab-2')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('page-layout')).toHaveValue('m3');
  await expect(page.getByTestId('panel-desc-2')).toHaveValue(/Léa looks at a mysterious letter/);
  await expect(page.locator('[data-testid^="handle-"]')).toHaveCount(3); // récitatif + 2 répliques

  // Génération de la page 1 : chaque case reçoit l'image de Léa comme référence
  await page.getByTestId('gen-page').click();
  for (const i of [1, 2, 3]) await expect(page.getByTestId(`panel-status-${i}`)).toContainText('Image prête', { timeout: 90_000 });
  st = await mockState();
  const panel = st.comfy!.lastPrompts.at(-1)!;
  const refs = Object.entries(panel).filter(([, n]) => n.class_type === 'ReferenceLatent').map(([k]) => k);
  expect(refs).toEqual(['vg-ref1:ref']);
  const prompt = Object.values(panel).find((n) => n.class_type === 'CLIPTextEncode')!.inputs.text as string;
  expect(prompt).toContain('manga');
  expect(prompt).toContain('Léa is the character shown in reference image 1');
  const latent = Object.values(panel).find((n) => n.class_type === 'EmptyFlux2LatentImage')!.inputs;
  expect((latent.width as number) % 16).toBe(0);
  expect(st.comfy!.views.filter((v) => v.endsWith('.png'))).toHaveLength(3);

  // Déplacement d'une bulle au doigt (souris ici)
  const handle = page.locator('[data-testid^="handle-"]').first();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 80, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('[data-testid^="handle-"]')).toHaveCount(3);

  // Export
  await page.getByTestId('step-export').click();
  await expect(page.locator('.msg.warn', { hasText: '3 case(s) sans image' })).toBeVisible();
  const pdf = await readDownload(page, () => page.getByTestId('export-pdf').click());
  expect(pdf.name).toBe('Les docks.pdf');
  expect(pdf.data.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
  expect(pdf.data.toString('latin1')).toContain('/Count 2');
  const cbz = await readDownload(page, () => page.getByTestId('export-cbz').click());
  expect(cbz.name).toBe('Les docks.cbz');
  expect(cbz.data.readUInt32LE(0)).toBe(0x04034b50);
  expect(cbz.data.toString('latin1')).toContain('ComicInfo.xml');

  // Persistance chiffrée dans le téléphone (IndexedDB) : rien en clair
  const plain = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('videogen-bd');
      q.onsuccess = () => r(q.result);
    });
    const rows = await new Promise<unknown[]>((r) => {
      const q = db.transaction('projects').objectStore('projects').getAll();
      q.onsuccess = () => r(q.result);
    });
    return JSON.stringify(rows.map((x) => Object.keys(x as object)));
  });
  expect(plain).not.toContain('Les docks');
  expect(plain).toContain('ct');

  await page.reload();
  await page.fill('#unlock-pass', PASS);
  await page.getByTestId('unlock').click();
  await page.getByTestId('tab-comic').click();
  await expect(page.getByTestId('project-select').locator('option', { hasText: 'Les docks' })).toHaveCount(1);
  await page.getByTestId('step-pages').click();
  for (const i of [1, 2, 3]) await expect(page.getByTestId(`panel-status-${i}`)).toContainText('Image prête');
  await page.getByTestId('page-tab-2').click();
  await expect(page.getByTestId('panel-status-1')).toContainText('Pas encore générée');
});

test('Studio BD sans FLUX.2 sur l’instance : message clair', async ({ page }) => {
  await enterKeys(page);
  await rentAndWaitReady(page);
  await page.getByTestId('tab-comic').click();
  await expect(page.getByTestId('comic-missing')).toContainText('FLUX.2 Dev, Qwen 3.5');
  page.once('dialog', (d) => d.accept('Essai'));
  await page.getByTestId('new-project').click();
  await page.getByTestId('step-story').click();
  await page.getByTestId('synopsis').fill('Une histoire');
  await page.getByTestId('story-split').click();
  await expect(page.locator('.toast-error', { hasText: 'Qwen 3.5 n’est pas installé' })).toBeVisible();
});

test('Studio BD : case récupérée après fermeture de l’onglet pendant la génération', async ({ page }) => {
  await enterKeys(page);
  await page.locator('details', { hasText: 'Réglages de location' }).locator('summary').click();
  await page.getByTestId('family-ltx25').uncheck();
  await page.getByTestId('family-flux2dev').check();
  await rentAndWaitReady(page);
  await page.getByTestId('tab-comic').click();
  page.once('dialog', (d) => d.accept('Phare'));
  await page.getByTestId('new-project').click();
  await page.getByTestId('step-story').click();
  await page.getByTestId('add-page').click();
  await page.getByTestId('panel-desc-1').fill('a lighthouse in a storm #slow');
  await page.getByTestId('panel-gen-1').click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('videogen.pending.v1') || '[]').length as number)).toBe(1);
  await expect(page.getByTestId('panel-status-1')).toContainText('%');
  await page.reload();
  await page.fill('#unlock-pass', PASS);
  await page.getByTestId('unlock').click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('videogen.pending.v1') || '[]').length as number), { timeout: 60_000 }).toBe(0);
  await page.getByTestId('tab-comic').click();
  await page.getByTestId('step-pages').click();
  await expect(page.getByTestId('panel-status-1')).toContainText('Image prête');
  await expect(page.getByTestId('panel-status-2')).toContainText('Pas encore générée');
});
