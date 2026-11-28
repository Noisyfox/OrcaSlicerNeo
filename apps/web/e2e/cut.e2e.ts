import { test, expect } from './browser-fixture';
import { waitForProjectLoad } from '../../desktop/e2e/project-menu';
import { cutDraftJourney, cutProjectJourney, openCutCube } from '../../desktop/e2e/cut-journey';
test.skip(process.env.ORCA_E2E_REAL !== '1', 'requires built Cut WASM');
test.setTimeout(300_000);
test('Cut draft in Prepare', async ({ page }) => {
  await page.goto('/');
  await cutDraftJourney(page);
});

test('applied Cut survives project history, Web 3MF download, reopen and slicing', async ({ page }, info) => {
  await page.goto('/');
  await cutProjectJourney(page, async () => {
    const download = page.waitForEvent('download');
    await page.keyboard.press('Control+Shift+s');
    const exported = await download, path = info.outputPath('web-cut.3mf');
    await exported.saveAs(path);
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('titlebar-menu-trigger').click(); await page.getByTestId('menu-file-trigger').hover();
    await page.locator('[data-slot="menubar-sub-content"]').hover({position:{x:8,y:8}});
    await page.getByTestId('file-open-project').click();
    await (await chooser).setFiles(path);
    await waitForProjectLoad(page);
    await expect.poll(() => page.evaluate(() => (window as any).__orcaE2e.projectLoadEvidence().receipt))
      .toMatchObject({ sourceDisplayName: 'web-cut.3mf', nativeResult: { ok: true, objects: 2 } });
  });
});

test('right release reassigns the nearest cut piece; a right drag pans', async ({ page }) => {
  await page.goto('/');
  const { viewport, panel } = await openCutCube(page);
  const probePoint = await page.evaluate(() => {
    const probe = (window as any).__orcaE2e, { center, max } = probe.selectionBoundsWorld();
    probe.setCameraView([center[0],center[1],300], center);
    return probe.projectWorldToScreen([center[0],center[1],max[2]]);
  });
  const rect = (await viewport.locator('canvas[data-engine^="three.js"]').boundingBox())!;
  const x = rect.x+probePoint.x, y = rect.y+probePoint.y;
  await page.mouse.move(x,y); await page.mouse.down({ button: 'right' });
  await expect(panel.getByTestId('cut-piece-count')).toHaveCount(0);
  await page.mouse.up({ button: 'right' });
  await expect(panel.getByTestId('cut-piece-count')).toHaveText('1 reassigned', { timeout: 30_000 });
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.mouse.move(x,y); await page.mouse.down({ button: 'right' });
  await page.mouse.move(x+24,y+14,{ steps: 4 }); await page.mouse.up({ button: 'right' });
  await expect(panel.getByTestId('cut-piece-count')).toHaveText('1 reassigned');
  await viewport.focus(); await page.keyboard.press('ArrowUp');
  await expect(panel.getByTestId('cut-piece-count')).toHaveCount(0);
  await page.getByTestId('history-undo').click();
  await expect(panel.getByTestId('cut-piece-count')).toHaveText('1 reassigned');
});

test('connector editor confirms a dowel, cancels a second visit and applies the detached pin', async ({ page }) => {
  await page.goto('/');
  const { viewport, panel, objects } = await openCutCube(page);
  const editor = page.getByTestId('cut-connectors');
  await panel.getByRole('button', { name: 'Connectors' }).click();
  const center = await page.evaluate(() => {
    const probe = (window as any).__orcaE2e, { center } = probe.selectionBoundsWorld();
    probe.setCameraView([center[0],center[1],300], center);
    return probe.projectWorldToScreen(center);
  });
  const rect = (await viewport.locator('canvas[data-engine^="three.js"]').boundingBox())!;
  await page.mouse.click(rect.x+center.x, rect.y+center.y);
  await editor.getByRole('combobox',{name:'Type',exact:true}).selectOption('dowel');
  await editor.getByRole('button',{name:'Confirm'}).click();
  await panel.getByRole('button',{name:'Connectors (1)'}).click();
  await editor.getByRole('button',{name:'Remove all'}).click();
  await editor.getByRole('button',{name:'Cancel'}).click();
  await expect(panel.getByRole('button',{name:'Connectors (1)'})).toBeVisible();
  await panel.getByRole('button',{name:'Perform cut'}).click();
  await expect(objects).toHaveCount(3, { timeout: 40_000 });
  await page.getByTestId('history-undo').click();
  await expect(objects).toHaveCount(1);
});
