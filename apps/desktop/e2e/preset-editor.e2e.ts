import { _electron } from './electron-fixture';
import { expect, test, type Page } from '@playwright/test';
import type { ConfigEditorSnapshot, ScopedConfigEditorSnapshot } from '@slicer/client';
import { basename, resolve } from 'node:path';
import { statSync } from 'node:fs';
import { openProjectMenu, waitForProjectLoad } from './project-menu';
import { installSliceReceiptObserver, readSliceReceipts } from './runtime-receipts';

const DESKTOP_ROOT = resolve(__dirname, '..');
const REAL = process.env.ORCA_E2E_REAL === '1';

test('filament setting overrides edit all ironing controls using Process references', async () => {
  const env={...process.env,ORCA_E2E:'1'} as Record<string,string>; delete env.ELECTRON_RUN_AS_NODE;
  const app=await _electron.launch({args:['.'],cwd:DESKTOP_ROOT,env});
  try {
    const page=await app.firstWindow(); await expect(page.getByTestId('slicer-status')).toHaveText('Ready',{timeout:60_000});
    if (REAL && process.env.VITE_SCOPED_CONFIGURATION_GATE === '1') {
      expect(await page.evaluate(async () => (await (window as any).__orcaScopedConfigurationGate.execution()).threaded))
        .toBe(process.env.VITE_SCOPED_CONFIGURATION_GATE_VARIANT === 'threaded');
    }
    await page.locator('#app-tab-prepare').click();
    if (REAL) await selectFilamentPreset(page, 'Generic PLA @System', 'Generic PLA');
    await page.getByTestId('filament-slot-1').click({button:'right'}); await page.getByTestId('filament-edit-1').click();
    await expect(page.getByTestId('preset-editor-variant')).toBeVisible();
    const variants=page.getByTestId('preset-editor-variant'), choices=variants.getByRole('button');
    const naturalWidth=(await variants.boundingBox())!.width, availableWidth=(await variants.locator('..').boundingBox())!.width;
    expect(naturalWidth).toBeLessThan(availableWidth-24);
    await expect(variants.getByRole('combobox')).toHaveCount(0);
    await choices.first().focus(); await choices.first().press('ArrowRight');
    await expect(choices.nth(1)).toBeFocused(); await choices.nth(1).press('Space');
    await expect(choices.nth(1)).toHaveAttribute('aria-pressed','true');
    await choices.nth(1).click(); await expect(choices.nth(1)).toHaveAttribute('aria-pressed','true');
    const scroll=page.getByTestId('preset-editor-variant-scroll');
    const lastWidth=(await choices.last().boundingBox())!.width;
    await scroll.evaluate((element,width)=>{element.style.maxWidth=`${Math.ceil(width)+12}px`;},lastWidth);
    await choices.last().click(); await expect(choices.last()).toBeInViewport({ratio:0.99});
    await expect.poll(()=>scroll.evaluate(element=>element.scrollLeft)).toBeGreaterThan(0);
    await scroll.evaluate(element=>{element.scrollLeft=0;}); await scroll.hover(); await page.mouse.wheel(0,300);
    await expect.poll(()=>scroll.evaluate(element=>element.scrollLeft)).toBeGreaterThan(0);
    await scroll.evaluate(element=>{element.style.maxWidth='';});
    await choices.first().click(); await expect(choices.first()).toHaveAttribute('aria-pressed','true');
    await expect(page.getByTestId('preset-editor-nozzle-icon-filament_flow_ratio')).toBeVisible();
    await expect(page.getByTestId('preset-editor-nozzle-icon-filament_vendor')).toHaveCount(0);
    await page.getByTestId('preset-editor-page-tab-setting-overrides').click();
    await expect(page.getByTestId('preset-editor-nozzle-icon-filament_retraction_length')).toBeVisible();
    await page.getByTestId('preset-editor-dialog').screenshot({path:resolve(DESKTOP_ROOT,'../../.vitest/preset-editor-nozzle-icons.png'),animations:'disabled'});
    for(const [key,value] of [['filament_ironing_flow','15'],['filament_ironing_spacing','0.03'],['filament_ironing_inset','0.2'],['filament_ironing_speed','35']]) {
      const input=page.getByTestId(`preset-editor-input-${key}`),toggle=page.getByTestId(`preset-editor-override-${key}`);
      await expect(input).toBeDisabled(); const reference=await input.inputValue(); await expect(input).not.toHaveValue('');
      await toggle.click(); await expect(input).toBeEnabled(); await input.fill(value); await input.press('Enter');
      await expect(input).toBeEnabled(); await expect(input).toHaveValue(value);
      await expect(page.getByTestId('preset-editor-page-tab-setting-overrides')).toHaveAttribute('data-draft-override-highlight','true');
      await page.getByTestId(`preset-editor-reset-field-${key}`).click(); await expect(input).toBeDisabled(); await expect(input).toHaveValue(reference);
      await expect(page.getByTestId('preset-editor-page-tab-setting-overrides')).toHaveAttribute('data-draft-override-highlight','false');
    }
    await page.getByTestId('preset-editor-dialog').screenshot({path:resolve(DESKTOP_ROOT,'../../.vitest/filament-overrides-ironing.png')});
    await page.getByTestId('preset-editor-close').click();
  } finally { await app.close(); }
});

test('filament setting overrides edit retraction controls and preserve rejected input', async () => {
  const env = {...process.env,ORCA_E2E:'1'} as Record<string,string>; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({args:['.'],cwd:DESKTOP_ROOT,env});
  try {
    const page=await app.firstWindow(); await expect(page.getByTestId('slicer-status')).toHaveText('Ready',{timeout:60_000});
    await page.locator('#app-tab-prepare').click();
    if (REAL) await selectFilamentPreset(page, 'Generic PLA @System', 'Generic PLA');
    await page.getByTestId('filament-slot-1').click({button:'right'}); await page.getByTestId('filament-edit-1').click();
    await page.getByTestId('preset-editor-page-tab-setting-overrides').click();
    await page.getByTestId('preset-editor-dialog').screenshot({path:resolve(DESKTOP_ROOT,'../../.vitest/filament-overrides-retraction.png')});
    const input=(key:string)=>page.getByTestId(`preset-editor-input-${key}`);
    const toggle=(key:string)=>page.getByTestId(`preset-editor-override-${key}`);
    const length='filament_retraction_length',speed='filament_retraction_speed',before='filament_retract_before_wipe';
    await expect(input(length)).toBeDisabled(); await expect(input(length)).not.toHaveValue('');
    const reference=await input(length).inputValue();
    await toggle(length).click(); await input(length).fill('1.4'); await input(length).press('Enter'); await expect(input(length)).toBeEnabled();
    await expect(input(length)).toHaveValue('1.4'); await toggle(length).click(); await expect(input(length)).toHaveValue(reference);
    await toggle(length).click(); await expect(input(length)).toHaveValue(reference); await expect(input(length)).toBeEnabled();
    await toggle(speed).click(); await input(speed).fill('12'); await input(speed).press('Enter'); await expect(input(speed)).toBeEnabled();
    await input(length).fill('0'); await input(length).press('Enter'); await expect(input(speed)).toBeDisabled();
    await expect(page.getByTestId(`preset-editor-reset-field-${speed}`)).toBeEnabled();
    await page.getByTestId(`preset-editor-reset-field-${speed}`).click(); await expect(toggle(speed)).not.toBeChecked();
    await input(length).fill('1'); await input(length).press('Enter'); await expect(toggle(speed)).toBeEnabled();
    await toggle(before).click(); await expect(input(before)).toBeEnabled(); const valid=await input(before).inputValue();
    await input(before).fill('101'); await input(before).press('Enter'); await expect(input(before)).toHaveValue('101');
    await expect(page.getByTestId(`preset-editor-error-${before}`)).toBeVisible();
    await input(before).press('Escape'); await expect(input(before)).toHaveValue(valid);
    await expect(page.getByTestId(`preset-editor-error-${before}`)).toHaveCount(0);
    const wipeReference=await input('filament_wipe').isChecked();
    await toggle('filament_wipe').click(); await expect(toggle('filament_wipe')).toBeChecked();
    await expect(input('filament_wipe')).toBeChecked({checked:wipeReference});
    await toggle('filament_z_hop_types').click(); await expect(input('filament_z_hop_types')).toBeEnabled();
    await editClosedEnumField(page,'filament_z_hop_types');
    const after='filament_retract_after_wipe';
    await input(before).fill('50'); await input(before).press('Enter'); await expect(input(before)).toBeEnabled();
    await toggle(after).click(); await input(after).fill('40'); await input(after).press('Enter'); await expect(input(after)).toBeEnabled();
    await input(before).fill('80'); await input(before).press('Enter'); await expect(input(after)).toHaveValue('20');
    await page.getByTestId('preset-editor-close').click();
    await page.getByTestId('history-undo').click();
    const reopen=async()=>{
      await page.getByTestId('filament-slot-1').click({button:'right'}); await page.getByTestId('filament-edit-1').click();
      await page.getByTestId('preset-editor-page-tab-setting-overrides').click();
    };
    await reopen(); await expect(input(before)).toHaveValue('50'); await expect(input(after)).toHaveValue('40');
    await page.getByTestId('preset-editor-close').click(); await page.getByTestId('history-redo').click();
    await reopen(); await expect(input(before)).toHaveValue('80'); await expect(input(after)).toHaveValue('20');
    const variantChoices=page.getByTestId('preset-editor-variant').getByRole('button');
    await expect(variantChoices.first()).toHaveAttribute('data-dirty','true');
    const modifiedColour=await page.evaluate(()=>{
      const sample=document.createElement('span');sample.style.color='var(--color-config-override)';document.body.append(sample);
      const colour=getComputedStyle(sample).color;sample.remove();return colour;
    });
    await expect(variantChoices.first().locator('span')).toHaveCSS('color',modifiedColour);
    await variantChoices.nth(1).click();
    await expect(variantChoices.nth(1)).toHaveAttribute('data-dirty','false');
    await expect(variantChoices.first().locator('span')).toHaveCSS('color',modifiedColour);
    await expect(page.getByTestId('preset-editor-option-label-filament_retraction_length')).toHaveAttribute('data-draft-override-highlight','false');
    await expect(page.getByTestId('preset-editor-page-tab-setting-overrides')).toHaveAttribute('data-draft-override-highlight','true');
    await expect(page.getByTestId('preset-editor-reset-category-setting-overrides')).toBeDisabled();
    await page.getByTestId('preset-editor-close').click();
  } finally { await app.close(); }
});

test('real Filament variants and Project Print Hybrid choices edit independent native bindings',async()=>{
  const fixture=process.env.ORCA_E2E_EXTRUDER_PROJECT;
  test.skip(!REAL || !fixture,'Requires the native-exported indexed-editor Hybrid fixture');
  const env={...process.env,ORCA_E2E:'1',ORCA_E2E_MODEL:fixture!,ORCA_E2E_PRIME_TOWER_PROJECT:fixture!} as Record<string,string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app=await _electron.launch({args:['.'],cwd:DESKTOP_ROOT,env});
  try{
    const page=await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready',{timeout:60_000});
    await installSliceReceiptObserver(page,['getPrintConfigEditor','getScopedConfigEditor','mutateNativeScopedConfig']);
    await page.locator('#app-tab-prepare').click();
    await openProjectMenu(page,app);await waitForProjectLoad(page);
    await expect.poll(()=>page.evaluate(()=>(window as any).__orcaE2e.projectLoadEvidence())).toMatchObject({receipt:{sourceDisplayName:basename(fixture!),sourceByteLength:statSync(fixture!).size,nativeResult:{ok:true,mode:'project'}}});
    await page.waitForFunction(()=>Boolean((window as any).__orcaScopedConfigurationGate));
    expect(await page.evaluate(async()=>(await (window as any).__orcaScopedConfigurationGate.execution()).threaded)).toBe(false);
    const processProfile=page.getByTestId('config-process-profile');
    // The exported fixture intentionally contains Print edits on several indices.
    await expect(processProfile).toHaveAttribute('data-dirty','true');
    await page.getByTestId('config-reset-all').click();
    await expect(processProfile).toHaveAttribute('data-dirty','false');
    const {cleanProfileColour,dirtyColour}=await page.evaluate(()=>{
      const colour=(token:string)=>{
        const reference=document.createElement('span');reference.style.color=`var(${token})`;document.body.append(reference);
        const value=getComputedStyle(reference).color;reference.remove();return value;
      };
      return {cleanProfileColour:colour('--color-foreground'),dirtyColour:colour('--color-config-override')};
    });
    await expect(page.getByTestId('process-preset-select')).toHaveCSS('color',cleanProfileColour);
    // Shared Print controls keep whole-option ownership beside the mapped editor.
    await page.getByTestId('config-page-Other').click();
    const sequence=page.getByTestId('config-input-print_sequence');
    await expect(sequence).toBeEnabled();
    const sequenceBefore=await sequence.locator('[data-slot="select-value"]').textContent();
    await sequence.click();
    await expect(page.getByRole('option')).toHaveCount(2);
    const sequenceChoices=await page.getByRole('option').allTextContents();
    const sequenceAfter=sequenceChoices.find(label=>label.trim().toLowerCase()!==sequenceBefore?.trim().toLowerCase())!;
    await page.getByRole('option',{name:sequenceAfter,exact:true}).click();
    await expect(sequence).toContainText(sequenceAfter);await expect(sequence).toBeEnabled();
    await expect(processProfile).toHaveAttribute('data-dirty','true');
    await expect(page.locator('[data-testid="print-editor-selection"] [data-dirty="true"]')).toHaveCount(0);
    await page.getByTestId('config-reset-print_sequence').click();
    await expect(sequence).toContainText(sequenceBefore!);
    await expect(processProfile).toHaveAttribute('data-dirty','false');
    await expect(page.getByTestId('config-field-curr_bed_type')).toHaveCount(0);
    await page.getByTestId('config-page-Speed').click();
    const selection=page.getByTestId('print-editor-selection');await expect(selection).toBeVisible();
    const labels=await selection.getByRole('button').evaluateAll(buttons=>buttons.map(button=>button.getAttribute('aria-label')??''));
    expect(labels).toHaveLength(5);
    const sf=labels.find(label=>/3/.test(label)&&/Standard/.test(label))!;
    const hf=labels.find(label=>/3/.test(label)&&/High Flow/.test(label))!;
    expect(sf).toBeTruthy();expect(hf).toBeTruthy();
    const sfChoice=selection.getByRole('button',{name:sf,exact:true});
    const hfChoice=selection.getByRole('button',{name:hf,exact:true});
    await sfChoice.click();await sfChoice.press('ArrowRight');await expect(hfChoice).toBeFocused();await hfChoice.press('Space');
    await expect(hfChoice).toHaveAttribute('aria-pressed','true');
    await expect(hfChoice).toContainText('HF');await expect(hfChoice).toContainText('0.4');
    await expect(page.getByTestId('config-nozzle-icon-outer_wall_speed')).toBeVisible();
    const speed=page.getByTestId('config-input-outer_wall_speed');
    await expect(page.getByTestId('config-field-outer_wall_speed')).toHaveAttribute('data-native-index','5');
    await speed.focus();await speed.hover();
    const valueHelp=page.locator('[data-slot="tooltip-content"]').filter({hasText:'Source:'});
    await expect(valueHelp).toBeVisible();
    const sourceBefore=(await valueHelp.textContent())!.match(/Source: ([^\n]+)/)![1].trim();
    await expect(page.locator('[data-testid^="config-null-"]')).toHaveCount(0);
    await expect(page.getByText('Null',{exact:true})).toHaveCount(0);
    await expect(page.getByTestId('config-field-outer_wall_speed').getByRole('checkbox')).toHaveCount(0);
    const nativePrint=async()=>{
      const receipts=await readSliceReceipts(page) as {direction:string;op:string;result?:ConfigEditorSnapshot}[];
      const response=receipts.reverse().find(receipt=>receipt.direction==='response' && receipt.op==='getPrintConfigEditor');
      if(!response?.result)throw new Error('Missing native Print editor response');
      return response.result;
    };
    const nullable=await nativePrint();expect(nullable.editorVectors.outer_wall_speed.nullable).toBe(true);
    // Existing native nulls stay in configuration until an ordinary valid edit.
    await page.evaluate(async revision=>(window as any).__orcaScopedConfigurationGate.configure({version:1,operation:'set-element',targets:[{scope:'project'}],
      expectedRevision:revision,key:'outer_wall_speed',index:5,scalarType:'float',value:null}),nullable.revision);
    await expect(speed).toHaveValue('');await expect(speed).toBeEnabled();
    await expect.poll(async()=>(await nativePrint())?.editorVectors.outer_wall_speed.effectiveValues[5]).toBeNull();
    await expect(hfChoice).toHaveAttribute('data-dirty','true');
    await expect(sfChoice).toHaveAttribute('data-dirty','false');
    await expect(processProfile).toHaveAttribute('data-dirty','true');
    for(const line of await hfChoice.locator('span span').all())await expect(line).toHaveCSS('color',dirtyColour);
    const mutationCount=(await readSliceReceipts(page) as any[]).filter(receipt=>receipt.direction==='request' && receipt.op==='mutateNativeScopedConfig').length;
    await speed.press('Enter');
    expect((await readSliceReceipts(page) as any[]).filter(receipt=>receipt.direction==='request' && receipt.op==='mutateNativeScopedConfig')).toHaveLength(mutationCount);
    expect((await nativePrint()).editorVectors.outer_wall_speed.effectiveValues[5]).toBeNull();
    await speed.fill('187');await speed.press('Enter');await expect(speed).toBeEnabled();
    await expect(speed).toHaveValue('187');
    await expect(hfChoice).toBeEnabled();
    const beforeNavigation=await page.evaluate(()=>(window as any).__orcaScopedConfigurationGate.snapshot().status);
    const writesBeforeNavigation=(await readSliceReceipts(page) as {direction:string;op:string}[]).filter(receipt=>receipt.direction==='request' && receipt.op==='mutateNativeScopedConfig').length;
    await sfChoice.click();
    await expect(page.getByTestId('config-field-outer_wall_speed')).toHaveAttribute('data-native-index','4');
    await expect(speed).not.toHaveValue('187');
    expect(await page.evaluate(()=>(window as any).__orcaScopedConfigurationGate.snapshot().status)).toEqual(beforeNavigation);
    expect((await readSliceReceipts(page) as {direction:string;op:string}[]).filter(receipt=>receipt.direction==='request' && receipt.op==='mutateNativeScopedConfig')).toHaveLength(writesBeforeNavigation);
    await expect(hfChoice).toHaveAttribute('data-dirty','true');await expect(sfChoice).toHaveAttribute('data-dirty','false');
    await expect(processProfile).toHaveAttribute('data-dirty','true');await expect(page.getByTestId('config-reset-all')).toBeEnabled();
    await expect(page.getByTestId('process-preset-select')).toHaveCSS('color',dirtyColour);
    for(const line of await hfChoice.locator('span span').all())await expect(line).toHaveCSS('color',dirtyColour);
    await sfChoice.focus();await page.mouse.move(1000,700);
    await page.screenshot({path:resolve(DESKTOP_ROOT,'../../.vitest/print-dirty-inactive-hf.png')});
    await speed.fill('186');await speed.press('Enter');await expect(speed).toBeEnabled();
    await expect(sfChoice).toHaveAttribute('data-dirty','true');await expect(hfChoice).toHaveAttribute('data-dirty','true');
    await page.getByTestId('config-reset-outer_wall_speed').click();
    await expect(sfChoice).toHaveAttribute('data-dirty','false');await expect(hfChoice).toHaveAttribute('data-dirty','true');
    await expect(processProfile).toHaveAttribute('data-dirty','true');
    await hfChoice.click();
    await page.getByTestId('config-reset-outer_wall_speed').click();await expect(speed).toHaveValue(sourceBefore);
    await expect(hfChoice).toHaveAttribute('data-dirty','false');await expect(processProfile).toHaveAttribute('data-dirty','false');
    await expect(page.getByTestId('process-preset-select')).toHaveCSS('color',cleanProfileColour);
    await page.getByTestId('history-undo').click();await expect(speed).toHaveValue('187');await expect(hfChoice).toHaveAttribute('aria-pressed','true');
    await expect(hfChoice).toHaveAttribute('data-dirty','true');await expect(processProfile).toHaveAttribute('data-dirty','true');
    await page.getByTestId('history-redo').click();await expect(speed).toHaveValue(sourceBefore);
    await expect(hfChoice).toHaveAttribute('data-dirty','false');await expect(processProfile).toHaveAttribute('data-dirty','false');
    await expect(hfChoice).toBeEnabled();await hfChoice.focus();await page.mouse.move(1000,700);
    await expect(page.locator('[data-slot="tooltip-content"]').filter({hasText:'Redo'})).toHaveCount(0);
    await page.screenshot({path:resolve(DESKTOP_ROOT,'../../.vitest/print-extruder-strip-normal.png')});
    const resizer=page.getByTestId('sidebar-resizer');
    const originalWidth=Number(await resizer.getAttribute('aria-valuenow'));
    for(let step=0;step<Math.ceil((originalWidth-220)/16);step++)await resizer.press('ArrowLeft');
    await expect(resizer).toHaveAttribute('aria-valuenow','220');
    const scroll=page.getByTestId('print-editor-selection-scroll');
    await expect.poll(()=>scroll.evaluate(element=>element.scrollWidth>element.clientWidth)).toBe(true);
    const selectedVisible=()=>hfChoice.evaluate(element=>{
      const choice=element.getBoundingClientRect();const view=element.closest('[data-testid="print-editor-selection-scroll"]')!.getBoundingClientRect();
      return choice.left>=view.left-1 && choice.right<=view.right+1;
    });
    await expect.poll(selectedVisible).toBe(true);
    const beforeWheel=await page.evaluate(()=>(window as any).__orcaScopedConfigurationGate.snapshot().status);
    const requestsBeforeWheel=(await readSliceReceipts(page) as {direction:string;op:string}[]).filter(receipt=>receipt.direction==='request').length;
    const verticalPositions=()=>scroll.evaluate(element=>{
      const tops:number[]=[];for(let owner=element.parentElement;owner;owner=owner.parentElement)tops.push(owner.scrollTop);return tops;
    });
    const beforeVertical=await verticalPositions();
    await scroll.evaluate(element=>{element.scrollLeft=0;});await scroll.hover();
    await page.mouse.wheel(0,10000);
    await expect.poll(()=>scroll.evaluate(element=>element.scrollLeft)).toBeGreaterThan(0);
    await expect.poll(()=>scroll.evaluate(element=>Math.abs(element.scrollLeft-(element.scrollWidth-element.clientWidth)))).toBeLessThan(1);
    const wheelEnd=await scroll.evaluate(element=>element.scrollLeft);
    await page.mouse.wheel(0,-35);
    await expect.poll(()=>scroll.evaluate(element=>element.scrollLeft)).toBeLessThan(wheelEnd);
    expect(await verticalPositions()).toEqual(beforeVertical);
    await expect(hfChoice).toHaveAttribute('aria-pressed','true');
    expect(await page.evaluate(()=>(window as any).__orcaScopedConfigurationGate.snapshot().status)).toEqual(beforeWheel);
    expect((await readSliceReceipts(page) as {direction:string;op:string}[]).filter(receipt=>receipt.direction==='request')).toHaveLength(requestsBeforeWheel);
    await sfChoice.click();await hfChoice.click();await expect.poll(selectedVisible).toBe(true);
    await page.screenshot({path:resolve(DESKTOP_ROOT,'../../.vitest/print-extruder-strip-narrow.png')});
    for(let step=0;step<Math.ceil((originalWidth-220)/16);step++)await resizer.press('ArrowRight');
    // Printer's editing flow and Filament variants do not follow this Print view.
    await page.getByTestId('preset-edit-printer').click();await page.getByTestId('preset-editor-page-tab-extruder').click();
    await expect(page.locator('[data-testid^="preset-editor-null-"]')).toHaveCount(0);
    await expect(page.getByTestId('preset-editor-flow-3')).toContainText('SF');
    await page.getByTestId('preset-editor-flow-3').click();await page.getByRole('option',{name:'HF',exact:true}).click();
    await page.getByTestId('preset-editor-close').click();await expect(hfChoice).toHaveAttribute('aria-pressed','true');
    const rackSource=await page.getByTestId('filament-preset-1').getAttribute('title');
    await page.getByTestId('filament-slot-1').click({button:'right'});await page.getByTestId('filament-edit-1').click();
    await page.getByTestId('preset-editor-preset').click();
    await page.getByPlaceholder('Search presets to edit…').fill('Generic PLA');
    await page.getByRole('option').and(page.getByTitle('Generic PLA @System',{exact:true})).click();
    const variant=page.getByTestId('preset-editor-variant');
    await expect(variant.getByRole('button')).toHaveCount(6);
    await variant.getByRole('button',{name:'Bowden Extra High Flow',exact:true}).click();
    const ratio=page.getByTestId('preset-editor-input-filament_flow_ratio');
    const ratioBefore=await ratio.inputValue();const ratioAfter=String(Number(ratioBefore)===1.07?1.08:1.07);
    await expect(page.locator('[data-testid^="preset-editor-null-"]')).toHaveCount(0);
    const ratioSource=await page.getByTestId('preset-editor-source-filament_flow_ratio').textContent();
    await ratio.fill(ratioAfter);await ratio.press('Enter');await expect(ratio).toBeEnabled();await expect(ratio).toHaveValue(ratioAfter);
    await expect(page.getByTestId('preset-editor-field-filament_flow_ratio')).toHaveAttribute('title',/filament_flow_ratio\[5\]/);
    await variant.getByRole('button',{name:'Direct Drive Standard',exact:true}).click();await expect(ratio).not.toHaveValue(ratioAfter);
    await variant.getByRole('button',{name:'Bowden Extra High Flow',exact:true}).click();
    await expect(page.getByRole('option')).toHaveCount(0);
    await ratio.scrollIntoViewIfNeeded();
    await page.screenshot({path:resolve(DESKTOP_ROOT,'../../.vitest/extruder-step4-filament.png')});
    await page.getByTestId('preset-editor-reset-field-filament_flow_ratio').click();await expect(ratio).toHaveValue(ratioSource!);
    await page.getByTestId('preset-editor-page-tab-setting-overrides').click();
    await expect(page.getByTestId('preset-editor-readonly-filament_retraction_length')).toBeVisible();
    await expect(page.getByTestId('preset-editor-input-filament_retraction_length')).toHaveCount(0);
    await page.getByTestId('preset-editor-close').click();await expect(hfChoice).toHaveAttribute('aria-pressed','true');
    await expect(page.getByTestId('filament-preset-1')).toHaveAttribute('title',rackSource!);
    // The same native choices bind selected Object/Part owners independently.
    await page.getByTestId('config-mode-scoped').click();
    const structure=()=>page.evaluate(()=>(window as any).__orcaScopedConfigurationGate.snapshot().objects as {id:number;volumes:{id:number;type:string}[]}[]);
    const originalObject=(await structure())[0];
    const objectButton=(id:number)=>page.getByTestId(`object-${id}`).locator(':scope > div > button.object-list-row');
    await objectButton(originalObject.id).click({button:'right'});await page.getByTestId('objectlist-clone').click();
    await expect.poll(async()=>(await structure()).length).toBe(2);
    const scopedObjects=await structure();
    const modifierKey=process.platform==='darwin'?'Meta':'Control';
    const selectObjects=async(ids:number[])=>{
      for(const [index,id]of ids.entries())await objectButton(id).click({position:{x:50,y:10},modifiers:index?[modifierKey]:[]});
      await expect(page.getByTestId('scoped-target-label')).toHaveText(ids.length===1?/Object:/:`${ids.length} objects`);
    };
    const nativeScoped=async()=>{
      const receipts=await readSliceReceipts(page) as {direction:string;op:string;result?:ScopedConfigEditorSnapshot}[];
      const result=receipts.reverse().find(receipt=>receipt.direction==='response'&&receipt.op==='getScopedConfigEditor'&&receipt.result?.ok)?.result;
      if(!result)throw Error('Missing native Scoped editor response');return result;
    };
    const selectedOwners=async()=>{await expect(speed).toBeEnabled();return nativeScoped();};
    await selectObjects([scopedObjects[0].id]);await page.getByTestId('config-page-Speed').click();await hfChoice.click();await expect(speed).toBeEnabled();
    await expect(page.getByTestId('config-field-outer_wall_speed')).toHaveAttribute('data-native-index','5');
    await expect(page.getByTestId('scoped-target-label')).toHaveAttribute('data-dirty','false');
    await speed.fill('187');await speed.press('Enter');await expect(speed).toHaveValue('187');await expect(speed).toBeEnabled();
    await selectObjects([scopedObjects[1].id]);await expect(hfChoice).toHaveAttribute('aria-pressed','true');
    await expect(speed).toBeEnabled();await speed.fill('188');await speed.press('Enter');await expect(speed).toHaveValue('188');await expect(speed).toBeEnabled();
    await selectObjects(scopedObjects.map(object=>object.id));await expect(speed).toHaveAttribute('placeholder','Mixed');
    await expect(page.getByTestId('scoped-target-label')).toHaveAttribute('data-dirty','true');await expect(hfChoice).toHaveAttribute('data-dirty','true');
    const owned=await selectedOwners();expect(owned.targets).toHaveLength(2);
    expect(owned.targets.map(target=>target.editorVectors.outer_wall_speed.overrideValues[5])).toEqual([{value:187},{value:188}]);
    const beforeScopedView=await page.evaluate(()=>(window as any).__orcaScopedConfigurationGate.snapshot().status);
    const requestsBeforeScopedView=(await readSliceReceipts(page) as {direction:string;op:string}[]).filter(receipt=>receipt.direction==='request'&&['getScopedConfigEditor','mutateNativeScopedConfig'].includes(receipt.op)).length;
    await sfChoice.click();await expect(speed).not.toHaveAttribute('placeholder','Mixed');
    await expect(page.getByTestId('scoped-target-label')).toHaveAttribute('data-dirty','true');await expect(hfChoice).toHaveAttribute('data-dirty','true');
    for(const line of await hfChoice.locator('span span').all())await expect(line).toHaveCSS('color',dirtyColour);
    await expect(page.getByTestId('scoped-target-label')).toHaveCSS('color',dirtyColour);
    expect(await page.evaluate(()=>(window as any).__orcaScopedConfigurationGate.snapshot().status)).toEqual(beforeScopedView);
    expect((await readSliceReceipts(page) as {direction:string;op:string}[]).filter(receipt=>receipt.direction==='request'&&['getScopedConfigEditor','mutateNativeScopedConfig'].includes(receipt.op))).toHaveLength(requestsBeforeScopedView);
    await expect(page.getByTestId('config-nozzle-icon-outer_wall_speed')).toBeVisible();await sfChoice.focus();await page.mouse.move(1000,700);
    await page.screenshot({path:resolve(DESKTOP_ROOT,'../../.vitest/scoped-extruder-dirty-multiselect.png')});
    await hfChoice.click();await speed.fill('189');await speed.press('Enter');await expect(speed).toHaveValue('189');await expect(speed).toBeEnabled();
    const beforeReset=await page.evaluate(()=>(window as any).__orcaScopedConfigurationGate.snapshot().status.undoEntries.length);
    await page.getByTestId('config-category-toggle-Other layers speed').click({button:'right'});await page.getByTestId('config-reset-category-Speed').click();
    await expect(speed).toHaveValue(sourceBefore);await expect(speed).toBeEnabled();
    expect(await page.evaluate(()=>(window as any).__orcaScopedConfigurationGate.snapshot().status.undoEntries.length)).toBe(beforeReset+1);
    await expect(page.getByTestId('scoped-target-label')).toHaveAttribute('data-dirty','false');
    await page.getByTestId('history-undo').click();await expect(speed).toHaveValue('189');await expect(hfChoice).toHaveAttribute('aria-pressed','true');
    await page.getByTestId('history-redo').click();await expect(speed).toHaveValue(sourceBefore);await expect(speed).toBeEnabled();
    // A real sibling Part + modifier selection keeps inherited Object ownership
    // separate from the selected volumes' local ownership and Reset All.
    await selectObjects([originalObject.id]);await sfChoice.click();await speed.fill('186');await speed.press('Enter');await expect(speed).toHaveValue('186');await expect(speed).toBeEnabled();
    await objectButton(originalObject.id).click({button:'right'});await page.getByTestId('objectlist-add-parameter_modifier').click();
    await page.getByTestId('objectlist-add-parameter_modifier-Cube').click();
    await expect.poll(async()=>(await structure())[0].volumes.length).toBe(2);
    await objectButton(originalObject.id).click({button:'right'});await page.getByTestId('objectlist-add-parameter_modifier').click();
    await page.getByTestId('objectlist-add-parameter_modifier-Cube').click();
    await expect.poll(async()=>(await structure())[0].volumes.length).toBe(3);
    // A proper subset remains a Part selection; all volumes intentionally classify as Object.
    const volumes=(await structure())[0].volumes.slice(0,2);
    expect(volumes.some(volume=>volume.type==='parameter_modifier')).toBe(true);
    const partButton=(id:number)=>page.getByTestId(`part-${id}`).locator(':scope > button.object-list-row');
    if(!await partButton(volumes[0].id).isVisible())await page.getByTestId(`object-expand-${originalObject.id}`).click();
    await partButton(volumes[0].id).click({position:{x:50,y:10}});await partButton(volumes[1].id).click({position:{x:50,y:10},modifiers:[modifierKey]});
    await expect(page.getByTestId('scoped-target-label')).toHaveText('2 volumes');await expect(speed).toHaveValue('186');await expect(speed).toBeEnabled();
    await expect(page.getByTestId('scoped-target-label')).toHaveAttribute('data-dirty','false');await expect(sfChoice).toHaveAttribute('data-dirty','false');
    expect((await selectedOwners()).targets.map(target=>target.sourceScopes.indexed.outer_wall_speed[4])).toEqual(['object','object']);
    await hfChoice.click();await speed.fill('177');await speed.press('Enter');await expect(speed).toHaveValue('177');await expect(speed).toBeEnabled();
    const volumeOwned=await selectedOwners();expect(volumeOwned.targets.map(target=>target.target)).toEqual(volumes.map(volume=>({scope:'part',id:String(volume.id)})));
    expect(volumeOwned.targets.map(target=>target.editorVectors.outer_wall_speed.overrideValues[5])).toEqual([{value:177},{value:177}]);
    await hfChoice.focus();await page.mouse.move(1000,700);await page.screenshot({path:resolve(DESKTOP_ROOT,'../../.vitest/scoped-extruder-part-modifier.png')});
    await page.getByTestId('config-reset-all').click();await expect(speed).toHaveValue(sourceBefore);await expect(speed).toBeEnabled();
    await expect(page.getByTestId('scoped-target-label')).toHaveAttribute('data-dirty','false');
    await selectObjects([originalObject.id]);await sfChoice.click();await expect(speed).toHaveValue('186');await expect(sfChoice).toHaveAttribute('data-dirty','true');
    await page.getByTestId('config-reset-all').click();await expect(page.getByTestId('scoped-target-label')).toHaveAttribute('data-dirty','false');
    await page.getByTestId('config-mode-project').click();await expect(hfChoice).toHaveAttribute('aria-pressed','true');await expect(processProfile).toHaveAttribute('data-dirty','false');
    await page.getByTestId('config-mode-plates').click();await expect(selection).toHaveCount(0);
    await expect(page.getByTestId('config-nozzle-icon-spiral_mode')).toHaveCount(0);
    await page.getByTestId('config-input-spiral_mode').click();await expect(page.getByTestId('config-reset-spiral_mode')).toBeVisible();
    await page.getByTestId('config-reset-spiral_mode').click();await expect(page.getByTestId('config-reset-spiral_mode')).toHaveCount(0);
  }finally{await app.close();}
});

test('independent preset browsing preserves project choices and both Filament drafts', async () => {
  const env = { ...process.env, ORCA_E2E: '1' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 60_000 });
    await page.locator('#app-tab-prepare').click();
    // Force overflow even with the small mock catalogue, so reopening must reveal selection.
    await page.addStyleTag({ content: `
      [data-slot="select-content"][aria-label="Preset to edit"] { max-height: 100px !important; }
    ` });
    const printerBefore = await page.getByTestId('preset-select').getAttribute('title');
    await page.getByTestId('preset-edit-printer').click();
    await page.getByTestId('preset-editor-page-tab-multimaterial').click();
    await expect(page.getByTestId('preset-editor-option-label-extruders_count')).toHaveText('Extruders');
    await expect(page.getByTestId('preset-editor-source-extruders_count')).toHaveText(/^[1-9]\d*$/);
    await expect(page.getByTestId('preset-editor-effective-extruders_count')).toHaveText(/^[1-9]\d*$/);
    const printerPickerWidth = (await page.getByTestId('preset-editor-preset').boundingBox())!.width;
    await page.getByTestId('preset-editor-preset').click();
    // Opening the popup mounts its options asynchronously; evaluateAll does not wait.
    await expect(page.getByRole('option').nth(1)).toBeAttached();
    const printerTargets = await page.getByRole('option').evaluateAll(options => options.map(option => option.getAttribute('title')));
    const otherPrinter = [...printerTargets].reverse().find(name => name && name !== printerBefore);
    if (!otherPrinter) throw new Error('expected another installed Printer');
    await page.getByRole('option').and(page.getByTitle(otherPrinter, { exact: true })).click();
    await expect(page.getByTestId('preset-editor-title')).toHaveText(otherPrinter);
    expect((await page.getByTestId('preset-editor-preset').boundingBox())!.width).toBeCloseTo(printerPickerWidth, 1);
    await expect(page.getByTestId('preset-select')).toHaveAttribute('title', printerBefore!);
    await page.getByTestId('preset-editor-preset').click();
    // Allow subpixel clipping at the popup border while still requiring the
    // selected row to be revealed and focused after reopening.
    await expect(page.getByRole('option').and(page.getByTitle(otherPrinter, { exact: true })))
      .toBeInViewport({ ratio: 0.99 });
    await expect(page.getByRole('option').and(page.getByTitle(otherPrinter, { exact: true }))).toBeFocused();
    await page.keyboard.press('Escape');
    await page.getByTestId('preset-editor-close').click();
    const slot = page.getByTestId('filament-preset-1');
    const source = await slot.getAttribute('title');
    if (!source) throw new Error('expected selected Filament source');
    await page.getByTestId('filament-slot-1').click({ button: 'right' });
    await page.getByTestId('filament-edit-1').click();
    const picker = page.getByTestId('preset-editor-preset');
    const sourceLabel = await page.getByTestId('preset-editor-title').textContent();
    const filamentPickerWidth = (await picker.boundingBox())!.width;
    const settingsSearch = page.getByTestId('preset-editor-search');
    await settingsSearch.fill('filament_diameter');
    const diameter = page.getByTestId('preset-editor-input-filament_diameter');
    await diameter.fill('1.76'); await diameter.press('Enter');
    await expect(picker).toBeEnabled();
    expect((await picker.boundingBox())!.width).toBeCloseTo(filamentPickerWidth, 1);
    await picker.click();
    const editorPopup = page.locator('[data-slot="select-content"][aria-label="Preset to edit"]');
    const groups = page.locator('[data-slot="select-group"]');
    const incompatible = groups.filter({ has: page.locator(':scope > [data-slot="select-label"]', {
      hasText: 'Not compatible with project printer',
    }) });
    const targetOption = incompatible.getByRole('option').first();
    const target = await targetOption.getAttribute('title');
    const targetLabel = (await targetOption.textContent())!.trim();
    if (!target) throw new Error('expected an incompatible editor candidate');
    await targetOption.click();
    await expect(page.getByTestId('preset-editor-title')).toHaveText(targetLabel);
    await expect(picker).toHaveAttribute('title', target);
    expect((await picker.boundingBox())!.width).toBeCloseTo(filamentPickerWidth, 1);
    await expect(slot).toHaveAttribute('title', source);
    await diameter.fill('1.77'); await diameter.press('Enter');
    await expect(picker).toBeEnabled();
    await picker.click();
    await expect(page.getByRole('option').and(page.getByTitle(target, { exact: true })))
      .toBeInViewport({ ratio: 0.99 });
    await expect(page.getByRole('option').and(page.getByTitle(target, { exact: true }))).toBeFocused();
    const presetSearch = editorPopup.getByPlaceholder('Search presets to edit…');
    await expect(presetSearch).toBeInViewport({ ratio: 1 });
    const searchTop = (await presetSearch.boundingBox())!.y;
    const optionsList = editorPopup.getByRole('listbox');
    expect(await optionsList.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await optionsList.evaluate(element => { element.scrollTop = 0; });
    expect((await presetSearch.boundingBox())!.y).toBeCloseTo(searchTop, 1);
    await presetSearch.fill(targetLabel);
    // Display aliases can match multiple distinct canonical presets.
    await expect(editorPopup.getByRole('option').and(page.getByTitle(target, { exact: true }))).toBeVisible();
    expect(await editorPopup.getByRole('option').evaluateAll((options, query) =>
      options.every(option => option.textContent?.toLocaleLowerCase().includes(query)), targetLabel.toLocaleLowerCase())).toBe(true);
    await presetSearch.press('ArrowDown');
    await expect(editorPopup.getByRole('option').first()).toBeFocused();
    await presetSearch.fill('');
    if (!REAL) {
      // The popup accommodates names and is at least as wide as the fixed trigger.
      await expect.poll(async () => (await editorPopup.boundingBox())!.width)
        .toBeGreaterThanOrEqual((await picker.boundingBox())!.width - 1);
      expect(await editorPopup.locator('.truncate').evaluateAll(elements =>
        elements.every(element => element.scrollWidth <= element.clientWidth))).toBe(true);
    }
    await expect(incompatible.getByRole('option').first()).toHaveAttribute('title', target);
    await expect(incompatible.getByRole('option').first().locator('.config-override-label')).toBeVisible();
    await page.getByRole('option').and(page.getByTitle(source, { exact: true })).click();
    await expect(page.getByTestId('preset-editor-title')).toHaveText(sourceLabel!);
    await expect(picker).toHaveAttribute('title', source);
    await expect(diameter).toHaveValue('1.76');
    await picker.click();
    await page.getByRole('option').and(page.getByTitle(target, { exact: true })).click();
    await expect(diameter).toHaveValue('1.77');
    await page.setViewportSize({ width: 800, height: 720 });
    const narrowPickerWidth = (await picker.boundingBox())!.width;
    const titleBounds = (await page.getByTestId('preset-editor-title').boundingBox())!;
    const resetBounds = (await page.getByTestId('preset-editor-reset-preset').boundingBox())!;
    const closeBounds = (await page.getByTestId('preset-editor-close').boundingBox())!;
    expect(closeBounds.y).toBeCloseTo(titleBounds.y, 1);
    expect(resetBounds.y).toBeLessThan(titleBounds.y + titleBounds.height);
    expect(closeBounds.y + closeBounds.height).toBeLessThanOrEqual((await picker.boundingBox())!.y);
    await picker.click();
    await page.getByRole('option').and(page.getByTitle(source, { exact: true })).click();
    await expect(page.getByTestId('preset-editor-title')).toHaveText(sourceLabel!);
    await expect(picker).toHaveAttribute('title', source);
    expect((await picker.boundingBox())!.width).toBeCloseTo(narrowPickerWidth, 1);
    await page.getByTestId('preset-editor-close').click();
    await expect(slot).toHaveAttribute('title', source);
    await expect(page.getByTestId('preset-select')).toHaveAttribute('title', printerBefore!);
  } finally { await app.close(); }
});

async function selectFilamentPreset(page: Page, name: string, label: string): Promise<void> {
  const preset = page.getByTestId('filament-preset-1');
  await preset.click();
  await page.getByPlaceholder('Search compatible presets…').fill(label);
  await page.getByRole('menuitem', { name: 'Generic', exact: true }).hover();
  await page.getByRole('menuitemradio').and(page.getByTitle(name, { exact: true })).click();
  await expect(preset).toHaveAttribute('title', name);
}

async function editNumericField(
  page: Page,
  key: string,
  nativeType: 'float' | 'int' | 'percent',
  step: number,
): Promise<{ before: string; after: string }> {
  const field = page.getByTestId(`preset-editor-field-${key}`);
  await expect(field).toHaveAttribute('data-native-scalar-type', nativeType);
  const input = page.getByTestId(`preset-editor-input-${key}`);
  const before = await input.inputValue();
  const current = Number(before);
  if (!Number.isFinite(current)) throw new Error(`expected a native numeric value for ${key}`);
  const minimumText = await field.getAttribute('data-native-min');
  const maximumText = await field.getAttribute('data-native-max');
  const minimum = minimumText === null ? Number.NEGATIVE_INFINITY : Number(minimumText);
  const maximum = maximumText === null ? Number.POSITIVE_INFINITY : Number(maximumText);
  const next = [current + step, current - step]
    .find((candidate) => candidate !== current && candidate >= minimum && candidate <= maximum);
  if (next === undefined) throw new Error(`expected a distinct ${key} value within [${minimum}, ${maximum}]`);
  const after = String(next);
  await input.fill(after);
  await input.press('Enter');
  await expect(input).toHaveValue(after);
  return { before, after };
}

async function editClosedEnumField(page: Page, key: string): Promise<{ before: string; after: string }> {
  const field = page.getByTestId(`preset-editor-field-${key}`);
  await expect(field).toHaveAttribute('data-native-scalar-type', 'enum');
  const input = page.getByTestId(`preset-editor-input-${key}`);
  const before = (await input.textContent())?.trim() ?? '';
  await input.click();
  const options = page.getByRole('option');
  // Select mounts its portal asynchronously; allTextContents does not wait.
  await expect(options.nth(1)).toBeVisible();
  const labels = (await options.allTextContents()).map((label) => label.trim());
  const after = labels.find((label) => label.length > 0 && label !== before);
  if (!after) throw new Error(`expected a distinct native enum option for ${key}`);
  await page.getByRole('option', { name: after, exact: true }).click();
  await expect(input).toContainText(after);
  return { before, after };
}

test('U1 single Extruder page maps per-nozzle flows and keeps direct diameter edits in their source', async () => {
  test.skip(!REAL, 'Requires the real U1 physical, variant and motion vectors');
  const env = { ...process.env, ORCA_E2E: '1' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 60_000 });
    if (process.env.VITE_SCOPED_CONFIGURATION_GATE === '1') {
      await page.waitForFunction(() => Boolean((window as any).__orcaScopedConfigurationGate));
      const execution = await page.evaluate(() => (window as any).__orcaScopedConfigurationGate.execution());
      expect(execution.threaded).toBe(process.env.VITE_SCOPED_CONFIGURATION_GATE_VARIANT === 'threaded');
    }
    await page.locator('#app-tab-prepare').click();
    await page.getByTestId('preset-select').click();
    const popup = page.locator('[data-slot="combobox-content"]');
    await popup.getByPlaceholder('Search presets…').fill('Snapmaker U1');
    await popup.getByRole('option', { name: 'Snapmaker U1', exact: true }).click();
    await expect(page.getByTestId('preset-transition-region')).toHaveAttribute('aria-busy', 'false');
    await page.getByTestId('nozzle-variant-select').click();
    await page.getByRole('option', { name: '0.4+0.6', exact: true }).click();
    await expect(page.getByTestId('nozzle-variant-select')).toContainText('0.4+0.6');
    await page.getByTestId('preset-edit-printer').click();
    await expect(page.getByTestId('preset-editor-title')).toHaveText('Snapmaker U1 (0.4+0.6 nozzle)');
    await page.getByTestId('preset-editor-page-tab-extruder').click();
    await expect(page.getByRole('tab', { name: 'Extruders', exact: true })).toHaveCount(1);
    await expect(page.getByRole('tab', { name: /^Extruder \d/ })).toHaveCount(0);
    const cardTops = await page.getByTestId('preset-editor-extruder-switch').locator('.preset-editor-toolhead')
      .evaluateAll(cards => cards.map(card => card.getBoundingClientRect().top));
    expect(cardTops).toHaveLength(4);
    expect(new Set(cardTops).size).toBe(1);
    for (const index of [1,2,3,4]) {
      const button = await page.getByTestId(`preset-editor-extruder-${index}`).boundingBox();
      const flow = await page.getByTestId(`preset-editor-flow-${index}`).boundingBox();
      expect(button && flow && button.y + button.height <= flow.y + 1).toBe(true);
    }
    for (const [index, diameter, minimum, maximum] of [
      [1, '0.4', '0.08', '0.32'], [2, '0.4', '0.08', '0.32'],
      [3, '0.6', '0.12', '0.48'], [4, '0.6', '0.12', '0.48'],
    ] as const) {
      await page.getByTestId(`preset-editor-extruder-${index}`).click();
      await expect(page.getByTestId('preset-editor-input-nozzle_diameter')).toHaveValue(diameter);
      await expect(page.getByTestId('preset-editor-input-min_layer_height')).toHaveValue(minimum);
      await expect(page.getByTestId('preset-editor-input-max_layer_height')).toHaveValue(maximum);
    }
    await page.getByTestId('preset-editor-extruder-3').click();
    // A popup alone preserves the selected nozzle; selecting a flow chooses it.
    await page.getByTestId('preset-editor-flow-2').click();
    await expect(page.getByTestId('preset-editor-extruder-3')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await page.getByTestId('preset-editor-flow-2').click();
    await page.getByRole('option', { name: 'HF', exact: true }).click();
    await expect(page.getByTestId('preset-editor-extruder-2')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('preset-editor-extruder-3').click();
    const retraction = page.getByTestId('preset-editor-input-retraction_length');
    const sfRetraction = await retraction.inputValue();
    await retraction.fill('invalid'); await retraction.press('Enter');
    await expect(page.getByTestId('preset-editor-error-retraction_length')).toBeVisible();
    await page.getByTestId('preset-editor-extruder-1').click();
    await expect(page.getByTestId('preset-editor-extruder-1')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('preset-editor-error-retraction_length')).toHaveCount(0);
    await page.getByTestId('preset-editor-extruder-3').click();
    // Blur submits the original SF field while the same click selects T1.
    await retraction.fill('1.24');
    await page.getByTestId('preset-editor-extruder-1').click();
    await expect(page.getByTestId('preset-editor-extruder-1')).toHaveAttribute('aria-pressed', 'true');
    await expect(retraction).toBeEnabled();
    await page.getByTestId('preset-editor-extruder-3').click();
    await expect(retraction).toHaveValue('1.24');
    await expect(page.getByTestId('preset-editor-field-retraction_length')).toHaveAttribute('title', /retraction_length\[4\]/);
    await page.getByTestId('preset-editor-flow-3').click();
    await page.getByRole('option', { name: 'HF', exact: true }).click();
    await expect(page.getByTestId('preset-editor-field-retraction_length')).toHaveAttribute('title', /retraction_length\[5\]/);
    await expect(retraction).not.toHaveValue('1.24');
    await page.getByTestId('preset-editor-page-tab-motion-ability').click();
    await expect(page.getByTestId('preset-editor-field-machine_max_speed_e')).toHaveAttribute('title', /machine_max_speed_e\[10\]/);
    await expect(page.getByTestId('preset-editor-dialog')).not.toContainText('Silent');
    await page.getByTestId('preset-editor-page-tab-notes').click();
    await expect(page.getByTestId('preset-editor-extruder-switch')).toHaveCount(0);
    await page.getByTestId('preset-editor-page-tab-extruder').click();
    await expect(page.getByTestId('preset-editor-flow-3')).toContainText('HF');
    await page.getByTestId('preset-editor-flow-3').click();
    await page.getByRole('option', { name: 'SF', exact: true }).click();
    await expect(retraction).toHaveValue('1.24');
    await page.getByTestId('preset-editor-reset-field-retraction_length').click();
    await expect(retraction).toHaveValue(sfRetraction);
    await page.screenshot({ path: resolve(DESKTOP_ROOT, '../../.vitest/extruder-step3-printer.png') });
    const minimum = page.getByTestId('preset-editor-input-min_layer_height');
    await minimum.fill('0.15'); await minimum.press('Enter');
    await expect(minimum).toHaveValue('0.15');
    await expect(page.getByTestId('preset-editor-page-tab-extruder')).toHaveAttribute('data-draft-override-highlight', 'true');
    await page.getByTestId('preset-editor-extruder-1').click();
    await expect(page.getByTestId('preset-editor-page-tab-extruder')).toHaveAttribute('data-draft-override-highlight', 'true');
    await minimum.fill('0.1'); await minimum.press('Enter');
    await expect(minimum).toHaveValue('0.1');
    await page.getByTestId('preset-editor-extruder-3').click();
    await page.getByTestId('preset-editor-reset-category-extruder').click();
    await expect(minimum).toHaveValue('0.12');
    await expect(page.getByTestId('preset-editor-reset-category-extruder')).toBeDisabled();
    await expect(page.getByTestId('preset-editor-reset-field-min_layer_height')).toHaveCount(0);
    await expect(page.getByTestId('preset-editor-page-tab-extruder')).toHaveAttribute('data-draft-override-highlight', 'true');
    await page.getByTestId('preset-editor-extruder-1').click();
    await expect(page.getByTestId('preset-editor-page-tab-extruder')).toHaveAttribute('data-draft-override-highlight', 'true');
    await expect(minimum).toHaveValue('0.1');
    await page.getByTestId('preset-editor-reset-category-extruder').click();
    await expect(minimum).toHaveValue('0.08');
    await expect(page.getByTestId('preset-editor-page-tab-extruder')).toHaveAttribute('data-draft-override-highlight','false');
    for (const index of [3, 4]) {
      await page.getByTestId(`preset-editor-extruder-${index}`).click();
      const diameter = page.getByTestId('preset-editor-input-nozzle_diameter');
      await expect(diameter).toHaveValue('0.6');
      await diameter.fill('0.4'); await diameter.press('Enter');
      await expect.poll(async () => ({
        effective: await page.getByTestId('preset-editor-effective-nozzle_diameter').textContent(),
        errors: await page.getByTestId('preset-editor-error-nozzle_diameter').allTextContents(),
        pending: await diameter.isDisabled(),
      }), { timeout: 15_000 }).toEqual({ effective: '0.4', errors: [], pending: false });
    }
    await expect(page.getByTestId('preset-editor-title')).toHaveText('Snapmaker U1 (0.4+0.6 nozzle)');
    await minimum.fill('0.1'); await minimum.press('Enter');
    await expect(minimum).toHaveValue('0.1');
    await page.getByTestId('preset-editor-close').click();
    await expect(page.getByTestId('nozzle-variant-select')).toContainText('0.4+0.6');
    await page.getByTestId('preset-edit-printer').click();
    await page.getByTestId('preset-editor-page-tab-multimaterial').click();
    const count=page.getByTestId('preset-editor-input-extruders_count');
    await count.fill('1'); await count.press('Enter'); await expect(count).toBeEnabled(); await expect(count).toHaveValue('1');
    await page.getByTestId('preset-editor-page-tab-extruder').click();
    const flows=page.getByTestId('preset-editor-flow-1');
    await expect(flows.getByRole('combobox')).toHaveCount(0); await expect(flows.getByRole('button')).toHaveCount(2);
    await flows.getByRole('button',{name:'High Flow',exact:true}).click();
    await expect(flows.getByRole('button',{name:'High Flow',exact:true})).toHaveAttribute('aria-pressed','true');
    await page.getByTestId('preset-editor-dialog').screenshot({path:resolve(DESKTOP_ROOT,'../../.vitest/printer-variant-strip.png'),animations:'disabled'});
    await page.getByTestId('preset-editor-close').click();
  } finally { await app.close(); }
});

test('Multi diameter writes matching Source stay highlighted and resettable in the Printer editor', async () => {
  test.skip(!REAL, 'Requires real U1 toolheads and native override ownership');
  const env = { ...process.env, ORCA_E2E: '1' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 60_000 });
    await page.locator('#app-tab-prepare').click();
    await page.getByTestId('preset-select').click();
    const popup = page.locator('[data-slot="combobox-content"]');
    await popup.getByPlaceholder('Search presets…').fill('Snapmaker U1');
    await popup.getByRole('option', { name: 'Snapmaker U1', exact: true }).click();
    await expect(page.getByTestId('preset-transition-region')).toHaveAttribute('aria-busy', 'false');
    await page.getByTestId('nozzle-variant-select').click();
    await page.getByRole('option', { name: '0.4+0.6', exact: true }).click();
    await expect(page.getByTestId('nozzle-variant-select')).toContainText('0.4+0.6');
    const marker = page.getByTestId('preset-select').locator('.config-override-label');
    for (const action of ['field', 'category']) {
      await page.getByTestId('printer-tab-multi').click();
      await page.getByTestId('toolhead-3').click();
      for (const value of ['0.4', '0.6']) {
        const diameter = page.getByTestId('toolhead-diameter-select');
        await diameter.click();
        await page.getByRole('option', { name: value, exact: true }).click();
        await expect(diameter).toContainText(value);
        await expect(diameter).toBeEnabled();
      }
      await page.getByTestId('printer-tab-device').click();
      await expect(marker).toHaveCount(1);
      await page.getByTestId('preset-edit-printer').click();
      await page.getByTestId('preset-editor-page-tab-extruder').click();
      await page.getByTestId('preset-editor-extruder-3').click();
      await expect(page.getByTestId('preset-editor-project-draft')).toHaveText('Project draft');
      await expect(page.getByTestId('preset-editor-input-nozzle_diameter')).toHaveValue('0.6');
      await expect(page.getByTestId('preset-editor-option-label-nozzle_diameter')).toHaveAttribute('data-draft-override-highlight', 'true');
      await page.getByTestId(action === 'field' ? 'preset-editor-reset-field-nozzle_diameter' : 'preset-editor-reset-category-extruder').click();
      await expect(page.getByTestId('preset-editor-project-draft')).toHaveCount(0);
      await expect(page.getByTestId('preset-editor-option-label-nozzle_diameter')).toHaveAttribute('data-draft-override-highlight', 'false');
      await expect(page.getByTestId('preset-editor-reset-category-extruder')).toBeDisabled();
      await page.getByTestId('preset-editor-close').click();
      await expect(marker).toHaveCount(0);
      await page.getByTestId('history-undo').click();
      await expect(marker).toHaveCount(1);
      await page.getByTestId('preset-edit-printer').click();
      await page.getByTestId('preset-editor-page-tab-extruder').click();
      await page.getByTestId('preset-editor-extruder-3').click();
      await expect(page.getByTestId('preset-editor-input-nozzle_diameter')).toHaveValue('0.6');
      await expect(page.getByTestId('preset-editor-reset-field-nozzle_diameter')).toBeEnabled();
      await page.getByTestId('preset-editor-close').click();
      await page.getByTestId('history-redo').click();
      await expect(marker).toHaveCount(0);
    }
  } finally { await app.close(); }
});

test('preset editor modal edits Printer and shared Filament drafts without changing slot colors', async () => {
  const env = { ...process.env, ORCA_E2E: '1' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await page.locator('#app-tab-prepare').click();
    if (REAL) await selectFilamentPreset(page, 'Generic PLA @System', 'Generic PLA');
    await page.addStyleTag({ content: `
      [data-slot="dropdown-menu-content"][aria-label="Filament preset for slot 1"] { max-height: 70px !important; }
    ` });
    for (const [id, placeholder] of [
      ['preset-select', 'Search presets…'],
      ['process-preset-select', 'Search presets…'],
      ['filament-preset-1', 'Search compatible presets…'],
    ]) {
      const picker = page.getByTestId(id);
      const selected = await picker.textContent();
      await picker.click();
      const search = id === 'filament-preset-1'
        ? page.getByRole('menu', { name: 'Filament preset for slot 1', exact: true }).getByPlaceholder(placeholder)
        : page.getByPlaceholder(placeholder).and(page.locator('input[aria-expanded="true"]'));
      await search.fill('no-such-preset');
      await page.getByRole('button', { name: 'Clear search', exact: true }).click();
      await expect(search).toHaveValue('');
      await expect(search).toBeFocused();
      await expect(picker).toHaveText(selected!);
      await expect(page.getByRole(id === 'filament-preset-1' ? 'menuitem' : 'option').first()).toBeVisible();
      if (id === 'filament-preset-1') {
        const list = page.getByRole('menu', { name: 'Filament preset for slot 1', exact: true })
          .locator('[data-slot="preset-menu-list"]');
        const searchTop = (await search.boundingBox())!.y;
        expect(await list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
        await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
        await expect(search).toBeInViewport({ ratio: 1 });
        expect((await search.boundingBox())!.y).toBeCloseTo(searchTop, 1);
      }
      await page.keyboard.press('Escape');
    }

    await page.getByTestId('preset-edit-printer').click();
    const dialog = page.getByTestId('preset-editor-dialog');
    await expect(dialog).toBeVisible();
    const sceneStats = page.getByTestId('viewport').locator('.scene-stats');
    await expect(sceneStats).toHaveCSS('position', 'absolute');
    await expect(sceneStats).toHaveCSS('z-index', '0');
    expect(await sceneStats.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
        ?.closest('[data-slot="dialog-content"], [data-slot="dialog-overlay"]')
        ?.getAttribute('data-slot');
    })).toMatch(/^dialog-(content|overlay)$/);
    await expect(page.getByTestId('preset-editor-title')).not.toBeEmpty();
    const printerSourceHeight = await page.getByTestId('preset-editor-source-printable_height').textContent();
    const initialPrinterHeight = await page.getByTestId('preset-editor-effective-printable_height').textContent();
    if (printerSourceHeight === null || initialPrinterHeight === null) throw new Error('expected Printer source/effective height');
    const printableHeight = page.getByTestId('preset-editor-input-printable_height');
    const printableHeightLabel = page.getByTestId('preset-editor-option-label-printable_height');
    const printerTab = page.getByTestId('preset-editor-page-tab-basic-information');
    const printableSpaceGroup = page.getByTestId('preset-editor-group-title-basic-information-printable-space');
    await expect(printableHeightLabel).toHaveAttribute('data-draft-override-highlight', 'false');
    await expect(printerTab).toHaveAttribute('data-draft-override-highlight', 'false');
    await expect(printableSpaceGroup).toHaveAttribute('data-draft-override-highlight', 'false');
    const printerHeightField = page.getByTestId('preset-editor-field-printable_height');
    const minimumText = await printerHeightField.getAttribute('data-native-min');
    const maximumText = await printerHeightField.getAttribute('data-native-max');
    const minimum = minimumText === null ? Number.NEGATIVE_INFINITY : Number(minimumText);
    const maximum = maximumText === null ? Number.POSITIVE_INFINITY : Number(maximumText);
    const initialPrinterHeightNumber = Number(initialPrinterHeight);
    const editedPrinterHeightNumber = initialPrinterHeightNumber + 1 <= maximum
      ? initialPrinterHeightNumber + 1
      : initialPrinterHeightNumber - 1;
    if (!Number.isFinite(initialPrinterHeightNumber)
      || editedPrinterHeightNumber < minimum
      || editedPrinterHeightNumber > maximum
      || editedPrinterHeightNumber === initialPrinterHeightNumber) {
      throw new Error(`expected a distinct printable_height within [${minimum}, ${maximum}]`);
    }
    const editedPrinterHeight = String(editedPrinterHeightNumber);
    await printableHeight.fill(editedPrinterHeight);
    await printableHeight.press('Enter');
    await expect(printableHeight).toHaveValue(editedPrinterHeight);
    await expect(page.getByTestId('preset-editor-project-draft')).toHaveText('Project draft');
    await expect(printableHeightLabel).toHaveAttribute('data-draft-override-highlight', 'true');
    await expect(printerTab).toHaveAttribute('data-draft-override-highlight', 'true');
    await expect(printerTab).toHaveCSS('color', 'rgb(247, 148, 29)');
    await expect(printableSpaceGroup).toHaveAttribute('data-draft-override-highlight', 'true');
    await expect(printableSpaceGroup).toHaveCSS('color', 'rgb(247, 148, 29)');
    await page.getByTestId('preset-editor-reset-preset').click();
    await expect(page.getByTestId('preset-editor-project-draft')).toHaveCount(0);
    await expect(printableHeight).toHaveValue(printerSourceHeight);
    await expect(printableHeightLabel).toHaveAttribute('data-draft-override-highlight', 'false');
    await expect(printerTab).toHaveAttribute('data-draft-override-highlight', 'false');
    await expect(printableSpaceGroup).toHaveAttribute('data-draft-override-highlight', 'false');
    await page.getByTestId('preset-editor-close').click();

    const initialActualColour = page.getByTestId('filament-colour-1');
    const initialActualColourValue = (await initialActualColour.getAttribute('value'))!;
    await expect(initialActualColour).toHaveAttribute('value', initialActualColourValue);
    await page.getByTestId('filament-slot-1').click({ button: 'right' });
    await page.getByTestId('filament-edit-1').click();
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('preset-editor-title')).not.toBeEmpty();
    const filamentSourceName = await page.getByTestId('preset-editor-title').textContent();
    if (!filamentSourceName) throw new Error('expected Filament canonical source name');
    const defaultColour = page.getByTestId('preset-editor-input-default_filament_colour');
    const initialDefaultColour = (await defaultColour.getAttribute('value'))!;
    await defaultColour.click();
    await page.getByRole('textbox', { name: 'HEX color', exact: true }).fill('#123456');
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(defaultColour).toHaveAttribute('value', '#123456');
    await expect(page.getByTestId('preset-editor-project-draft')).toHaveText('Project draft');
    await expect(page.getByTestId('preset-editor-option-label-default_filament_colour'))
      .toHaveAttribute('data-draft-override-highlight', 'true');
    await expect(initialActualColour).toHaveAttribute('value', initialActualColourValue);
    await page.getByTestId('preset-editor-page-tab-advanced').click();
    const filamentStartGcode = page.getByTestId('preset-editor-input-filament_start_gcode');
    const initialFilamentStartGcode = await filamentStartGcode.inputValue();
    await filamentStartGcode.fill('G28\nM104 S205\nM140 S60\n');
    await filamentStartGcode.press('Control+Enter');
    await expect(filamentStartGcode).toHaveValue('G28\nM104 S205\nM140 S60\n');
    await expect(initialActualColour).toHaveAttribute('value', initialActualColourValue);

    const vectorChanges: Record<string, { before: string; after: string }> = {};
    if (REAL) {
      await page.getByTestId('preset-editor-page-tab-filament').click();
      vectorChanges.filament_max_volumetric_speed = await editNumericField(
        page, 'filament_max_volumetric_speed', 'float', 1,
      );
      vectorChanges.filament_adhesiveness_category = await editNumericField(
        page, 'filament_adhesiveness_category', 'int', 1,
      );
      vectorChanges.filament_shrink = await editNumericField(page, 'filament_shrink', 'percent', 0.25);
      await expect(page.getByTestId('preset-editor-field-filament_shrink')).toContainText('%');

      const nullableBool = page.getByTestId('preset-editor-input-filament_adaptive_volumetric_speed');
      await expect(page.getByTestId('preset-editor-field-filament_adaptive_volumetric_speed'))
        .toHaveAttribute('data-native-scalar-type', 'bool');
      vectorChanges.filament_adaptive_volumetric_speed = {
        before: (await nullableBool.textContent())?.trim() ?? '',
        after: '',
      };
      await nullableBool.click();
      await page.getByRole('option', { name: 'Not set', exact: true }).click();
      await expect(nullableBool).toContainText('Not set');
      await nullableBool.click();
      await page.getByRole('option', { name: 'Enabled', exact: true }).click();
      await expect(nullableBool).toContainText('Enabled');
      vectorChanges.filament_adaptive_volumetric_speed.after = 'Enabled';

      await page.getByTestId('preset-editor-page-tab-cooling').click();
      vectorChanges.overhang_fan_threshold = await editClosedEnumField(page, 'overhang_fan_threshold');
    }
    await page.getByTestId('preset-editor-close').click();

    await page.getByTestId('filament-add').click();
    await expect(page.getByTestId('filament-slot-2')).toBeVisible();
    const secondActualColour = page.getByTestId('filament-colour-2');
    const secondActualColourValue = (await secondActualColour.getAttribute('value'))!;
    await page.getByTestId('filament-slot-2').click({ button: 'right' });
    await page.getByTestId('filament-edit-2').click();
    await expect(page.getByTestId('preset-editor-title')).toHaveText(filamentSourceName);
    await expect(page.getByTestId('preset-editor-slot-reference'))
      .toHaveText('Used by slot 1 and slot 2. Editing this source affects those slots.');
    await expect(page.getByTestId('preset-editor-input-default_filament_colour')).toHaveAttribute('value', '#123456');
    await expect(page.getByTestId('filament-colour-1')).toHaveAttribute('value', initialActualColourValue);
    await expect(secondActualColour).toHaveAttribute('value', secondActualColourValue);
    if (REAL) {
      await page.getByTestId('preset-editor-page-tab-filament').click();
      for (const key of [
        'filament_max_volumetric_speed', 'filament_adhesiveness_category', 'filament_shrink',
      ]) {
        await expect(page.getByTestId(`preset-editor-input-${key}`)).toHaveValue(vectorChanges[key].after);
      }
      await expect(page.getByTestId('preset-editor-input-filament_adaptive_volumetric_speed'))
        .toContainText(vectorChanges.filament_adaptive_volumetric_speed.after);
      await page.getByTestId('preset-editor-page-tab-cooling').click();
      await expect(page.getByTestId('preset-editor-input-overhang_fan_threshold'))
        .toContainText(vectorChanges.overhang_fan_threshold.after);
    }
    await page.getByTestId('preset-editor-page-tab-advanced').click();
    await expect(page.getByTestId('preset-editor-input-filament_start_gcode'))
      .toHaveValue('G28\nM104 S205\nM140 S60\n');

    await page.getByTestId('preset-editor-reset-preset').click();
    await expect(page.getByTestId('preset-editor-project-draft')).toHaveCount(0);
    await expect(page.getByTestId('preset-editor-input-filament_start_gcode')).toHaveValue(initialFilamentStartGcode);
    await page.getByTestId('preset-editor-page-tab-filament').click();
    await expect(page.getByTestId('preset-editor-input-default_filament_colour')).toHaveAttribute('value', initialDefaultColour);
    await expect(page.getByTestId('filament-colour-1')).toHaveAttribute('value', initialActualColourValue);
    await expect(secondActualColour).toHaveAttribute('value', secondActualColourValue);
    if (REAL) {
      for (const key of [
        'filament_max_volumetric_speed', 'filament_adhesiveness_category', 'filament_shrink',
      ]) {
        await expect(page.getByTestId(`preset-editor-input-${key}`)).toHaveValue(vectorChanges[key].before);
      }
      const nullableBool = page.getByTestId('preset-editor-input-filament_adaptive_volumetric_speed');
      await expect(nullableBool).toContainText(vectorChanges.filament_adaptive_volumetric_speed.before);
      await page.getByTestId('preset-editor-page-tab-cooling').click();
      await expect(page.getByTestId('preset-editor-input-overhang_fan_threshold'))
        .toContainText(vectorChanges.overhang_fan_threshold.before);
      await page.getByTestId('preset-editor-close').click();

      await page.getByTestId('history-undo').click();
      await page.getByTestId('filament-slot-2').click({ button: 'right' });
      await page.getByTestId('filament-edit-2').click();
      await expect(page.getByTestId('preset-editor-project-draft')).toHaveText('Project draft');
      await page.getByTestId('preset-editor-page-tab-filament').click();
      for (const key of [
        'filament_max_volumetric_speed', 'filament_adhesiveness_category', 'filament_shrink',
      ]) {
        await expect(page.getByTestId(`preset-editor-input-${key}`)).toHaveValue(vectorChanges[key].after);
      }
      await expect(page.getByTestId('preset-editor-input-filament_adaptive_volumetric_speed'))
        .toContainText(vectorChanges.filament_adaptive_volumetric_speed.after);
      await page.getByTestId('preset-editor-page-tab-cooling').click();
      await expect(page.getByTestId('preset-editor-input-overhang_fan_threshold'))
        .toContainText(vectorChanges.overhang_fan_threshold.after);
      await page.getByTestId('preset-editor-close').click();

      await page.getByTestId('history-redo').click();
      await page.getByTestId('filament-slot-2').click({ button: 'right' });
      await page.getByTestId('filament-edit-2').click();
      await expect(page.getByTestId('preset-editor-project-draft')).toHaveCount(0);
      await page.getByTestId('preset-editor-page-tab-filament').click();
      for (const key of [
        'filament_max_volumetric_speed', 'filament_adhesiveness_category', 'filament_shrink',
      ]) {
        await expect(page.getByTestId(`preset-editor-input-${key}`)).toHaveValue(vectorChanges[key].before);
      }
      await expect(page.getByTestId('preset-editor-input-filament_adaptive_volumetric_speed'))
        .toContainText(vectorChanges.filament_adaptive_volumetric_speed.before);
      await page.getByTestId('preset-editor-page-tab-cooling').click();
      await expect(page.getByTestId('preset-editor-input-overhang_fan_threshold'))
        .toContainText(vectorChanges.overhang_fan_threshold.before);
      await expect(page.getByTestId('filament-colour-1')).toHaveAttribute('value', initialActualColourValue);
      await expect(secondActualColour).toHaveAttribute('value', secondActualColourValue);
    }
  } finally {
    await app.close();
  }
});
