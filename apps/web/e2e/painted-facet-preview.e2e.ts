import playwright from '../../desktop/node_modules/@playwright/test/index.js';
const { test, expect } = playwright;
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { readZipEntries } from '../../../packages/slicer-wasm/harness/native-3mf-parser.mjs';

const PROJECT_PATH = resolve(process.env.ORCA_E2E_PAINTED_FACET_PROJECT?.trim() ?? '');
test.skip(!process.env.ORCA_E2E_PAINTED_FACET_PROJECT || !existsSync(PROJECT_PATH),
  'requires the repository painted facet project fixture');
test.setTimeout(480_000);

type MaterialColour = {
  stateId: number;
  colour: string;
  opacity: number;
  transparent: boolean;
  depthWrite: boolean;
};

function colourByState(entries: MaterialColour[]): Map<number, string> {
  const result = new Map<number, string>();
  for (const entry of entries) {
    const colour = entry.colour.toLowerCase();
    const existing = result.get(entry.stateId);
    if (existing !== undefined && existing !== colour)
      throw new Error(`paint state ${entry.stateId} has inconsistent instance colours`);
    result.set(entry.stateId, colour);
  }
  return result;
}

test('real Web loads the imported painted project and keeps its Preview shell transparent', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('orca-slicer-neo:preferences', JSON.stringify({
      version: 1, projectLoadBehaviour: 'load_all', selectedProfiles: {}, ui: {},
    }));
  });
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 180_000 });
  await page.locator('#app-tab-prepare').click();

  const chooser = page.waitForEvent('filechooser');
  if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
    await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
    await page.getByTestId('titlebar-menu-trigger').click();
  }
  await page.getByTestId('menu-file-trigger').hover();
  await page.locator('[data-slot=\"menubar-sub-content\"]').hover({ position: { x: 8, y: 8 } });
  await page.getByTestId('file-open-project').click();
  await (await chooser).setFiles(PROJECT_PATH);
  const readLoadStage = () => page.evaluate(() => {
    const doc = document;
    if (doc.querySelector('[data-testid="project-load-choice-dialog"]')) return 'choice';
    if (doc.querySelector('[data-testid="project-load-confirmation-dialog"]')) return 'confirmation';
    const receipt = (window as unknown as {
      __orcaE2e?: { projectLoadEvidence?: () => { receipt: unknown } };
    }).__orcaE2e?.projectLoadEvidence?.()?.receipt;
    if (receipt) return 'receipt';
    const progress = doc.querySelector('[data-testid="project-progress-dialog"]');
    if (progress) {
      const message = doc.querySelector('[data-testid="project-progress-message"]')?.textContent?.trim() ?? '';
      return `progress:${message}`;
    }
    return `idle:${doc.querySelector('[data-testid="slicer-status"]')?.textContent?.trim() ?? 'missing'}`;
  });

  await expect.poll(readLoadStage, { timeout: 30_000 }).toMatch(/^(choice|confirmation|progress:|receipt)$/);
  if (await page.getByTestId('project-load-choice-dialog').isVisible().catch(() => false)) {
    await page.getByTestId('project-load-project').click();
    await page.getByTestId('project-load-confirm').click();
  }
  await expect.poll(readLoadStage, { timeout: 30_000 }).toMatch(/^(confirmation|progress:|receipt)$/);
  if (await page.getByTestId('project-load-confirmation-dialog').isVisible().catch(() => false))
    await page.getByTestId('project-load-confirmation-dialog-continue').click();
  await expect.poll(readLoadStage, { timeout: 180_000 }).toBe('receipt');

  await expect.poll(() => page.evaluate(() => {
    const receipt = (window as unknown as {
      __orcaE2e?: { projectLoadEvidence?: () => { receipt: {
        sourceDisplayName: string;
        sourceByteLength: number;
        commitRoute: string;
        nativeResult: { ok: boolean; mode?: string; objects: number; instances: number };
      } | null } };
    }).__orcaE2e?.projectLoadEvidence?.()?.receipt;
    return receipt ? {
      sourceDisplayName: receipt.sourceDisplayName,
      sourceByteLength: receipt.sourceByteLength,
      commitRoute: receipt.commitRoute,
      nativeResult: receipt.nativeResult,
    } : null;
  }), { timeout: 180_000 }).toMatchObject({
    sourceDisplayName: basename(PROJECT_PATH),
    sourceByteLength: statSync(PROJECT_PATH).size,
    commitRoute: 'load-project',
    nativeResult: { ok: true, mode: 'project', objects: 1, instances: 2 },
  });

  const readMaterials = () => page.evaluate(() =>
    (window as unknown as { __orcaE2e?: { modelMaterialColours?: () => MaterialColour[] } })
      .__orcaE2e?.modelMaterialColours?.() ?? [],
  );
  const readFirstPreviewCommitMaterials = () => page.evaluate(() =>
    (window as unknown as { __orcaE2e?: { previewFirstCommitPaintMaterials?: () => MaterialColour[] } })
      .__orcaE2e?.previewFirstCommitPaintMaterials?.() ?? [],
  );
  const readMeshResponse = () => page.evaluate(() =>
    (window as unknown as { __orcaE2e?: { modelMeshResponse?: () => unknown } })
      .__orcaE2e?.modelMeshResponse?.() ?? null,
  );
  const readResources = () => page.evaluate(() =>
    (window as unknown as { __orcaE2e?: { modelPaintResources?: () => Array<{
      id: string; instanceIndex: number; paintGeometryUuid: string | null; paintGroupStates: number[];
      visibleGeometryUuid: string | null; paintDisplayRaycastDisabled: boolean;
      originalPickVisible: boolean | null;
    }> } }).__orcaE2e?.modelPaintResources?.() ?? [],
  );
  const readToolpathBounds = () => page.evaluate(() =>
    (window as unknown as { __orcaE2e?: { previewToolpathWorldBounds?: () => unknown } })
      .__orcaE2e?.previewToolpathWorldBounds?.() ?? null,
  );

  await expect.poll(readResources, { timeout: 180_000 }).toHaveLength(2);
  const prepareResources = await readResources();
  const rawModelMesh = await readMeshResponse() as {
    objects: Array<{ geometryKey: string; paintGeometryKey: string | null }>;
    paintGeometries: Array<{ drawGroups: Array<{ stateId: number }> }>;
  } | null;
  expect(rawModelMesh?.objects).toHaveLength(2);
  expect(new Set(rawModelMesh!.objects.map((object) => object.geometryKey)).size).toBe(1);
  expect(new Set(rawModelMesh!.objects.map((object) => object.paintGeometryKey)).size).toBe(1);
  expect(rawModelMesh?.paintGeometries).toHaveLength(1);
  expect(new Set(rawModelMesh!.paintGeometries[0]!.drawGroups.map((group) => group.stateId)))
    .toEqual(new Set([0, 1, 2, 3, 4]));
  expect(prepareResources.every((resource) => resource.paintGeometryUuid
    && resource.visibleGeometryUuid === resource.paintGeometryUuid
    && resource.paintDisplayRaycastDisabled
    && resource.originalPickVisible === false)).toBe(true);
  expect(new Set(prepareResources.map((resource) => resource.paintGeometryUuid)).size).toBe(1);
  expect(new Set(prepareResources.flatMap((resource) => resource.paintGroupStates))).toEqual(new Set([0, 1, 2, 3, 4]));
  await expect.poll(readMaterials, { timeout: 30_000 }).toHaveLength(10);
  const prepareColours = colourByState(await readMaterials());
  expect(prepareColours).toEqual(new Map([
    [0, '#00ff00'], [1, '#ff0000'], [2, '#00ff00'], [3, '#ff0000'], [4, '#ff0000'],
  ]));
  const point = await page.evaluate(() => {
    const hooks = (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e;
    return hooks.projectWorldToScreen(hooks.modelWorldCenters()[0]);
  });
  const viewport = await page.getByTestId('viewport').boundingBox();
  await page.mouse.click(viewport!.x + point.x, viewport!.y + point.y);
  await expect(page.getByTestId('gizmo-btn-paint')).toBeEnabled();

  // Preserve the imported five-state Preview contract before making any new
  // painting edits. The later phase proves the newly saved two-state result.
  await page.getByTestId('btn-slice').click();
  if (process.env.ORCA_WEB_NO_ISOLATION === '1') {
    await expect(page.getByTestId('slicer-status')).toHaveText('Slicing…');
    await page.locator('#app-tab-prepare').click();
    await expect(page.getByTestId('gizmo-btn-paint')).toBeDisabled();
    await expect(page.getByTestId('painting-panel')).toHaveCount(0);
  }
  await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 240_000 });
  await page.locator('#app-tab-preview').click();
  await expect(page.locator('#app-tab-preview')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(readFirstPreviewCommitMaterials).toHaveLength(10);
  expect(colourByState(await readFirstPreviewCommitMaterials())).toEqual(prepareColours);
  expect(colourByState(await readMaterials())).toEqual(prepareColours);
  expect(new Set((await readResources()).flatMap((resource) => resource.paintGroupStates)))
    .toEqual(new Set([0, 1, 2, 3, 4]));
  await page.locator('#app-tab-prepare').click();
  await expect.poll(readMaterials).toHaveLength(10);

  // Web host shares the app-owned painting lifecycle, including download Save.
  await page.mouse.click(viewport!.x + point.x, viewport!.y + point.y);
  await page.getByTestId('gizmo-btn-paint').click();
  await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase', 'idle');
  const painting = () => page.evaluate(() => (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e.paintingEvidence());
  const paintSession = (await painting()).sessionId;
  const nativePoint = (await painting()).center;
  await page.mouse.move(nativePoint.x, nativePoint.y); await page.mouse.down();
  await expect.poll(async () => (await painting()).phase).toBe('drawing');
  await page.keyboard.press('Control+n');
  await expect(page.getByTestId('project-dirty-dialog')).toHaveCount(0);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase', 'idle');
  await page.getByRole('button', { name: 'Erase all', exact: true }).click();
  const committed = () => page.evaluate(() => (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e.paintingCommittedEvidence());
  await expect.poll(async () => (await committed()).paint.length).toBe(0);
  await page.getByRole('radio', { name: 'Paint filament 2', exact: true }).click();
  await page.getByTestId('painting-tool-triangle').click();
  const paintPoint = (await painting()).center;
  await page.mouse.click(paintPoint.x, paintPoint.y);
  await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase', 'idle');
  await expect.poll(async () => (await committed()).paint.some((part: { groups: { stateId: number }[] }) =>
    part.groups.some((group) => group.stateId === 2))).toBe(true);
  const download = page.waitForEvent('download');
  await page.keyboard.press('Control+Shift+s');
  const saved = await download;
  expect(saved.suggestedFilename()).toMatch(/\.3mf$/);
  const savedModel = readZipEntries(readFileSync(await saved.path()))
    .find((entry) => entry.name === '3D/3dmodel.model');
  expect(savedModel).toBeDefined();
  const savedXml = new TextDecoder().decode(savedModel!.content);
  expect((savedXml.match(/paint_color=/g) ?? []).length).toBeGreaterThan(0);
  expect((savedXml.match(/paint_color=/g) ?? []).length).toBeLessThan(12);
  const paintedColours = new Map([[0, '#00ff00'], [2, '#00ff00']]);
  await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase', 'idle');
  expect((await painting()).sessionId).toBe(paintSession);
  await page.locator('#app-tab-home').click();
  await page.locator('#app-tab-prepare').click();
  await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase', 'idle');
  expect((await painting()).sessionId).toBe(paintSession);
  await page.getByTestId('btn-slice').click();
  await expect(page.getByTestId('painting-panel')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => ({
    status: document.querySelector('[data-testid="slicer-status"]')?.textContent?.trim() ?? null,
    error: document.querySelector('[data-testid="slicer-error"]')?.textContent?.trim() ?? null,
  })), { timeout: 240_000 }).toMatchObject({ status: expect.stringMatching(/^(Sliced|Error)$/) });
  const sliceOutcome = await page.evaluate(() => ({
    status: document.querySelector('[data-testid="slicer-status"]')?.textContent?.trim() ?? null,
    error: document.querySelector('[data-testid="slicer-error"]')?.textContent?.trim() ?? null,
  }));
  if (sliceOutcome.status !== 'Sliced')
    throw new Error(`fixture slice failed: ${sliceOutcome.error ?? 'native slice returned Error without a message'}`);
  await expect(page.locator('#app-tab-preview')).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
  await expect(page.getByTestId('preview-controls')).toBeVisible({ timeout: 30_000 });
  await expect.poll(readToolpathBounds, { timeout: 30_000 }).not.toBeNull();

  const firstPreviewCommitMaterials = await readFirstPreviewCommitMaterials();
  expect(firstPreviewCommitMaterials).toHaveLength(4);
  expect(colourByState(firstPreviewCommitMaterials)).toEqual(paintedColours);
  expect(firstPreviewCommitMaterials.every((material) => material.opacity === 0.15
    && material.transparent
    && material.depthWrite === false)).toBe(true);

  const previewMaterials = await readMaterials();
  expect(previewMaterials).toHaveLength(4);
  expect(colourByState(previewMaterials)).toEqual(paintedColours);
  expect(previewMaterials.every((material) => material.opacity === 0.15
    && material.transparent
    && material.depthWrite === false)).toBe(true);
  const previewResources = await readResources();
  expect(previewResources).toHaveLength(2);
  expect(previewResources.every((resource) => resource.paintGeometryUuid
    && resource.visibleGeometryUuid === resource.paintGeometryUuid
    && resource.paintDisplayRaycastDisabled
    && resource.originalPickVisible === null)).toBe(true);
});
