import { test, expect } from './browser-fixture';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { waitForProjectLoad } from '../../desktop/e2e/project-menu';


test('real Project process catalogue includes object and region defaults and edits Fuzzy skin', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  await expect(page.getByTestId('config-mode-project')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Search settings', exact: true }).click();
  const search = page.getByTestId('scoped-config-search');

  await search.fill('Wipe tower rotation angle');
  const rotation = page.getByTestId('config-input-wipe_tower_rotation_angle');
  const rotationLabel = page.getByTestId('config-option-label-wipe_tower_rotation_angle');
  const inheritedRotation = await rotation.inputValue();
  await expect(rotationLabel).toHaveAttribute('data-local-override-highlight', 'false');
  await rotation.fill('63');
  await rotation.press('Enter');
  await expect(rotationLabel).toHaveAttribute('data-local-override-highlight', 'true');
  await page.getByTestId('config-reset-wipe_tower_rotation_angle').click();
  await expect(rotation).toHaveValue(inheritedRotation);
  await expect(rotationLabel).toHaveAttribute('data-local-override-highlight', 'false');

  // Use the actual Worker metadata rather than a mocked scope list, covering
  // representative Quality, Strength, Speed, Support and Other defaults.
  for (const [key, label] of [
    ['layer_height', 'Layer height'], ['wall_loops', 'Wall loops'],
    ['inner_wall_speed', 'Inner wall'], ['enable_support', 'Enable support'],
    ['seam_position', 'Seam position'],
  ]) {
    await search.fill(label);
    await expect(page.getByTestId(`config-field-${key}`)).toBeVisible();
  }
  for (const [key, label] of [
    ['staggered_inner_seams', 'Staggered inner seams'],
    ['gcode_add_line_number', 'Add line number'], ['gcode_comments', 'Verbose G-code'],
    ['gcode_label_objects', 'Label objects'],
  ]) {
    await search.fill(label);
    const field = page.getByTestId(`config-field-${key}`);
    await expect(field).toBeVisible();
    const checkbox = field.getByRole('checkbox');
    const inherited = await checkbox.getAttribute('aria-checked');
    await checkbox.click();
    await expect(checkbox).toHaveAttribute('aria-checked', inherited === 'true' ? 'false' : 'true');
    await expect(page.getByTestId(`config-option-label-${key}`))
      .toHaveAttribute('data-local-override-highlight', 'true');
    await page.getByTestId(`config-reset-${key}`).click();
    await expect(checkbox).toHaveAttribute('aria-checked', inherited!);
    await expect(page.getByTestId(`config-option-label-${key}`))
      .toHaveAttribute('data-local-override-highlight', 'false');
  }
  for (const key of ['extruder_ams_count', 'process_change_extrusion_role_gcode']) {
    await search.fill(key);
    await expect(page.getByTestId(`config-field-${key}`)).toHaveCount(0);
  }
  await search.fill('Fuzzy skin');
  for (const key of ['fuzzy_skin', 'fuzzy_skin_thickness', 'fuzzy_skin_point_distance'])
    await expect(page.getByTestId(`config-field-${key}`)).toBeVisible();

  const thickness = page.getByTestId('config-input-fuzzy_skin_thickness');
  const inheritedThickness = await thickness.inputValue();
  await thickness.fill('0.42');
  await thickness.press('Enter');
  await expect(page.getByTestId('config-option-label-fuzzy_skin_thickness'))
    .toHaveAttribute('data-local-override-highlight', 'true');
  await expect(thickness).toHaveValue('0.42');

  const fuzzy = page.getByTestId('config-input-fuzzy_skin');
  await fuzzy.click();
  await page.getByRole('option', { name: 'All walls', exact: true }).click();
  await expect(fuzzy).toContainText('All walls');
  await expect(page.getByTestId('config-option-label-fuzzy_skin'))
    .toHaveAttribute('data-local-override-highlight', 'true');

  await expect(page.getByRole('option', { name: 'All walls', exact: true })).toHaveCount(0);
  // Search unmounts the field. Its native effective enum value and readable
  // label must survive creation of a fresh Select without registered items.
  await search.fill('Layer height');
  await expect(fuzzy).toHaveCount(0);
  await search.fill('Fuzzy skin');
  await expect(fuzzy).toContainText('All walls');
  await fuzzy.click();
  await expect(page.getByRole('option', { name: 'All walls', exact: true }))
    .toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(fuzzy).toContainText('All walls');

  await page.getByTestId('config-reset-fuzzy_skin_thickness').click();
  await expect(thickness).toHaveValue(inheritedThickness);
  await expect(page.getByTestId('config-option-label-fuzzy_skin_thickness'))
    .toHaveAttribute('data-local-override-highlight', 'false');
  await expect(fuzzy).toContainText('All walls');
  await expect(page.getByTestId('config-error-fuzzy_skin')).toHaveCount(0);
});


test('real Web extruder editors use the served native variant across browser project import and Worker edits', async ({page,context})=>{
  const fixture=process.env.ORCA_E2E_EXTRUDER_PROJECT;
  test.skip(!fixture || process.env.VITE_SCOPED_CONFIGURATION_GATE!=='1','Requires native indexed-editor Hybrid fixture and the existing execution probe');
  const root=resolve(import.meta.dirname,'../../..');
  const variant=process.env.ORCA_WEB_NO_ISOLATION==='1'?'serial':'threaded';
  const assets=new Map<string,{variant:string;served:string;deployed:string;expected:string}>();
  // Worker bodies can be evicted from Chrome's inspector cache. Capture the
  // production server response before forwarding those exact bytes to WASM.
  await context.route('**/wasm/**/*',async route=>{
    const match=new URL(route.request().url()).pathname.match(/\/wasm\/(serial|threaded)\/(orca_slice\.(?:js|wasm|data))$/);
    if(!match)return route.continue();
    const response=await route.fetch();const body=await response.body();
    const deployed=await readFile(resolve(root,'apps/web/dist/wasm',variant,match[2]));
    const native=await readFile(resolve(root,'packages/slicer-wasm/out',variant,match[2]));
    // Production packaging strips unreachable Node branches from the loader.
    const expected=match[2].endsWith('.js')?Buffer.from(native.toString('utf8')
      .replace(/node:(module|worker_threads|fs|path|url|util)/g,'web-only-disabled:$1')
      .replace(/globalThis\.process/g,'undefined')):native;
    const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
    assets.set(match[2],{variant:match[1],served:hash(body),deployed:hash(deployed),expected:hash(expected)});
    await route.fulfill({response,body});
  });
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready',{timeout:120_000});
  expect(await page.evaluate(()=>crossOriginIsolated)).toBe(variant==='threaded');
  await expect(page.getByTestId('serial-fallback-status')).toHaveCount(variant==='serial'?1:0);
  await page.locator('#app-tab-prepare').click();
  await page.waitForFunction(()=>Boolean((window as any).__orcaScopedConfigurationGate));
  expect(await page.evaluate(async()=>(await (window as any).__orcaScopedConfigurationGate.execution()).threaded)).toBe(variant==='threaded');
  expect([...assets.keys()].sort()).toEqual(['orca_slice.data','orca_slice.js','orca_slice.wasm']);
  for(const asset of assets.values()){expect(asset.variant).toBe(variant);expect(asset.served).toBe(asset.deployed);expect(asset.served).toBe(asset.expected);}
  console.log('[extruder-web-artifacts]',JSON.stringify({variant,hashes:Object.fromEntries(assets)}));
  const chooser=page.waitForEvent('filechooser');
  await page.getByTestId('titlebar-menu-trigger').click();await page.getByTestId('menu-file-trigger').hover();
  await page.locator('[data-slot="menubar-sub-content"]').hover({position:{x:8,y:8}});
  await page.getByTestId('file-open-project').click();await (await chooser).setFiles(fixture!);
  await waitForProjectLoad(page);
  await expect.poll(()=>page.evaluate(()=>(window as any).__orcaE2e.projectLoadEvidence())).toMatchObject({receipt:{sourceDisplayName:basename(fixture!),sourceByteLength:(await stat(fixture!)).size,nativeResult:{ok:true,mode:'project'}}});
  await page.getByTestId('config-page-Speed').click();
  const selection=page.getByTestId('print-editor-selection');await selection.click();
  const choices=await page.getByRole('option').allTextContents();expect(choices).toHaveLength(5);
  const hf=choices.find(label=>/3/.test(label)&&/High Flow/.test(label))!;
  const sf=choices.find(label=>/3/.test(label)&&/Standard/.test(label))!;
  await page.getByRole('option',{name:hf,exact:true}).click();
  const speed=page.getByTestId('config-input-outer_wall_speed');const previous=await speed.inputValue();
  await expect(page.getByTestId('config-field-outer_wall_speed')).toHaveAttribute('data-native-index','5');
  await speed.fill('189');await speed.press('Enter');await expect(speed).toBeEnabled();await expect(speed).toHaveValue('189');
  await selection.click();await page.getByRole('option',{name:sf,exact:true}).click();
  await expect(page.getByTestId('config-field-outer_wall_speed')).toHaveAttribute('data-native-index','4');await expect(speed).not.toHaveValue('189');
  await selection.click();await page.getByRole('option',{name:hf,exact:true}).click();
  await page.getByTestId('history-undo').click();await expect(speed).toHaveValue(previous);await expect(selection).toContainText(hf);
  await page.screenshot({path:resolve(root,`.vitest/extruder-step5-web-${variant}-print.png`)});
  await page.getByTestId('preset-edit-printer').click();await page.getByTestId('preset-editor-page-tab-extruder').click();
  await expect(page.getByTestId('preset-editor-flow-3')).toContainText('SF');
  await page.getByTestId('preset-editor-flow-3').click();await page.getByRole('option',{name:'HF',exact:true}).click();
  await expect(page.getByTestId('preset-editor-field-nozzle_diameter')).toHaveAttribute('title',/nozzle_diameter\[2\]/);
  await expect(page.getByTestId('preset-editor-field-retraction_length')).toHaveAttribute('title',/retraction_length\[5\]/);
  await page.getByTestId('preset-editor-close').click();await expect(selection).toContainText(hf);
  const rack=await page.getByTestId('filament-preset-1').getAttribute('title');
  await page.getByTestId('filament-slot-1').click({button:'right'});await page.getByTestId('filament-edit-1').click();
  await page.getByTestId('preset-editor-preset').click();await page.getByPlaceholder('Search presets to edit…').fill('Generic PLA');
  await page.getByRole('option').and(page.getByTitle('Generic PLA @System',{exact:true})).click();
  const filament=page.getByTestId('preset-editor-variant');await filament.click();await expect(page.getByRole('option')).toHaveCount(6);
  await page.getByRole('option',{name:'Bowden Extra High Flow',exact:true}).click();
  const ratio=page.getByTestId('preset-editor-input-filament_flow_ratio');const source=await page.getByTestId('preset-editor-source-filament_flow_ratio').textContent();
  await ratio.fill('1.09');await ratio.press('Enter');await expect(ratio).toBeEnabled();await expect(ratio).toHaveValue('1.09');
  await expect(page.getByTestId('preset-editor-field-filament_flow_ratio')).toHaveAttribute('title',/filament_flow_ratio\[5\]/);
  await ratio.scrollIntoViewIfNeeded();await page.screenshot({path:resolve(root,`.vitest/extruder-step5-web-${variant}-filament.png`)});
  await page.getByTestId('preset-editor-reset-field-filament_flow_ratio').click();await expect(ratio).toHaveValue(source!);
  await page.getByTestId('preset-editor-close').click();await expect(page.getByTestId('filament-preset-1')).toHaveAttribute('title',rack!);
});
