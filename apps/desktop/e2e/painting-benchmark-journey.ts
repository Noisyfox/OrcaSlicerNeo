import { expect, type Page } from '@playwright/test';
import { statSync } from 'node:fs';
import { basename } from 'node:path';

type Probe = { channel: string; phase: string; center: { x: number; y: number }; input: { admittedMoves: number; droppedMoves: number };
  sessionId: string; resources: unknown[]; error: string | null };

/** All inputs use the real canvas/panel commands. The probe only observes. */
export async function paintingBenchmarkJourney(page: Page, project: string, host: 'electron' | 'web', openNativeProject?: () => Promise<void>) {
  const channel = process.env.ORCA_PAINTING_BENCHMARK_CHANNEL ?? 'mmu';
  const entry = channel === 'mmu' ? 'gizmo-btn-paint' : `gizmo-btn-${channel}`;
  const setPaintState = async (state: 1 | 2) => {
    await page.getByRole('radio', { name: channel === 'mmu' ? `Paint filament ${state}` : channel === 'fuzzy' ? 'Enable' : state === 1 ? 'Enforce' : 'Block', exact: true }).click();
  };
  const stamps: Record<string, number[]> = {};
  const measure = async (name: string, action: () => Promise<void>) => {
    const start = performance.now(); await action(); (stamps[name] ??= []).push(performance.now() - start);
  };
  const hook = (name: string) => page.evaluate((key) => {
    const api = (window as unknown as { __orcaE2e?: Record<string, (...args: never[]) => unknown> }).__orcaE2e;
    return api?.[key]?.() ?? null;
  }, name);
  const read = () => hook('paintingBenchmarkState') as Promise<Probe>;
  const perf = () => hook('paintingPerformanceEvidence');
  const idle = async (allowEmptyDisplay = false) => {
    await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase', 'idle', { timeout: 120_000 });
    if (!allowEmptyDisplay) await expect.poll(async () => (await read())?.resources.length ?? 0).toBeGreaterThan(0);
    expect((await read()).error).toBeNull();
  };
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
  await page.locator('#app-tab-prepare').click();
  const browserEnvironment = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="viewport"] canvas');
    const gl = canvas?.getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return { userAgent: navigator.userAgent, deviceMemoryGiB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
      webglVendor: gl?.getParameter(debug?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR) ?? null,
      webglRenderer: gl?.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) ?? null,
      glVersion: gl?.getParameter(gl.VERSION) ?? null };
  });
  await measure('projectLoad', async () => {
    const chooser = host === 'web' ? page.waitForEvent('filechooser') : null;
    if (openNativeProject) await openNativeProject();
    else {
    if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
      await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
      await page.getByTestId('titlebar-menu-trigger').click();
    }
    await page.getByTestId('menu-file-trigger').hover();
    await page.locator('[data-slot=\"menubar-sub-content\"]').hover({ position: { x: 8, y: 8 } }); await page.getByTestId('file-open-project').click();
    }
    if (chooser) await (await chooser).setFiles(project);
    await expect.poll(async () => !!(await hook('projectLoadEvidence') as { receipt?: unknown } | null)?.receipt ||
      await page.getByTestId('project-load-choice-dialog').isVisible().catch(() => false) ||
      await page.getByTestId('project-load-confirmation-dialog').isVisible().catch(() => false) ||
      await page.getByTestId('project-progress-dialog').isVisible().catch(() => false), { timeout: 120_000 }).toBe(true);
    if (await page.getByTestId('project-load-choice-dialog').isVisible().catch(() => false)) {
      await page.getByTestId('project-load-project').click(); await page.getByTestId('project-load-confirm').click();
    }
    await expect.poll(async () => !!(await hook('projectLoadEvidence') as { receipt?: unknown } | null)?.receipt ||
      await page.getByTestId('project-load-confirmation-dialog').isVisible().catch(() => false), { timeout: 120_000 }).toBe(true);
    if (await page.getByTestId('project-load-confirmation-dialog').isVisible().catch(() => false))
      await page.getByTestId('project-load-confirmation-dialog-continue').click();
    await expect.poll(async () => (await hook('projectLoadEvidence') as { receipt?: { sourceDisplayName: string; sourceByteLength: number } } | null)?.receipt,
      { timeout: 180_000 }).toMatchObject({ sourceDisplayName: basename(project), sourceByteLength: statSync(project).size });
  });
  const receipt = (await hook('projectLoadEvidence') as { receipt: unknown }).receipt;
  // The load receipt precedes the asynchronous renderer mesh publication.
  await expect.poll(async () => (await hook('modelWorldCenters') as unknown[])?.length ?? 0,
    { timeout: 120_000 }).toBeGreaterThan(0);
  const center = await page.evaluate(() => {
    const e = (window as unknown as { __orcaE2e: Record<string, (...args: never[]) => unknown> }).__orcaE2e;
    const world = e.modelWorldCenters() as [number, number, number][];
    return (e.projectWorldToScreen as (p: [number, number, number]) => { x: number; y: number })(world[0]);
  });
  const bounds = await page.getByTestId('viewport').boundingBox();
  if (!bounds) throw new Error('viewport missing');
  await page.mouse.click(bounds.x + center.x, bounds.y + center.y);
  await expect(page.getByTestId(entry)).toBeEnabled();
  if (process.env.ORCA_PAINTING_BENCHMARK_CLOSE_ONLY === '1') {
    const cycles = [];
    const workloads = process.env.ORCA_PAINTING_BENCHMARK_CLOSE_EDITS === '1'
      ? ['noop', 'paint', 'undo', 'separator'] : ['noop', 'noop', 'noop'];
    type History = { editingSession: unknown; navigationFloor: number | null; cursor: number; dirty: boolean; savedCheckpoint: number | null;
      undoEntries: Array<{ id: string; label: string }>; redoEntries: Array<{ id: string; label: string }> };
    type PrepareResource = { id: string; originalGeometryUuid: string; paintGroupStates: number[]; visibleGeometryUuid: string | null; paintGeometryUuid: string | null };
    for (const [cycle, workload] of workloads.entries()) {
      const originalResources = await hook('modelPaintResources') as PrepareResource[];
      await page.getByTestId(entry).click(); await idle();
      const targetId = (await read() as Probe & { nativeTarget: { objectId: number } }).nativeTarget.objectId;
      if (workload !== 'noop') {
        await page.getByRole('button', { name: 'Erase all', exact: true }).click(); await idle();
        await page.getByTestId(`painting-tool-${channel === 'support' || channel === 'seam' ? 'sphere' : 'triangle'}`).click();
        await setPaintState(channel === 'fuzzy' ? 1 : 2);
        const point = (await read()).center;
        await page.mouse.click(point.x, point.y); await idle();
        const calls = (await perf() as { calls: Array<{ name: string; committed?: boolean }> }).calls;
        expect(calls.filter((call) => call.name === 'commitPaintingStroke').at(-1)?.committed).toBe(true);
        if (workload === 'undo') { await page.getByTestId('history-undo').click(); await idle(); }
        if (workload === 'separator') {
          await page.getByTestId('filament-colour-2').evaluate((element) => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, '#445566');
            element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
          });
          await expect.poll(async () => (await hook('historyNativeStatus') as { undoEntries: Array<{ label: string }> }).undoEntries[0]?.label)
            .toBe('Edit Filament Colour'); await idle();
        }
      }
      const facets = await hook('paintingNativeFacetCounts');
      const before = await hook('historyNativeStatus') as History;
      const button = page.getByRole('button', { name: 'Close painting', exact: true });
      await button.evaluate((element) => element.addEventListener('pointerup', () => {
        (window as unknown as { __orcaCloseInputAt: number }).__orcaCloseInputAt = performance.now();
      }, { capture: true, once: true }));
      await button.click(); await expect(page.getByTestId('painting-panel')).toHaveCount(0);
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
      const final = await page.evaluate(() => ({
        resources: (window as unknown as { __orcaPaintingBenchmarkFinal: { at: number; calls: Array<{ name: string; at: number; retainedVolumes?: number; volumeCount?: number; touchedVolumeCount?: number; objectIds?: number[]; exportedSourceGeometries?: number }>; liveResources: number } }).__orcaPaintingBenchmarkFinal,
        inputAt: (window as unknown as { __orcaCloseInputAt: number }).__orcaCloseInputAt,
      }));
      expect(final.resources.liveResources).toBe(0);
      const after = await hook('historyNativeStatus') as History;
      expect(after.editingSession).toBeNull(); expect(after.navigationFloor).toBeNull(); expect(after.cursor).toBe(before.cursor);
      if (workload === 'noop') {
        expect(after.undoEntries).toEqual(before.undoEntries); expect(after.redoEntries).toEqual(before.redoEntries);
        expect(after.dirty).toBe(before.dirty); expect(after.savedCheckpoint).toBe(before.savedCheckpoint);
      } else {
        expect(after.redoEntries).toEqual([]);
        expect(after.undoEntries.filter((e) => e.label !== 'Paint')).toEqual(before.undoEntries.filter((e) => e.label !== 'Paint'));
      }
      const shown = await hook('modelPaintResources') as PrepareResource[];
      expect(shown.map((r) => [r.id, r.originalGeometryUuid])).toEqual(originalResources.map((r) => [r.id, r.originalGeometryUuid]));
      const targetIds = new Set((await hook('modelSelectionIdentities') as Array<{ id: string; objectId: number }>)
        .filter((v) => v.objectId === targetId).map((v) => v.id));
      const targetResources = shown.filter((r) => targetIds.has(r.id));
      if (channel === 'mmu' && (workload === 'paint' || workload === 'separator')) {
        expect(targetResources.some((r) => r.paintGroupStates.includes(2))).toBe(true);
        expect(targetResources.filter((r) => r.paintGeometryUuid).every((r) => r.visibleGeometryUuid === r.paintGeometryUuid)).toBe(true);
      }
      if (channel === 'mmu' && workload === 'undo') expect(targetResources.every((r) => r.paintGeometryUuid === null)).toBe(true);
      if (process.env.ORCA_PAINTING_EXPECT_INCREMENTAL_CLOSE === '1') {
        const closeCalls = final.resources.calls.filter((call) => call.at >= final.inputAt);
        expect(closeCalls.some((call) => call.name === 'getModelMesh')).toBe(false);
        const prepare = closeCalls.find((call) => call.name === 'prepareClosed')!;
        const patch = closeCalls.find((call) => call.name === 'getModelScenePatch');
        if (workload === 'noop') { expect(patch).toBeUndefined(); expect(prepare.retainedVolumes).toBe(prepare.volumeCount); }
        else {
          expect(patch?.objectIds).toEqual([targetId]); expect(patch?.exportedSourceGeometries).toBe(0);
          expect(prepare.retainedVolumes).toBe(prepare.volumeCount! - prepare.touchedVolumeCount!);
        }
      }
      cycles.push({ cycle, workload, facets, before, after, prepare: targetResources, ...final,
        inputToDisposedMs: final.resources.at - final.inputAt });
    }
    return { host, channel, project, browserEnvironment, receipt, closeOnly: true, cycles };
  }
  await measure('open', async () => { await page.getByTestId(entry).click(); await idle(); });
  const session = await read();
  expect(session.channel).toBe(channel);
  const facets: Record<string, unknown> = { initial: await hook('paintingNativeFacetCounts') };
  const smallFixture=(facets.initial as Array<{sourceTriangleCount:number}>).every(part=>part.sourceTriangleCount<=12);
  const observer=await page.evaluate(checkFull=> {
    const hook=(window as unknown as {__orcaE2e:Record<string,()=>any>}).__orcaE2e;
    let totalCpuMs=0,maxCpuMs=0,compact;
    for(let i=0;i<100;i++) {
      const start=performance.now();compact=hook.paintingBenchmarkState();
      const ms=performance.now()-start;totalCpuMs+=ms;maxCpuMs=Math.max(maxCpuMs,ms);
    }
    let fullAgreement:boolean|null=null;
    if(checkFull) {
      const full=hook.paintingEvidence();
      const comparable=(state:any)=>({phase:state.phase,channel:state.channel,tool:state.tool,settings:state.settings,sessionId:state.sessionId,
        center:state.center,rendered:state.rendered,nativeTarget:{objectId:state.nativeTarget.objectId,revision:state.nativeTarget.revision},
        resources:state.resources.map((resource:any)=>({kind:resource.kind,resourceId:resource.resourceId??resource.id}))});
      fullAgreement=JSON.stringify(comparable(compact))===JSON.stringify(comparable(full));
    }
    return {reads:100,totalCpuMs,maxCpuMs,fullAgreement};
  },smallFixture);
  if(smallFixture)expect(observer.fullAgreement).toBe(true);
  const toolOutcomes: Record<string, unknown> = {};
  let gapPreview: { candidateResources: number; areaMm2: number; revision: number } | null = null;
  await measure('eraseAll', async () => { await page.getByRole('button', { name: 'Erase all', exact: true }).click(); await idle(); });
  const tools = channel === 'mmu' ? ['circle', 'sphere', 'triangle', 'height', 'region']
    : channel === 'seam' ? ['circle', 'sphere']
      : channel === 'support' ? ['circle', 'sphere', 'smartFill'] : ['circle', 'sphere', 'triangle', 'smartFill'];
  await setPaintState(channel === 'fuzzy' ? 1 : 2);
  for (const tool of tools) {
    if (tool !== 'circle') { await page.getByRole('button', { name: 'Erase all', exact: true }).click(); await idle(); }
    await page.getByTestId(`painting-tool-${tool}`).click();
    if (tool === 'circle' || tool === 'sphere') await page.getByRole('spinbutton', { name: 'Radius (mm)', exact: true }).fill('2');
    if (tool === 'smartFill') await page.getByRole('spinbutton', { name: 'Edge angle (degrees)', exact: true }).fill('90');
    if (tool === 'height') await page.getByRole('spinbutton', { name: 'Height (mm)', exact: true }).fill('5');
    const point = (await read()).center;
    await measure(`stroke-${tool}`, async () => { await page.mouse.click(point.x, point.y); await idle(); });
    facets[tool] = await hook('paintingNativeFacetCounts');
    toolOutcomes[tool] = (await perf() as { calls: Array<{ name: string; committed?: boolean }> }).calls
      .filter((call) => call.name === 'commitPaintingStroke').at(-1)?.committed ?? null;
    if (tool === 'circle') {
      facets.radius2 = await hook('paintingNativeFacetCounts');
      await page.getByRole('button', { name: 'Erase all', exact: true }).click(); await idle();
      await page.getByRole('spinbutton', { name: 'Radius (mm)', exact: true }).fill('0.3');
      await measure('stroke-circle-radius0.3', async () => { await page.mouse.click(point.x + 2, point.y + 2); await idle(); });
      facets.radius0_3 = await hook('paintingNativeFacetCounts');
      toolOutcomes.circleRadius0_3 = (await perf() as { calls: Array<{ name: string; committed?: boolean }> }).calls
        .filter((call) => call.name === 'commitPaintingStroke').at(-1)?.committed ?? null;
    }
  }
  if (channel === 'mmu' || channel === 'support') {
  await page.getByRole('button', { name: 'Erase all', exact: true }).click(); await idle();
  await page.getByTestId('painting-tool-circle').click();
  await setPaintState(1);
  await page.getByRole('spinbutton', { name: 'Radius (mm)', exact: true }).fill('0.3');
  const gapSeed = (await read()).center;
  await page.mouse.click(gapSeed.x, gapSeed.y); await idle();
  const gapRequestAt=await page.evaluate(()=> { const at=performance.now(); (window as unknown as {__orcaGapRequestAt:number}).__orcaGapRequestAt=at; return at; });
  await page.getByTestId('painting-tool-gap').click();
  await page.getByRole('spinbutton', { name: 'Gap area (mm²)', exact: true }).fill('3');
  let gapRevision=-1;
  await expect.poll(async () => {
    const calls=((await perf()) as { calls: Array<{name:string;tool?:string;settings?:{gapArea?:number};at:number;ms:number;revision?:number}> }).calls;
    const preview=calls.filter(call=>call.name==='previewPainting' && call.tool==='gap' && call.settings?.gapArea===3 && call.at>=gapRequestAt).at(-1);
    const geometry=preview && calls.find(call=>call.name==='getPaintingGeometry' && call.at>=preview.at+preview.ms && call.revision===preview.revision);
    const display=await read() as Probe & {rendered:{revision:number};nativeTarget:{revision:number}};
    if(!geometry || display.rendered.revision!==geometry.revision || display.nativeTarget.revision!==geometry.revision)return false;
    gapRevision=geometry.revision!;return true;
  }).toBe(true);
  await idle(true);
  gapPreview = {candidateResources:(await read()).resources.filter((r: unknown) => (r as { kind?: string }).kind === 'gap').length,areaMm2:3,revision:gapRevision};
  const beforeGap=await hook('paintingNativeFacetCounts');
  const historyBeforeGap=await hook('historyNativeStatus') as {undoEntries:unknown[]};
  await measure('gap', async () => { await page.getByRole('button', { name: channel === 'support' ? 'Apply gaps' : 'Apply gap fill', exact: true }).click(); await idle(true); });
  facets.gap = await hook('paintingNativeFacetCounts');
  toolOutcomes.gap = (await perf() as { calls: Array<{ name: string; committed?: boolean }> }).calls
    .filter((call) => call.name === 'commitPaintingStroke').at(-1)?.committed ?? null;
  if(gapPreview.candidateResources===0) {
    expect(toolOutcomes.gap).toBe(false);
    const annotationCounts=(parts:unknown)=> (parts as Array<{facetCounts:number[]}>).map(part=>part.facetCounts);
    expect(annotationCounts(facets.gap)).toEqual(annotationCounts(beforeGap));
    expect((await hook('historyNativeStatus') as {undoEntries:unknown[]}).undoEntries).toEqual(historyBeforeGap.undoEntries);
  }
  }
  await page.getByTestId(channel === 'seam' || channel === 'support' ? 'painting-tool-sphere' : 'painting-tool-triangle').click();
  const point = (await read()).center;
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await expect.poll(async () => (await read()).phase).toBe('drawing');
  await expect.poll(async()=> {
    const state=await read() as Probe & {nativeTarget:{strokeId:string|null;revision:number};rendered:{revision:number}};
    return !!state.nativeTarget.strokeId && state.rendered.revision===state.nativeTarget.revision;
  }).toBe(true);
  const inputBefore = (await read()).input;
  await measure('continuousTerminal', async () => {
    await page.evaluate((p) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="viewport"] canvas')!;
      for (let i = 0; i < 40; i++) canvas.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: p.x + i / 50, clientY: p.y + i / 50,
      }));
      canvas.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0, clientX: p.x + 2, clientY: p.y + 2,
      }));
    }, point);
    await page.mouse.up(); await idle();
  });
  const inputAfter = (await read()).input;
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await expect.poll(async () => (await read()).phase).toBe('drawing');
  await measure('escapeTerminal', async () => { await page.keyboard.press('Escape'); await page.mouse.up(); await idle(); });
  await measure('undo', async () => { await page.getByTestId('history-undo').click(); await idle(); });
  await measure('redo', async () => { await page.getByTestId('history-redo').click(); await idle(); });
  const expandedHistory = await hook('historyNativeStatus');
  const beforeClose = await perf();
  const closeButton = page.getByRole('button', { name: 'Close painting', exact: true });
  const armCloseInput = async (cycle: 'first' | 'second') => closeButton.evaluate((button, key) => {
    button.addEventListener('pointerup', () => {
      (window as unknown as { __orcaBenchmarkCloseInput?: Record<string, number> }).__orcaBenchmarkCloseInput ??= {};
      (window as unknown as { __orcaBenchmarkCloseInput: Record<string, number> }).__orcaBenchmarkCloseInput[key] = performance.now();
    }, { capture: true, once: true });
  }, cycle);
  const closeInputAt = (cycle: 'first' | 'second') => page.evaluate((key) =>
    (window as unknown as { __orcaBenchmarkCloseInput?: Record<string, number> }).__orcaBenchmarkCloseInput?.[key] ?? null, cycle);
  await armCloseInput('first');
  await measure('close', async () => {
    await closeButton.click();
    await expect(page.getByTestId('painting-panel')).toHaveCount(0);
  });
  const compactedHistory = await hook('historyNativeStatus');
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const afterClose = await page.evaluate(() => (window as unknown as { __orcaPaintingBenchmarkFinal?: unknown }).__orcaPaintingBenchmarkFinal ?? null);
  const firstCloseInput = await closeInputAt('first');
  const firstCloseLatencyMs = firstCloseInput === null ? null : (afterClose as { at: number }).at - firstCloseInput;
  // A second session on the same project catches retained geometry and wrapper
  // ownership that a single unmount cannot expose.
  await measure('reopen', async () => { await page.getByTestId(entry).click(); await idle(); });
  const reopened = await read();
  await page.getByRole('button', { name: 'Erase all', exact: true }).click(); await idle();
  const reopenReset = ((await perf()) as { calls: Array<{ name: string; committed?: boolean }> }).calls
    .filter((call) => call.name === 'commitPaintingStroke').at(-1);
  await page.getByTestId('painting-tool-circle').click();
  await setPaintState(1);
  await measure('reopenStroke', async () => { await page.mouse.click(reopened.center.x, reopened.center.y); await idle(); });
  const reopenBeforeClose = await perf();
  const reopenStroke = (reopenBeforeClose as { calls: Array<{ name: string; committed?: boolean }> }).calls
    .filter((call) => call.name === 'commitPaintingStroke').at(-1);
  expect(reopenReset?.committed || reopenStroke?.committed).toBe(true);
  await armCloseInput('second');
  await measure('reclose', async () => {
    await closeButton.click();
    await expect(page.getByTestId('painting-panel')).toHaveCount(0);
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const reopenAfterClose = await page.evaluate(() => (window as unknown as { __orcaPaintingBenchmarkFinal?: unknown }).__orcaPaintingBenchmarkFinal ?? null);
  const secondCloseInput = await closeInputAt('second');
  const secondCloseLatencyMs = secondCloseInput === null ? null : (reopenAfterClose as { at: number }).at - secondCloseInput;
  return { host, channel, project, browserEnvironment, receipt, automationWallMs: stamps, input: { admitted: inputAfter.admittedMoves - inputBefore.admittedMoves,
    dropped: inputAfter.droppedMoves - inputBefore.droppedMoves, after: inputAfter },
    sessionParts: session.resources.length, observer, facets, gapPreview, toolOutcomes, beforeClose, expandedHistory, compactedHistory,
    afterClose: { paintingPanelCount: await page.getByTestId('painting-panel').count(), resources: afterClose,
      inputToDisposedMs: firstCloseLatencyMs },
    reopened: { beforeClose: reopenBeforeClose, afterClose: reopenAfterClose,
      resetCommitted: reopenReset?.committed, strokeCommitted: reopenStroke?.committed,
      inputToDisposedMs: secondCloseLatencyMs } };
}
