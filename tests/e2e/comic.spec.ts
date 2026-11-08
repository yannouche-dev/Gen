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

  // Génération de la page 1 : UN travail dans la file de l'instance, chaque case reçoit l'image de Léa
  await page.getByTestId('gen-page').click();
  for (const i of [1, 2, 3]) await expect(page.getByTestId(`panel-status-${i}`)).toContainText('Image prête', { timeout: 90_000 });
  st = await mockState();
  const job = st.comfy!.lastPrompts.at(-1)!;
  const refs = Object.entries(job).filter(([, n]) => n.class_type === 'ReferenceLatent').map(([k]) => k);
  expect(refs).toHaveLength(3);
  expect(refs.every((k) => /^p-.+:vg-ref1:ref$/.test(k))).toBe(true);
  expect(Object.values(job).filter((n) => n.class_type === 'LoadImage')).toHaveLength(1); // photo envoyée une fois
  expect(Object.values(job).filter((n) => n.class_type === 'UNETLoader')).toHaveLength(1);
  const texts = Object.values(job).filter((n) => n.class_type === 'CLIPTextEncode').map((n) => n.inputs.text as string);
  expect(texts).toHaveLength(3);
  for (const t of texts) {
    expect(t).toContain('manga');
    expect(t).toContain('Léa is the character shown in reference image 1');
  }
  const latent = Object.values(job).find((n) => n.class_type === 'EmptyFlux2LatentImage')!.inputs;
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
  await page.locator('details', { hasText: 'Réglages de location' }).locator('summary').click();
  await page.getByTestId('family-flux2dev').uncheck();
  await page.getByTestId('family-qwen35').uncheck();
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

test('BD express : un titre → histoire, personnages, décors et pages, tout en file ; reprise après fermeture', async ({ page }) => {
  await enterKeys(page);
  await page.locator('details', { hasText: 'Réglages de location' }).locator('summary').click();
  await page.getByTestId('family-ltx25').uncheck();
  await page.getByTestId('family-flux2dev').check();
  await page.getByTestId('family-qwen35').check();
  await rentAndWaitReady(page);
  await page.getByTestId('tab-comic').click();
  page.once('dialog', (d) => d.accept('Libraire'));
  await page.getByTestId('new-project').click();
  await page.getByTestId('step-story').click();
  await page.getByTestId('express-title').fill('La libraire veut rendre son mari jaloux');
  await page.getByTestId('express-pages').selectOption('2');
  await page.getByTestId('express-tone').selectOption('vaudeville');
  await page.getByTestId('express-go').click();

  // Tous les travaux d'images sont dans la file avant la fin du premier : on ferme l'onglet.
  await expect(page.locator('.toast', { hasText: 'en file sur l’instance' })).toBeVisible({ timeout: 60_000 });
  const pendingCount = () => page.evaluate(() => JSON.parse(localStorage.getItem('videogen.pending.v1') || '[]').length as number);
  let st = await mockState();
  const qwen = st.comfy!.lastPrompts.filter((pr) => Object.values(pr).some((n) => n.class_type === 'TextGenerate'));
  expect(qwen).toHaveLength(2); // bible puis découpage
  const bible = Object.values(qwen[0]).find((n) => n.class_type === 'TextGenerate')!.inputs.prompt as string;
  expect(bible).toContain('La libraire veut rendre son mari jaloux');
  expect(bible).toContain('Tone: vaudeville');
  await page.reload();
  await page.fill('#unlock-pass', PASS);
  await page.getByTestId('unlock').click();
  await page.getByTestId('tab-comic').click();
  await expect.poll(pendingCount, { timeout: 60_000 }).toBe(0);

  st = await mockState();
  const images = st.comfy!.lastPrompts.filter((pr) => Object.values(pr).some((n) => n.class_type === 'SaveImage'));
  expect(images).toHaveLength(3); // planches + 2 pages
  const saves = (pr: Record<string, { class_type: string; inputs: Record<string, unknown> }>) => Object.values(pr).filter((n) => n.class_type === 'SaveImage').map((n) => String(n.inputs.filename_prefix).split('_').pop());
  expect(saves(images[0]).sort()).toEqual(expect.arrayContaining([expect.stringMatching(/^k-/), expect.stringMatching(/^s-/)]));
  expect(saves(images[0])).toHaveLength(4); // Claire, Paul, 2 décors
  expect(saves(images[1]).every((k) => k!.startsWith('p-'))).toBe(true);
  // Dans une page, la planche de Claire est recalculée dans le graphe (cache ComfyUI) et sert de référence.
  expect(Object.keys(images[1]).some((k) => k.startsWith('k-') && images[1][k].class_type === 'SamplerCustomAdvanced')).toBe(true);
  expect(Object.values(images[1]).filter((n) => n.class_type === 'UNETLoader')).toHaveLength(1);

  // Tout est rangé dans le projet chiffré.
  await page.getByTestId('step-pages').click();
  for (const i of [1, 2, 3]) await expect(page.getByTestId(`panel-status-${i}`)).toContainText('Image prête', { timeout: 30_000 });
  await expect(page.getByTestId('panel-setting-1')).toHaveValue(/^s/);
  await page.getByTestId('page-tab-2').click();
  for (const i of [1, 2, 3]) await expect(page.getByTestId(`panel-status-${i}`)).toContainText('Image prête');
  await page.getByTestId('step-chars').click();
  await expect(page.locator('[data-testid^="char-name-"]')).toHaveCount(2);
  await expect(page.locator('[data-testid^="char-k"] .thumb-box img')).toHaveCount(2);
  await page.getByTestId('step-sets').click();
  await expect(page.locator('[data-testid^="set-name-"]')).toHaveCount(2);
  await expect(page.locator('[data-testid^="set-s"] .thumb-box img')).toHaveCount(2);
  await expect(page.getByTestId('project-select').locator('option', { hasText: 'La libraire veut rendre son mari jaloux' })).toHaveCount(1);
});

test('Studio BD : page en plein écran, zoom (boutons, double-tap, molette, pincement), pages au balayage, fermeture', async ({ page }) => {
  await enterKeys(page);
  await page.getByTestId('tab-comic').click();
  page.once('dialog', (d) => d.accept('Zoom'));
  await page.getByTestId('new-project').click();
  for (let i = 0; i < 2; i++) {
    await page.getByTestId('step-story').click();
    await page.getByTestId('add-page').click(); // ouvre l'étape Pages
  }
  await page.getByTestId('page-tab-1').click();

  // Ouverture depuis la page (toucher l'aperçu)
  await page.getByTestId('page-preview').locator('canvas').click();
  const viewer = page.getByTestId('page-viewer');
  await expect(viewer).toBeVisible();
  await expect(page.getByTestId('viewer-count')).toHaveText('1 / 2');
  const img = viewer.locator('canvas.viewer-page');
  expect(await img.evaluate((c: HTMLCanvasElement) => [c.width, c.height])).toEqual([2481, 3509]); // A4 en haute définition
  const scale = () => img.evaluate((c) => Number((c as HTMLElement).dataset.scale));

  // Boutons
  await page.getByTestId('viewer-zoom-in').click();
  await expect(page.getByTestId('viewer-zoom')).toHaveText('150 %');
  await page.getByTestId('viewer-fit').click();
  await expect(page.getByTestId('viewer-zoom')).toHaveText('100 %');
  // Double-tap : ×2,5 sur le point touché, puis retour
  const box = (await page.getByTestId('viewer-stage').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.dblclick(cx, cy);
  await expect(page.getByTestId('viewer-zoom')).toHaveText('250 %');
  // Déplacement de la page zoomée
  const before = await img.evaluate((c) => (c as HTMLElement).style.transform);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy + 120, { steps: 5 });
  await page.mouse.up();
  expect(await img.evaluate((c) => (c as HTMLElement).style.transform)).not.toBe(before);
  await page.mouse.dblclick(cx, cy);
  await expect(page.getByTestId('viewer-zoom')).toHaveText('100 %');
  // Molette
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -300);
  await expect.poll(scale).toBeGreaterThan(1.2);
  await page.getByTestId('viewer-fit').click();
  // Pincement à deux doigts (événements pointer)
  await page.getByTestId('viewer-stage').evaluate((el, [x0, y0]) => {
    const ev = (type: string, id: number, x: number) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y0, bubbles: true, cancelable: true }));
    ev('pointerdown', 11, x0 - 50);
    ev('pointerdown', 12, x0 + 50);
    ev('pointermove', 12, x0 + 150);
    ev('pointerup', 12, x0 + 150);
    ev('pointerup', 11, x0 - 50);
  }, [cx, cy]);
  await expect(page.getByTestId('viewer-zoom')).toHaveText('200 %');
  await page.getByTestId('viewer-fit').click();
  // Balayage vers la gauche : page suivante
  await page.mouse.move(cx + 120, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 120, cy, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId('viewer-count')).toHaveText('2 / 2');
  await expect(page.getByTestId('viewer-next')).toBeDisabled();
  await page.getByTestId('viewer-prev').click();
  await expect(page.getByTestId('viewer-count')).toHaveText('1 / 2');
  // Enregistrer la page affichée
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('viewer-download').click()]);
  expect(dl.suggestedFilename()).toBe('Zoom_page1.png');

  // Fermeture : bouton « retour » du téléphone, puis ✕ (l'application reste ouverte)
  await page.goBack();
  await expect(viewer).toHaveCount(0);
  await expect(page.getByTestId('page-preview')).toBeVisible();
  await page.getByTestId('page-fullscreen').click();
  await expect(viewer).toBeVisible();
  await page.getByTestId('viewer-close').click();
  await expect(viewer).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Studio BD' })).toBeVisible();

  // Lecture de toute la BD depuis l'export
  await page.getByTestId('step-export').click();
  await page.getByTestId('read-fullscreen').click();
  await expect(page.getByTestId('viewer-count')).toHaveText('1 / 2');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('viewer-count')).toHaveText('2 / 2');
  await page.getByTestId('viewer-close').click();
  await expect(viewer).toHaveCount(0);
});
