// Toutes les instances du compte sont listées (plusieurs pages, tous labels) : aucune instance allumée
// ne doit passer inaperçue. Arrêt et destruction possibles depuis la liste.
import { test, expect } from '@playwright/test';
import { enterKeys, resetMocks, mockState, MOCK } from './helpers.ts';

test.beforeEach(async () => {
  await resetMocks();
});

test('liste complète des instances, alerte et arrêt d’une instance oubliée', async ({ page }) => {
  const { ids } = (await (await fetch(`${MOCK}/__mock/seed-many`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 30, running: 2 }) })).json()) as { ids: number[] };
  const [forgotten, unlabeled] = ids;

  await enterKeys(page);
  const box = page.getByTestId('all-instances');
  await expect(box.getByRole('heading')).toHaveText('Toutes tes instances Vast (30)');
  await expect(box.locator('li.inst')).toHaveCount(30);
  await expect(page.getByTestId('billing-summary')).toContainText('2 instance(s) allumée(s)');
  await expect(page.getByTestId(`inst-${forgotten}`)).toContainText('autre-projet');
  await expect(page.getByTestId(`inst-${forgotten}`)).toContainText('GPU facturé');
  await expect(page.getByTestId(`inst-${unlabeled}`)).toContainText('(sans label)');
  await expect(page.getByTestId('cost-banner')).toContainText('2 instance(s) Vast allumée(s)');

  // La liste a bien suivi la pagination de l'API v1 (25 par page).
  const reqs = (await mockState()).requests.filter((r) => r.path === '/api/v1/instances/');
  expect(reqs.length).toBeGreaterThan(1);

  // Arrêter l'instance oubliée depuis la liste
  await page.getByTestId(`stop-${forgotten}`).click();
  await page.getByTestId('dialog-ok').click();
  await expect.poll(async () => (await mockState()).instances.find((i) => i.id === forgotten)?.actual_status, { timeout: 15_000 }).toBe('stopped');
  await expect(page.getByTestId('billing-summary')).toContainText('1 instance(s) allumée(s)', { timeout: 15_000 });

  // Détruire l'autre
  await page.getByTestId(`destroy-${unlabeled}`).click();
  await page.getByTestId('dialog-ok').click();
  await expect(box.locator('li.inst')).toHaveCount(29, { timeout: 15_000 });
  await expect(page.getByTestId('billing-summary')).toContainText('Aucune instance allumée', { timeout: 15_000 });
  await expect(page.getByTestId('cost-banner')).toBeHidden();
});

test('rappel avant fermeture si une instance quelconque est allumée', async ({ page }) => {
  await fetch(`${MOCK}/__mock/seed-many`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 1, running: 1 }) });
  await enterKeys(page);
  await expect(page.getByTestId('billing-summary')).toContainText('1 instance(s) allumée(s)');
  let sawBeforeUnload = false;
  page.on('dialog', async (d) => {
    if (d.type() === 'beforeunload') sawBeforeUnload = true;
    await d.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => sawBeforeUnload).toBe(true);
});
