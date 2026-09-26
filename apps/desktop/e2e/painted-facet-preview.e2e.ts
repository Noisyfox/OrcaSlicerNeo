import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const DESKTOP_ROOT = resolve(__dirname, '..');
const PROJECT_PATH = resolve(process.env.ORCA_E2E_PAINTED_FACET_PROJECT?.trim() ?? '');
const REAL = process.env.ORCA_E2E_REAL === '1';

test.skip(!REAL || !process.env.ORCA_E2E_PAINTED_FACET_PROJECT || !existsSync(PROJECT_PATH),
  'requires ORCA_E2E_REAL=1 and the repository painted facet project fixture');
test.setTimeout(480_000);

type MaterialColour = {
  id: string;
  objectIndex: number;
  volumeIndex: number;
  stateId: number;
  colour: string;
  opacity: number;
  transparent: boolean;
  depthWrite: boolean;
};
type PaintResource = {
  id: string;
  objectIndex: number;
  volumeIndex: number;
  instanceIndex: number;
  originalGeometryUuid: string;
  originalHasBvh: boolean;
  paintGeometryUuid: string | null;
  paintHasBvh: boolean;
  paintGroupStates: number[];
  visibleGeometryUuid: string | null;
  visibleUsesOriginalGeometry: boolean;
  visibleUsesBvhRaycast: boolean;
  paintDisplayRaycastDisabled: boolean;
  originalPickVisible: boolean | null;
  originalPickUsesBvhRaycast: boolean;
};
type ProjectLoadEvidence = {
  receipt: {
    sourceDisplayName: string;
    sourceByteLength: number;
    commitRoute: string;
    nativeResult: { ok: boolean; mode?: string; objects: number; instances: number; projectSettingsAvailable?: boolean };
  } | null;
  session: { projectName: string; hasContent: boolean; scope: string; hasLocation: boolean };
};
type FilamentStateEvidence = {
  pendingKind: string | null;
  rejected: string | null;
  slots: Array<{ slot: number; colour: string }>;
  partAssignments: Array<{ id: number; effectiveSlot: number }>;
};
type ModelMeshEvidence = {
  objects: Array<{
    objectId: number;
    instanceId: number;
    geometryKey: string;
    paintGeometryKey: string | null;
  }>;
  paintGeometries: Array<{
    volumeId: number;
    paintGeometryKey: string;
    drawGroups: Array<{ stateId: number; startIndex: number; indexCount: number }>;
  }>;
};

function colourByState(entries: MaterialColour[], paintedVolumes: PaintResource[]): Map<number, string> {
  const result = new Map<number, string>();
  const paintedIdentities = new Set(paintedVolumes.filter((resource) => resource.paintGeometryUuid)
    .map((resource) => `${resource.objectIndex}:${resource.volumeIndex}`));
  for (const entry of entries.filter((item) => paintedIdentities.has(`${item.objectIndex}:${item.volumeIndex}`))) {
    const colour = entry.colour.toLowerCase();
    const existing = result.get(entry.stateId);
    if (existing !== undefined && existing !== colour)
      throw new Error(`paint state ${entry.stateId} has inconsistent instance colours: ${existing}, ${colour}`);
    result.set(entry.stateId, colour);
  }
  return result;
}

function colourByInstanceAndState(entries: MaterialColour[]): Map<string, string> {
  return new Map(entries.map((entry) => [`${entry.id}:${entry.stateId}`, entry.colour.toLowerCase()]));
}

test('real imported painted facets retain Preview colours, share resources, and restore through history', async () => {
  const preferencesPath = join(mkdtempSync(join(tmpdir(), 'orca-painted-facet-preview-')), 'preferences.json');
  writeFileSync(preferencesPath, JSON.stringify({
    version: 1, projectLoadBehaviour: 'load_all', selectedProfiles: {}, ui: {},
  }));
  const env = {
    ...process.env,
    ORCA_E2E: '1',
    ORCA_E2E_REAL: '1',
    ORCA_E2E_PRIME_TOWER_PROJECT: PROJECT_PATH,
    ORCA_E2E_MODEL: PROJECT_PATH,
    ORCA_E2E_PREFERENCES: preferencesPath,
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app: ElectronApplication = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    await page.locator('#app-tab-prepare').click();

    const readEvidence = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { projectLoadEvidence?: () => ProjectLoadEvidence } })
        .__orcaE2e?.projectLoadEvidence?.() ?? null,
    );
    const readOpenStage = () => page.evaluate(() => {
      const doc = document;
      if (doc.querySelector('[data-testid="project-load-choice-dialog"]')) return 'choice';
      if (doc.querySelector('[data-testid="project-load-confirmation-dialog"]')) return 'confirmation';
      const evidence = (window as unknown as {
        __orcaE2e?: { projectLoadEvidence?: () => { receipt: unknown } };
      }).__orcaE2e?.projectLoadEvidence?.();
      if (evidence?.receipt) return 'receipt';
      const progress = doc.querySelector('[data-testid="project-progress-dialog"]');
      if (progress) {
        const message = doc.querySelector('[data-testid="project-progress-message"]')?.textContent?.trim() ?? '';
        return `progress:${message}`;
      }
      const status = doc.querySelector('[data-testid="slicer-status"]')?.textContent?.trim() ?? 'missing';
      return `idle:${status}`;
    });

    await page.getByTestId('menu-file-trigger').click();
    await page.getByTestId('file-open-project').click();

    // A dirty startup scene asks whether to open the 3MF as a project or
    // import geometry. Resolve that choice before waiting for native progress.
    await expect.poll(readOpenStage, { timeout: 15_000 }).toMatch(/^(choice|progress:|confirmation|receipt)$/);
    if (await page.getByTestId('project-load-choice-dialog').isVisible().catch(() => false)) {
      await page.getByTestId('project-load-project').click();
      await page.getByTestId('project-load-confirm').click();
    }
    await expect.poll(readOpenStage, { timeout: 15_000 }).toMatch(/^(progress:|confirmation|receipt)$/);
    await expect.poll(readOpenStage, { timeout: 90_000 }).toMatch(/^(confirmation|receipt)$/);
    if (await page.getByTestId('project-load-confirmation-dialog').isVisible().catch(() => false)) {
      await page.getByTestId('project-load-confirmation-dialog-continue').click();
      await expect.poll(readOpenStage, { timeout: 60_000 }).toBe('receipt');
    }

    await expect.poll(readEvidence, { timeout: 30_000 }).toMatchObject({
      receipt: {
        sourceDisplayName: basename(PROJECT_PATH),
        sourceByteLength: statSync(PROJECT_PATH).size,
        commitRoute: 'load-project',
        nativeResult: { ok: true, mode: 'project', objects: 1, instances: 2, projectSettingsAvailable: true },
      },
      session: { hasContent: true, scope: 'project', hasLocation: true },
    });

    const readResources = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { modelPaintResources?: () => PaintResource[] } })
        .__orcaE2e?.modelPaintResources?.() ?? [],
    );
    const readMeshResponse = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { modelMeshResponse?: () => unknown } })
        .__orcaE2e?.modelMeshResponse?.() ?? null,
    );
    const readColours = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { modelMaterialColours?: () => MaterialColour[] } })
        .__orcaE2e?.modelMaterialColours?.() ?? [],
    );
    const readFirstPreviewCommitColours = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { previewFirstCommitPaintMaterials?: () => MaterialColour[] } })
        .__orcaE2e?.previewFirstCommitPaintMaterials?.() ?? [],
    );
    const readFilamentState = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { modelFilamentState?: () => FilamentStateEvidence } })
        .__orcaE2e?.modelFilamentState?.() ?? null,
    );
    const readPaintColours = async () => {
      const resources = await readResources();
      const paintedIdentities = new Set(resources.filter((resource) => resource.paintGeometryUuid)
        .map((resource) => `${resource.objectIndex}:${resource.volumeIndex}`));
      return (await readColours()).filter((entry) => paintedIdentities.has(`${entry.objectIndex}:${entry.volumeIndex}`));
    };
    const readCenters = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { modelWorldCenters?: () => Array<[number, number, number]> } })
        .__orcaE2e?.modelWorldCenters?.() ?? [],
    );
    const readSelection = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { modelSelectionIdentities?: () => Array<{ id: string }> } })
        .__orcaE2e?.modelSelectionIdentities?.() ?? [],
    );
    const readToolpathBounds = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { previewToolpathWorldBounds?: () => { min: [number, number, number]; max: [number, number, number] } | null } })
        .__orcaE2e?.previewToolpathWorldBounds?.() ?? null,
    );
    const projectWorld = (point: [number, number, number]) => page.evaluate((world) =>
      (window as unknown as { __orcaE2e?: { projectWorldToScreen?: (p: [number, number, number]) => { x: number; y: number } | null } })
        .__orcaE2e?.projectWorldToScreen?.(world) ?? null,
      point,
    );

    await expect.poll(readResources, { timeout: 30_000 }).toHaveLength(2);
    await expect.poll(async () => (await readResources()).filter((resource) => resource.paintGeometryUuid).length,
      { timeout: 30_000 }).toBe(2);
    const initialResources = await readResources();
    const paintedResources = initialResources.filter((resource) => resource.paintGeometryUuid);
    const rawModelMesh = await readMeshResponse() as ModelMeshEvidence | null;
    expect(rawModelMesh?.objects).toHaveLength(2);
    expect(new Set(rawModelMesh!.objects.map((object) => object.geometryKey)).size).toBe(1);
    expect(new Set(rawModelMesh!.objects.map((object) => object.paintGeometryKey)).size).toBe(1);
    expect(rawModelMesh?.paintGeometries).toHaveLength(1);
    expect(new Set(rawModelMesh!.paintGeometries[0]!.drawGroups.map((group) => group.stateId)))
      .toEqual(new Set([0, 1, 2, 3, 4]));
    expect(paintedResources).toHaveLength(2);
    expect(paintedResources.every((resource) => resource.paintGeometryUuid
      && resource.paintHasBvh === false
      && resource.originalHasBvh
      && resource.visibleGeometryUuid === resource.paintGeometryUuid
      && resource.paintDisplayRaycastDisabled
      && resource.originalPickVisible === false
      && resource.originalPickUsesBvhRaycast), JSON.stringify({
      resources: initialResources,
      modelMesh: await readMeshResponse(),
    }, null, 2)).toBe(true);
    expect(new Set(paintedResources.map((resource) => resource.paintGeometryUuid)).size)
      .toBe(1);
    expect(new Set(paintedResources.map((resource) => resource.originalGeometryUuid)).size).toBe(1);
    const paintStates = new Set(paintedResources.flatMap((resource) => resource.paintGroupStates));
    expect(paintStates).toEqual(new Set([0, 1, 2, 3, 4]));

    await expect.poll(readPaintColours, { timeout: 30_000 }).toHaveLength(10);
    const initialColours = colourByState(await readPaintColours(), paintedResources);
    // The fixture's part defaults to slot 2, so state 0 follows state 2.
    // States 3 and 4 exceed the two-slot rack and use the slot-1 fallback;
    // states 1 and 2 resolve their matching numbered slots.
    expect(initialColours.get(0)).toBe(initialColours.get(2));
    expect(initialColours.get(1)).not.toBe(initialColours.get(2));
    expect(initialColours.get(3)).toBe(initialColours.get(1));
    expect(initialColours.get(4)).toBe(initialColours.get(1));

    // Change slot 1 through the real rack input and prove the imported positive
    // paint state follows it while inherited/slot-2 states stay put.
    await page.getByTestId('filament-colour-1').evaluate((input) => {
      const colour = input as HTMLInputElement;
      colour.value = '#2048c0';
      colour.dispatchEvent(new Event('input', { bubbles: true }));
      colour.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.getByTestId('filament-colour-1')).toHaveValue('#2048c0');
    await expect.poll(async () => {
      const state = await readFilamentState();
      return {
        slotColour: state?.slots.find((slot) => slot.slot === 1)?.colour,
        pendingKind: state?.pendingKind,
        rejected: state?.rejected,
      };
    }, { timeout: 30_000 }).toEqual({ slotColour: '#2048c0', pendingKind: null, rejected: null });
    await expect.poll(async () => colourByState(await readPaintColours(), paintedResources).get(1), { timeout: 30_000 })
      .not.toBe(initialColours.get(1));
    const recoloured = colourByState(await readPaintColours(), paintedResources);
    expect(recoloured.get(0)).toBe(initialColours.get(0));
    expect(recoloured.get(2)).toBe(initialColours.get(2));
    expect(recoloured.get(3)).toBe(recoloured.get(1));
    expect(recoloured.get(4)).toBe(recoloured.get(1));

    // Drag a painted body through the ordinary selection raycast path. The
    // resulting scene patch and its Undo/Redo restore must retain the shared
    // paint allocation and the current palette.
    const beforeMove = await readCenters();
    const center = beforeMove[0];
    const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
    const box = await canvas.boundingBox();
    if (!center || !box) throw new Error('painted model center or viewport canvas is unavailable');
    const screen = await projectWorld(center);
    if (!screen) throw new Error('painted model center projection is unavailable');
    await page.mouse.click(box.x + screen.x, box.y + screen.y);
    await expect.poll(readSelection, { timeout: 15_000 }).not.toHaveLength(0);
    const undo = page.getByTestId('history-undo');
    const selectedColours = colourByInstanceAndState(await readPaintColours());
    await page.mouse.move(box.x + screen.x, box.y + screen.y);
    await page.mouse.down();
    await page.mouse.move(box.x + screen.x + 65, box.y + screen.y + 18, { steps: 6 });
    await expect.poll(async () => (await readCenters()).some((value, index) =>
      value.some((component, axis) => Math.abs(component - beforeMove[index]![axis]!) > 1e-6)), { timeout: 30_000 }).toBe(true);
    await page.mouse.up();
    await expect(undo).toHaveAttribute('aria-label', 'Undo Move', { timeout: 30_000 });
    const movedResources = await readResources();
    expect(movedResources.map((resource) => resource.paintGeometryUuid))
      .toEqual(initialResources.map((resource) => resource.paintGeometryUuid));
    expect(colourByInstanceAndState(await readPaintColours())).toEqual(selectedColours);

    await undo.click();
    await expect(page.getByTestId('history-redo')).toHaveAttribute('aria-label', 'Redo Move', { timeout: 30_000 });
    await expect.poll(readCenters, { timeout: 30_000 }).toEqual(beforeMove);
    expect((await readResources()).map((resource) => resource.paintGeometryUuid))
      .toEqual(initialResources.map((resource) => resource.paintGeometryUuid));
    expect(colourByState(await readPaintColours(), paintedResources)).toEqual(recoloured);
    await page.getByTestId('history-redo').click();
    await expect.poll(async () => (await readCenters()).some((value, index) =>
      value.some((component, axis) => Math.abs(component - beforeMove[index]![axis]!) > 1e-6)), { timeout: 30_000 }).toBe(true);
    expect(colourByState(await readPaintColours(), paintedResources)).toEqual(recoloured);
    await expect(page.getByTestId('history-restore-error')).toHaveCount(0);

    await expect(page.getByTestId('slicer-status')).toHaveText('Ready');
    await page.getByTestId('btn-slice').click();
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

    // This snapshot is taken by GLVolumeMesh's first Preview layout commit,
    // before another UI transition can hide a one-frame unpainted shell.
    const firstPreviewCommitColours = await readFirstPreviewCommitColours();
    expect(firstPreviewCommitColours).toHaveLength(10);
    expect(colourByState(firstPreviewCommitColours, paintedResources)).toEqual(recoloured);
    expect(firstPreviewCommitColours.every((material) => material.opacity === 0.15
      && material.transparent
      && material.depthWrite === false)).toBe(true);

    await expect.poll(readPaintColours, { timeout: 30_000 }).toHaveLength(10);
    const previewPaintColours = await readPaintColours();
    expect(colourByState(previewPaintColours, paintedResources)).toEqual(recoloured);
    const previewShellColours = await readColours();
    expect(previewShellColours).toHaveLength(10);
    expect(previewShellColours.every((material) => material.opacity === 0.15
      && material.transparent
      && material.depthWrite === false)).toBe(true);
    const previewResources = await readResources();
    expect(previewResources).toHaveLength(2);
    expect(previewResources.filter((resource) => resource.paintGeometryUuid)).toHaveLength(2);
    expect(previewResources.filter((resource) => resource.paintGeometryUuid).every((resource) => resource.paintDisplayRaycastDisabled
      && resource.visibleGeometryUuid === resource.paintGeometryUuid
      && resource.visibleUsesBvhRaycast === false
      && resource.originalPickVisible === null)).toBe(true);
    await expect.poll(readCenters, { timeout: 30_000 }).toHaveLength(2);
  } finally {
    await app.close();
  }
});
