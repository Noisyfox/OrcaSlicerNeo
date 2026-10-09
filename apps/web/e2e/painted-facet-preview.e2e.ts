import { installSliceReceiptObserver, readSliceReceipts } from '../../desktop/e2e/runtime-receipts';
import { test, expect } from './browser-fixture';

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
  await installSliceReceiptObserver(page);
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
  const readSelection = () => page.evaluate(() =>
    (window.__orcaE2e?.modelSelectionIdentities as (() => unknown[]) | undefined)?.() ?? []);
  const selectCurrentBody = async (singlePart = false) => {
    const point = await page.evaluate(() => {
      const hooks = (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e;
      return hooks.projectWorldToScreen(hooks.modelWorldCenters()[0]);
    });
    const viewport = await page.getByTestId('viewport').boundingBox();
    if(singlePart)await page.keyboard.down('Alt');
    try { await page.mouse.click(viewport!.x + point.x, viewport!.y + point.y); }
    finally { if(singlePart)await page.keyboard.up('Alt'); }
    await expect.poll(readSelection).not.toHaveLength(0);
    const selected=await readSelection() as Array<{objectId:number;instanceId:number}>;
    expect(new Set(selected.map(v=>v.objectId)).size).toBe(1);
    expect(new Set(selected.map(v=>v.instanceId)).size).toBe(1);
    const currentMesh = await readMeshResponse() as {objects:Array<{objectId:number;instanceId:number}>};
    expect(selected.every(identity => currentMesh.objects.some(object =>
      object.objectId === identity.objectId && object.instanceId === identity.instanceId))).toBe(true);
    for (const channel of ['support', 'seam', 'fuzzy', 'paint'])
      await expect(page.getByTestId(`gizmo-btn-${channel}`)).toBeEnabled();
  };
  await selectCurrentBody();
  const beforeSliceSelection = await readSelection();

  // Preserve the imported five-state Preview contract before making any new
  // painting edits. The later phase proves the newly saved two-state result.
  await page.getByTestId('btn-slice').click();
  if (process.env.ORCA_WEB_NO_ISOLATION === '1') {
    await expect(page.getByTestId('slicer-status')).toHaveText('Slicing…');
    await page.locator('#app-tab-prepare').click();
    for (const channel of ['support','seam','fuzzy','paint']) await expect(page.getByTestId(`gizmo-btn-${channel}`)).toBeDisabled();
    await expect(page.getByTestId('painting-panel')).toHaveCount(0);
    expect(await readSelection()).toEqual(beforeSliceSelection);
    await test.info().attach('serial-reactive-painting-admission',{body:JSON.stringify({beforeSliceSelection,whileSlicingSelection:await readSelection(),allFourEntriesDisabled:true}),contentType:'application/json'});
  } else {
    await expect(page.getByTestId('btn-cancel-slice')).toBeEnabled();
    await page.getByTestId('btn-cancel-slice').click();
    await expect.poll(()=>page.getByTestId('slicer-status').textContent(),{timeout:120_000}).toMatch(/^(Ready|Error)$/);
    await test.info().attach('cancel-receipts',{body:JSON.stringify(await readSliceReceipts(page)),contentType:'application/json'});
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready');
    await expect(page.getByTestId('slicer-error')).toHaveCount(0);
    await page.locator('#app-tab-prepare').click();
    const afterCancelSelection = await readSelection();
    await selectCurrentBody();
    for(const channel of ['support','seam','fuzzy','paint'])await expect(page.getByTestId(`gizmo-btn-${channel}`)).toBeEnabled();
    await test.info().attach('threaded-native-cancel',{body:JSON.stringify({status:'Ready',beforeSliceSelection,afterCancelSelection,selectedAfterReselection:await readSelection(),allFourEntriesEnabled:true}),contentType:'application/json'});
    await page.getByTestId('btn-slice').click();
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
  await selectCurrentBody();
  await page.getByTestId('gizmo-btn-paint').click();
  await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase', 'idle');
  const painting = () => page.evaluate(() => (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e.paintingEvidence());
  const nativePoint = (await painting()).center;
  await page.mouse.move(nativePoint.x, nativePoint.y); await page.mouse.down();
  await expect.poll(async () => (await painting()).phase).toBe('drawing');
  await page.keyboard.press('Control+n');
  await expect(page.getByTestId('project-dirty-dialog')).toHaveCount(0);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase', 'idle');
  await page.getByRole('button', { name: 'Erase all', exact: true }).click();
  const committed = () => page.evaluate(() => (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e.paintingCommittedEvidence());
  await expect.poll(async () => (await committed())?.paint?.length ?? -1).toBe(0);
  await page.getByRole('radio', { name: 'Paint filament 2', exact: true }).click();
  await page.getByTestId('painting-tool-triangle').click();
  const paintPoint = (await painting()).center;
  await page.mouse.click(paintPoint.x, paintPoint.y);
  await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase', 'idle');
  await expect.poll(async () => (await committed())?.paint?.some((part: { groups: { stateId: number }[] }) =>
    part.groups.some((group) => group.stateId === 2))).toBe(true);
  const annotations = () => page.evaluate(() => (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e.paintingNativeFacetCounts());
  const adapterEvidence: Record<string, unknown> = {};
  for (const channel of ['support','seam','fuzzy']) {
    await page.getByTestId(`gizmo-btn-${channel}`).click();
    await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase','idle');
    expect((await painting()).channel).toBe(channel);
    await page.getByRole('button',{name:'Erase all',exact:true}).click();
    await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase','idle');
    await page.getByRole('radio',{name:channel==='fuzzy'?'Enable':'Enforce',exact:true}).click();
    await page.getByTestId('painting-tool-circle').click();
    const p=(await painting()).center;
    const q=(await painting()).center;await page.mouse.click(q.x,q.y);
    await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase','idle');
    const enabled=await annotations();expect(enabled[0].facetCounts[1]).toBeGreaterThan(0);
    if(channel!=='fuzzy') {
      await page.getByRole('radio',{name:'Block',exact:true}).click();await page.mouse.click(p.x,p.y);
      await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase','idle');
      const blocked=await annotations();expect(blocked[0].facetCounts[2]).toBeGreaterThan(0);
      await page.getByTestId('history-undo').click();
      await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase','idle');
      expect((await annotations()).map((v:any)=>v.facetCounts)).toEqual(enabled.map((v:any)=>v.facetCounts));
      adapterEvidence[`${channel}-block`]=blocked;
    }
    await page.getByRole('radio',{name:'Erase',exact:true}).click();const erasePoint=(await painting()).center;await page.mouse.click(erasePoint.x,erasePoint.y);
    await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase','idle');
    expect((await annotations())[0].facetCounts[1]).toBeLessThan(enabled[0].facetCounts[1]);
    await page.getByTestId('history-undo').click();
    await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase','idle');
    expect((await annotations()).map((v:any)=>v.facetCounts)).toEqual(enabled.map((v:any)=>v.facetCounts));
    await page.getByRole('radio',{name:channel==='fuzzy'?'Enable':'Enforce',exact:true}).click();
    const shiftPoint=(await painting()).center;await page.keyboard.down('Shift');await page.mouse.click(shiftPoint.x,shiftPoint.y);await page.keyboard.up('Shift');
    await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase','idle');
    const erased=await annotations();expect(erased[0].facetCounts[1]).toBeLessThan(enabled[0].facetCounts[1]);
    await page.getByTestId('history-undo').click();
    await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase','idle');
    expect((await annotations()).map((v:any)=>v.facetCounts)).toEqual(enabled.map((v:any)=>v.facetCounts));
    for (const button of ['middle','right'] as const) {
      const before=await annotations();
      await page.mouse.move(p.x,p.y);await page.mouse.down({button});await page.mouse.move(p.x+10,p.y+5,{steps:3});await page.mouse.up({button});
      expect((await painting()).phase).toBe('idle');expect(await annotations()).toEqual(before);
    }
    const id=(await painting()).sessionId;
    await page.locator('#app-tab-home').click();await page.locator('#app-tab-prepare').click();
    expect((await painting()).sessionId).toBe(id);
    adapterEvidence[channel]={enabled,erased,sessionId:id};
  }
  await test.info().attach('four-channel-web-editing',{body:JSON.stringify(adapterEvidence,null,2),contentType:'application/json'});
  await page.getByTestId('gizmo-btn-paint').click();
  await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase','idle');
  const download = page.waitForEvent('download');
  await page.keyboard.press('Control+Shift+s');
  const saved = await download;
  expect(saved.suggestedFilename()).toMatch(/\.3mf$/);
  const savedModel = readZipEntries(readFileSync(await saved.path()))
    .find((entry) => entry.name === '3D/3dmodel.model');
  expect(savedModel).toBeDefined();
  const savedXml = new TextDecoder().decode(savedModel!.content);
  for (const field of ['paint_color','paint_supports','paint_seam','paint_fuzzy_skin']) expect(savedXml).toContain(`${field}=`);
  expect((savedXml.match(/paint_color=/g) ?? []).length).toBeLessThan(12);
  const paintedColours = new Map([[0, '#00ff00'], [2, '#00ff00']]);
  await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase', 'idle');
  expect((await painting()).channel).toBe('mmu');
  await page.locator('#app-tab-home').click();
  await page.locator('#app-tab-prepare').click();
  await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase', 'idle');
  expect((await painting()).channel).toBe('mmu');
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
  // Reopen the actual browser download through the real chooser, then compare
  // exact canonical native streams from a second standard 3MF download.
  const downloadedBytes=readFileSync(await saved.path());
  const reopenChooser=page.waitForEvent('filechooser');
  await page.getByTestId('titlebar-menu-trigger').click();
  await page.getByTestId('menu-file-trigger').hover();
  await page.locator('[data-slot="menubar-sub-content"]').hover({position:{x:8,y:8}});
  await page.getByTestId('file-open-project').click();
  await (await reopenChooser).setFiles({name:saved.suggestedFilename(),mimeType:'application/octet-stream',buffer:downloadedBytes});
  await expect.poll(readLoadStage,{timeout:180_000}).toMatch(/^(choice|confirmation|progress:|receipt)$/);
  if(await page.getByTestId('project-load-choice-dialog').isVisible().catch(()=>false)) {
    await page.getByTestId('project-load-project').click();await page.getByTestId('project-load-confirm').click();
  }
  await expect.poll(async()=>await page.getByTestId('project-load-confirmation-dialog').isVisible().catch(()=>false) ||
    (await page.evaluate(()=> (window as unknown as {__orcaE2e:Record<string,any>}).__orcaE2e.projectLoadEvidence().receipt))?.sourceByteLength===downloadedBytes.length,{timeout:180_000}).toBe(true);
  if(await page.getByTestId('project-load-confirmation-dialog').isVisible().catch(()=>false))await page.getByTestId('project-load-confirmation-dialog-continue').click();
  await expect.poll(()=>page.evaluate(()=> (window as unknown as {__orcaE2e:Record<string,any>}).__orcaE2e.projectLoadEvidence().receipt),{timeout:180_000})
    .toMatchObject({sourceDisplayName:saved.suggestedFilename(),sourceByteLength:downloadedBytes.length,nativeResult:{ok:true,objects:1,instances:2}});
  await expect(page.getByTestId('project-progress-dialog')).toHaveCount(0);
  await page.locator('#app-tab-prepare').click();
  await expect.poll(readResources,{timeout:120_000}).toHaveLength(2);
  expect(colourByState(await readMaterials())).toEqual(paintedColours);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  // Reload restores the native object selection mode. Alt uses the existing
  // single-instance part pick rather than selecting both shared instances.
  await selectCurrentBody(true);
  await test.info().attach('reopened-painting-target',{body:JSON.stringify(await readSelection()),contentType:'application/json'});
  for(const channel of ['support','seam','fuzzy','paint']) {
    await page.getByTestId(`gizmo-btn-${channel}`).click();
    await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase','idle');
    const counts=await annotations();expect(counts[0].facetCounts[channel==='paint'?2:1]).toBeGreaterThan(0);
  }
  const redownload=page.waitForEvent('download');await page.keyboard.press('Control+Shift+s');
  const reopenedSaved=await redownload;
  const reopenedXml=new TextDecoder().decode(readZipEntries(readFileSync(await reopenedSaved.path())).find(e=>e.name==='3D/3dmodel.model')!.content);
  const fields=(xml:string)=>[...xml.matchAll(/<triangle\b[^>]*\/>/g)].map(([triangle])=>Object.fromEntries(
    ['paint_color','paint_supports','paint_seam','paint_fuzzy_skin'].map(field=>[field,triangle.match(new RegExp(`${field}="([^"]*)"`))?.[1]??''])));
  expect(fields(reopenedXml)).toEqual(fields(savedXml));
  await test.info().attach('four-channel-download-reopen',{body:JSON.stringify({bytes:downloadedBytes.length,fields:fields(reopenedXml)},null,2),contentType:'application/json'});

});
