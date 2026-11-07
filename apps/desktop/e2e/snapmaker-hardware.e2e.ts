/** Opt-in real U1 acceptance. No print-start or motion/heater/material commands. */
import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { _electron } from './electron-fixture';
import { createSnapmakerService, normalizePrinterConfigurationDocument, readSynchronizationSource, type PrinterTransportRequest } from '@orca/printer-control';
import type * as D from '@orca/printer-control/domain';

const configPath = process.env.NEO_U1_ACCEPTANCE_CONFIG;
test.skip(!configPath, 'Requires an explicitly selected real U1 configuration.');
const id = <K extends string>(value: string) => value as D.Id<K>;
function selectedPrinter() {
  const source = normalizePrinterConfigurationDocument(JSON.parse(readFileSync(configPath!, 'utf8')));
  const matches = source.printers.filter(printer => printer.printerModel?.model === 'Snapmaker U1');
  expect(matches, 'Supply a configuration containing exactly one U1').toHaveLength(1);
  return matches[0];
}


test('real U1 reads hardware, inventory, preferences and consumer-owned monitoring without printing', async ({}, info) => {
  test.setTimeout(60000);
  const selected = selectedPrinter();
  expect(selected).toBeTruthy();
  const doc = normalizePrinterConfigurationDocument({ version: 1, printers: [{ ...selected, driverId: 'snapmaker' }] });
  const requests: string[] = [];
  const service = createSnapmakerService({ configuration: { load: async () => doc, save: async () => { throw new Error('No configuration writes'); } },
    host: { id: id('acceptance'), name: 'Real U1 acceptance', execution: 'desktop' },
    transport: { async request(request: PrinterTransportRequest) {
      expect(request.method).toBe('GET');
      requests.push(new URL(request.url).pathname);
      const response = await fetch(request.url, { method: request.method, headers: request.headers, signal: request.signal });
      return { status: response.status, bytes: async () => new Uint8Array(await response.arrayBuffer()), json: () => response.json() };
    } } });
  const target = { printerId: id<'printer'>(selected.id), routeId: id<'route'>(`snapmaker:${selected.id}`) };
  const topics = ['status', 'descriptor', 'materials', 'thermal', 'actuators', 'sensors', 'preferences'] as const;
  const result = await service.observations.read({ target, topics, source: 'device' });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  const description = await service.describe(target);
  writeFileSync(info.outputPath('observations.json'), JSON.stringify({ result, description }, null, 2));
  if (!result.ok || !description.ok) throw new Error('Device acquisition failed');
  expect(result.value.values.materials?.kind).toBe('known');
  expect(result.value.values.thermal?.kind).toBe('known');
  expect(result.value.values.preferences?.kind).toBe('known');
  if (result.value.values.preferences?.kind === 'known') expect(result.value.values.preferences.value.fields.length).toBeGreaterThan(0);
  expect(description.value.capabilities.commands['materials.load'].kind).toBe('supported');
  const saved = await service.listSaved();
  if (!saved.ok) throw new Error('Saved U1 unavailable');
  const source = await readSynchronizationSource(service, saved.value[0], saved.value[0].routes[0], 'printer', { refresh: true });
  expect(source).toMatchObject({ ok: true, value: {
    identity: { manufacturer: 'Snapmaker', model: 'Snapmaker U1' },
    tools: Array.from({ length: 4 }, () => ({ diameterMm: .4 })),
  } });
  writeFileSync(info.outputPath('synchronization.json'), JSON.stringify(source, null, 2));
  const abort = new AbortController();
  let events = 0;
  const watching = (async () => { for await (const _ of service.observations.watch({ target, topics }, { signal: abort.signal })) events++; })();
  try {
    await expect.poll(() => events).toBeGreaterThan(1);
    const before = requests.length;
    await new Promise(resolve => setTimeout(resolve, 2300));
    expect(requests.length).toBeGreaterThan(before);
  } finally { abort.abort(); await watching; }
  const stopped = requests.length;
  await new Promise(resolve => setTimeout(resolve, 2500));
  expect(requests.length).toBe(stopped);
  const cache = await service.observations.read({ target, topics: ['materials'], source: 'cache' });
  expect(cache).toMatchObject({ ok: true, value: { values: { materials: { kind: 'known', freshness: 'stale' } } } });
  writeFileSync(info.outputPath('requests.json'), JSON.stringify(requests, null, 2));
});

test('real U1 Device displays current materials, controls and preferences through Electron', async ({}, info) => {
  test.setTimeout(90000);
  const selected = selectedPrinter();
  expect(selected).toBeTruthy();
  const directory = mkdtempSync(join(tmpdir(), 'neo-u1-hardware-'));
  const config = join(directory, 'printer-config.json');
  writeFileSync(config, JSON.stringify({ version: 1, printers: [{ ...selected, driverId: 'snapmaker' }] }));
  const env: Record<string, string> = { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1', ORCA_E2E_PRINTER_CONFIG: config };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.', `--user-data-dir=${join(directory, 'user-data')}`], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 1100 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 60000 });
    await page.getByTestId('tab-device').click();
    await page.getByTestId('device-printer-select').click();
    await page.getByTestId(`device-select-${selected.id}`).click();
    await page.locator('#device-tab-monitor').click();
    for (let i = 1; i <= 4; i++) await expect(page.getByRole('button', { name: `Load to Toolhead ${i}`, exact: true })).toBeEnabled();
    await expect(page.getByRole('combobox', { name: 'Auto-refill', exact: true })).toContainText('On');
    await expect(page.getByRole('combobox', { name: 'Filament motion sensitivity', exact: true })).toContainText('medium');
    const lighting = page.getByRole('heading', { name: 'Fans and lighting', exact: true }).locator('..');
    await lighting.locator('summary').filter({ hasText: /^Lights ·/ }).click();
    await expect(lighting.getByRole('checkbox', { name: 'Chamber light', exact: true })).toHaveAttribute('data-slot', 'checkbox');
    await lighting.screenshot({ path: info.outputPath('u1-light-checkbox.png'), animations: 'disabled' });
    await page.screenshot({ path: info.outputPath('u1-monitor.png'), fullPage: true });
    writeFileSync(info.outputPath('u1-monitor.txt'), await page.locator('body').innerText());
    // Editing a local draft and refreshing must not mutate the printer or discard the draft.
    await page.getByRole('combobox', { name: 'Turn lights off after printing', exact: true }).click();
    await page.getByRole('option', { name: 'On', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Turn lights off after printing', exact: true })).toContainText('On');
    await page.getByRole('combobox', { name: 'Turn lights off after printing', exact: true }).click();
    await page.getByRole('option', { name: 'Off', exact: true }).click();
    await page.locator('#app-tab-home').click();
  } finally { await app.close(); }
});

test('real U1 Monitor displays the current task thumbnail', async ({}, info) => {
  test.setTimeout(90000);
  const selected = selectedPrinter();
  const headers = selected.apiKey ? { 'X-Api-Key': selected.apiKey } : undefined;
  const base = selected.apiBaseUrl.replace(/\/$/, '');
  const status = await fetch(`${base}/printer/objects/query?print_stats`, { headers });
  expect(status.ok).toBe(true);
  const stats = (await status.json()).result.status.print_stats;
  test.skip(!stats.filename || stats.state === 'standby', 'Requires a retained current U1 job.');
  const metadataResponse = await fetch(`${base}/server/files/metadata?filename=${encodeURIComponent(stats.filename)}`, { headers });
  expect(metadataResponse.ok).toBe(true);
  const metadata = (await metadataResponse.json()).result;
  test.skip(!metadata.thumbnails?.length, 'Requires a current job with embedded thumbnails.');
  const expected = [...metadata.thumbnails].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const directory = mkdtempSync(join(tmpdir(), 'neo-u1-preview-'));
  const config = join(directory, 'printer-config.json');
  writeFileSync(config, JSON.stringify({ version: 1, printers: [{ ...selected, driverId: 'snapmaker' }] }));
  const env: Record<string, string> = { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1', ORCA_E2E_PRINTER_CONFIG: config };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.', `--user-data-dir=${join(directory, 'user-data')}`], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 1100 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 60000 });
    await page.getByTestId('tab-device').click();
    await page.getByTestId('device-printer-select').click();
    await page.getByTestId(`device-select-${selected.id}`).click();
    const image = page.getByRole('img', { name: 'Current print preview', exact: true });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => ({ width: element.naturalWidth, height: element.naturalHeight })))
      .toEqual({ width: expected.width, height: expected.height });
    await page.locator('.printer-print-preview').screenshot({ path: info.outputPath('u1-current-task-preview.png') });
    writeFileSync(info.outputPath('u1-preview-readback.json'), JSON.stringify({ filename: stats.filename, jobId: metadata.job_id, thumbnail: expected }, null, 2));
  } finally { await app.close(); }
});

test('real U1 Monitor shows completed job layers, zero remaining time and an idle stage', async ({}, info) => {
  test.setTimeout(90000);
  const selected = selectedPrinter();
  const response = await fetch(new URL('/printer/objects/query?print_stats&machine_state_manager', selected.apiBaseUrl), {
    headers: selected.apiKey ? { 'X-Api-Key': selected.apiKey } : undefined,
  });
  expect(response.ok).toBe(true);
  const raw = (await response.json()).result.status;
  test.skip(raw.print_stats.state !== 'complete', 'Requires a completed real U1 job with retained layer information.');
  expect(raw.print_stats.info.current_layer).toBeGreaterThan(0);
  expect(raw.print_stats.info.total_layer).toBeGreaterThan(0);
  expect(raw.machine_state_manager).toEqual({ main_state: 0, action_code: 0 });
  const directory = mkdtempSync(join(tmpdir(), 'neo-u1-layer-'));
  const config = join(directory, 'printer-config.json');
  writeFileSync(config, JSON.stringify({ version: 1, printers: [{ ...selected, driverId: 'snapmaker' }] }));
  const env: Record<string, string> = { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1', ORCA_E2E_PRINTER_CONFIG: config };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.', `--user-data-dir=${join(directory, 'user-data')}`], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 1100 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 60000 });
    await page.getByTestId('tab-device').click();
    await page.getByTestId('device-printer-select').click();
    await page.getByTestId(`device-select-${selected.id}`).click();
    const facts = page.locator('.printer-print-facts');
    await expect(facts).toContainText(`${raw.print_stats.info.current_layer} / ${raw.print_stats.info.total_layer}`);
    await expect(facts.locator('dt:has-text("Remaining") + dd')).toHaveText('0 min');
    await expect(facts.locator('dt:has-text("Stage") + dd')).toHaveText('—');
    writeFileSync(info.outputPath('u1-layer-readback.json'), JSON.stringify({ raw, rendered: await facts.innerText() }, null, 2));
    await page.screenshot({ path: info.outputPath('u1-monitor-completed-layers.png'), fullPage: true });
  } finally { await app.close(); }
});

test('real U1 prepares six materials, restores light/preferences and uploads without starting', async ({}, info) => {
  test.skip(process.env.NEO_U1_ACCEPTANCE_WRITES !== '1', 'Explicit opt-in for restored light/preferences and upload-only.');
  test.setTimeout(90000);
  const selected = selectedPrinter();
  const doc = normalizePrinterConfigurationDocument({ version: 1, printers: [{ ...selected, driverId: 'snapmaker' }] });
  const requests: { method: string; path: string; script?: string }[] = [];
  const allowed = /^(SET_LED LED=cavity_led WHITE=[01]|SET_PRINT_PREFERENCES END_LED_TURN_OFF=[01])$/;
  let uploadedPath: string | undefined;
  const service = createSnapmakerService({ configuration: { load: async () => doc, save: async () => { throw new Error('No configuration writes'); } },
    host: { id: id('acceptance'), name: 'Real U1 acceptance', execution: 'desktop' }, transport: { async request(request) {
      const path = new URL(request.url).pathname;
      let body: string | FormData | undefined;
      let script: string | undefined;
      if (request.method === 'POST') {
        if (path === '/printer/gcode/script' && request.body?.kind === 'json') {
          script = JSON.parse(request.body.json).script;
          expect(script).toMatch(allowed); body = request.body.json;
        } else {
          expect(path).toBe('/server/files/upload');
          if (request.body?.kind !== 'multipart') throw new Error('Only upload-only multipart is allowed');
          expect(request.body.fields.print).toBeUndefined();
          const data = new FormData();
          for (const [key, value] of Object.entries(request.body.fields)) data.set(key, value);
          data.set('file', new Blob([new Uint8Array(request.body.file.bytes)]), request.body.file.fileName); body = data;
        }
      }
      requests.push({ method: request.method, path, ...(script ? { script } : {}) });
      const response = await fetch(request.url, { method: request.method, headers: request.headers, body, signal: request.signal });
      return { status: response.status, bytes: async () => new Uint8Array(await response.arrayBuffer()), json: async () => { const value = await response.json(); if (path === '/server/files/upload') uploadedPath = value.item?.path; return value; } };
    } } });
  const target = { printerId: id<'printer'>(selected.id), routeId: id<'route'>(`snapmaker:${selected.id}`) };
  const headers = selected.apiKey ? { 'X-Api-Key': selected.apiKey } : undefined;
  const query = async () => {
    const response = await fetch(new URL('/printer/objects/query?print_task_config&print_stats&led%20cavity_led', selected.apiBaseUrl), { headers });
    return (await response.json()).result.status;
  };
  const before = await query();
  expect(before.print_stats.state).toBe('standby');
  const initialWhite = before['led cavity_led'].color_data[0][3];
  expect([0, 1]).toContain(initialWhite);
  const initialPreference = before.print_task_config.end_led_turn_off;
  expect(typeof initialPreference).toBe('boolean');
  const requirements: D.PrintRequirements = { contentId: 'read-only-acceptance', plateId: 'acceptance', printerModel: 'Snapmaker U1', printerModelId: 'Snapmaker U1',
    materials: Array.from({ length: 6 }, (_, index) => ({ key: `filament-${index}`, index, toolIndex: index % 4, type: 'PLA', color: '#080A0D', presetId: 'acceptance', presetName: 'PLA', brand: 'Snapmaker', nozzleDiameter: .4, nozzleFlowType: 'Standard', nozzleTemperature: 210, initialLayerNozzleTemperature: 215, chamberTemperature: 0, softeningTemperature: 55, requiredNozzleHardness: 0, usedGrams: 1, usedMeters: .3 })),
    nozzleDiameters: [.4, .4, .4, .4], nozzleFlowTypes: ['Standard', 'Standard', 'Standard', 'Standard'], filamentMap: [1, 2, 3, 4, 1, 2], requiresDynamicMapping: false,
    bedType: 'High Temp Plate', durationSeconds: 60, layerCount: 10, weightGrams: 6, timelapseWarningCode: 0, toolpathOutside: false, warnings: [] };
  const input: D.PrintPreparationRequest = { target, requirements, bindings: [], options: { flowCalibration: 'on' }, suggest: true, allowAbnormalStorage: false };
  const initial = await service.submissions.prepare(input);
  expect(initial.ok).toBe(true); if (!initial.ok) throw new Error('Preparation failed');
  expect(initial.value.issues.filter(issue => issue.severity === 'block')).toEqual([]);
  expect(initial.value.bindings.map(b => b.pathId)).toEqual([0, 1, 2, 3, 0, 1].map(i => `snapmaker-path:${i}`));
  const bindings = requirements.materials.map(m => ({ materialKey: m.key, pathId: id<'path'>('snapmaker-path:0') }));
  const shared = await service.submissions.prepare({ ...input, suggest: false, bindings });
  expect(shared.ok).toBe(true); if (!shared.ok) throw new Error('Shared mapping failed');
  expect(shared.value.bindings).toEqual(bindings);
  expect(shared.value.calibrationTools).toHaveLength(1);
  expect(shared.value.issues.some(issue => issue.severity === 'warning')).toBe(true);
  writeFileSync(info.outputPath('preparation.json'), JSON.stringify({ initial: initial.value, shared: shared.value }, null, 2));
  const command = async (value: D.CommandOf<'lights.set'> | D.CommandOf<'preferences.set'>) => {
    const requestId = id<'request'>(crypto.randomUUID());
    const submitted = await service.controls.submit(value.type === 'lights.set'
      ? { target, requestId, command: value } : { target, requestId, command: value });
    expect(submitted.kind).toBe('recorded'); if (submitted.kind !== 'recorded') throw new Error('Command rejected');
    let phase: string | undefined;
    for await (const operation of service.operations.watch(submitted.operation)) phase = operation.phase.kind;
    expect(['acknowledged', 'completed']).toContain(phase);
  };
  try {
    await command({ type: 'lights.set', params: { lightId: id('snapmaker-light'), on: initialWhite === 0 } });
    expect((await query())['led cavity_led'].color_data[0][3]).toBe(1 - initialWhite);
    await command({ type: 'preferences.set', params: { changes: [{ key: 'lightsOffAfterPrint', value: !initialPreference }] } });
    expect((await query()).print_task_config.end_led_turn_off).toBe(!initialPreference);
  } finally {
    try { await command({ type: 'lights.set', params: { lightId: id('snapmaker-light'), on: initialWhite === 1 } }); }
    finally { await command({ type: 'preferences.set', params: { changes: [{ key: 'lightsOffAfterPrint', value: initialPreference }] } }); }
  }
  const restored = await query();
  expect(restored['led cavity_led'].color_data).toEqual(before['led cavity_led'].color_data);
  expect(restored.print_task_config).toEqual(before.print_task_config);
  const bytes = readFileSync(process.env.NEO_U1_ACCEPTANCE_GCODE!);
  const fileName = `NEO_acceptance_DO_NOT_PRINT_${Date.now()}.gcode`;
  const upload = await service.files.upload({ target, requestId: id(crypto.randomUUID()), destination: { kind: 'default' }, fileName, format: 'gcode', sizeBytes: bytes.length, collisionPolicy: 'overwrite' },
    { chunks: (async function* () { yield bytes; })() });
  expect(upload.kind).toBe('recorded'); if (upload.kind !== 'recorded') throw new Error('Upload rejected');
  let phase: string | undefined;
  for await (const operation of service.operations.watch(upload.operation)) phase = operation.phase.kind;
  expect(phase).toBe('completed'); expect(uploadedPath).toBe(fileName);
  const downloaded = await fetch(new URL(`/server/files/gcodes/${encodeURIComponent(uploadedPath!)}`, selected.apiBaseUrl), { headers });
  expect(downloaded.ok).toBe(true);
  expect(Buffer.from(await downloaded.arrayBuffer()).equals(bytes)).toBe(true);
  const after = await query();
  expect(after.print_stats).toEqual(before.print_stats);
  expect(after.print_task_config).toEqual(before.print_task_config);
  expect(requests.filter(r => r.path === '/server/files/upload')).toHaveLength(1);
  writeFileSync(info.outputPath('write-evidence.json'), JSON.stringify({ fileName, sizeBytes: bytes.length, requests, settingsRestored: true, printStateUnchanged: true }, null, 2));
});

test('real U1 restores every reported device preference and the installed part/chamber fans', async ({}, info) => {
  test.skip(process.env.NEO_U1_ACCEPTANCE_WRITES !== '1', 'Explicit opt-in for reversible idle-device controls.');
  test.setTimeout(90000);
  const selected = selectedPrinter();
  const doc = normalizePrinterConfigurationDocument({ version: 1, printers: [{ ...selected, driverId: 'snapmaker' }] });
  const target = { printerId: id<'printer'>(selected.id), routeId: id<'route'>(`snapmaker:${selected.id}`) };
  const scripts: string[] = [];
  const service = createSnapmakerService({ configuration: { load: async () => doc, save: async () => { throw new Error('No configuration writes'); } },
    host: { id: id('acceptance'), name: 'Real U1 acceptance', execution: 'desktop' }, transport: { async request(request) {
      if (request.method === 'POST') {
        expect(new URL(request.url).pathname).toBe('/printer/gcode/script');
        if (request.body?.kind !== 'json') throw new Error('Unexpected write');
        const script = JSON.parse(request.body.json).script as string;
        for (const line of script.split('\n')) expect(line).toMatch(/^(?:(?:SET_PRINT_PREFERENCES|DEFECT_DETECTION_CONFIG)(?: [A-Z_]+=(?:[01]|low|medium|high))+|M106 S(?:0|51)|SET_FAN_SPEED FAN=(?:e[1-3]_fan|cavity_fan) SPEED=(?:0|0\.2))$/);
        scripts.push(script);
      }
      const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body?.kind === 'json' ? request.body.json : undefined, signal: request.signal });
      return { status: response.status, bytes: async () => new Uint8Array(await response.arrayBuffer()), json: () => response.json() };
    } } });
  const read = async () => {
    const result = await service.observations.read({ target, topics: ['status', 'preferences', 'actuators'], source: 'device' });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.values;
  };
  const original = await read();
  expect(original.status).toMatchObject({ kind: 'known', value: { printStatus: { phase: { kind: 'known', value: 'idle' } } } });
  if (original.preferences?.kind !== 'known' || original.actuators?.kind !== 'known') throw new Error('Missing initial device state');
  const fields = original.preferences.value.fields;
  const initial = fields.map(field => {
    if (field.value.kind !== 'known') throw new Error('Cannot restore unknown preference');
    return { key: field.key, value: field.value.value };
  });
  const changed = fields.map(field => {
    if (field.value.kind !== 'known') throw new Error('Unknown preference');
    const current = field.value.value;
    const value = field.choices.find(choice => choice !== current);
    if (value === undefined) throw new Error('No alternative preference');
    return { key: field.key, value };
  });
  const send = async (command: D.CommandOf<'preferences.set'> | D.CommandOf<'fans.setSpeed'>) => {
    const requestId = id<'request'>(crypto.randomUUID());
    const submitted = await service.controls.submit(command.type === 'preferences.set' ? { target, requestId, command } : { target, requestId, command });
    if (submitted.kind !== 'recorded') throw new Error(JSON.stringify(submitted));
    let phase: string | undefined;
    for await (const op of service.operations.watch(submitted.operation)) phase = op.phase.kind;
    expect(['acknowledged', 'completed']).toContain(phase);
  };
  try {
    await send({ type: 'preferences.set', params: { changes: changed } });
    const state = (await read()).preferences;
    if (state?.kind !== 'known') throw new Error('Missing preference readback');
    expect(state.value.fields.map(field => ({ key: field.key, value: field.value.kind === 'known' ? field.value.value : null }))).toEqual(changed);
  } finally { await send({ type: 'preferences.set', params: { changes: initial } }); }
  const fanIds = ['fan', 'fan_generic e1_fan', 'fan_generic e2_fan', 'fan_generic e3_fan', 'fan_generic cavity_fan'].map(name => `snapmaker-fan:${name}`);
  for (const fanId of fanIds) {
    const fan = original.actuators.value.fans.find(value => value.fanId === fanId);
    expect(fan?.speedFraction).toMatchObject({ kind: 'known', value: 0 });
    try {
      await send({ type: 'fans.setSpeed', params: { fanId: id(fanId), speedFraction: .2 } });
      const actuators = (await read()).actuators;
      if (actuators?.kind !== 'known') throw new Error('Missing fan readback');
      expect(actuators.value.fans.find(value => value.fanId === fanId)?.speedFraction).toMatchObject({ kind: 'known', value: .2 });
    } finally { await send({ type: 'fans.setSpeed', params: { fanId: id(fanId), speedFraction: 0 } }); }
  }
  const restored = await read();
  if (restored.preferences?.kind !== 'known' || restored.actuators?.kind !== 'known') throw new Error('Missing restored state');
  expect(restored.preferences.value.fields.map(field => ({ key: field.key, value: field.value.kind === 'known' ? field.value.value : null }))).toEqual(initial);
  for (const fanId of fanIds) expect(restored.actuators.value.fans.find(value => value.fanId === fanId)?.speedFraction).toMatchObject({ kind: 'known', value: 0 });
  writeFileSync(info.outputPath('restored-controls.json'), JSON.stringify({ fields: initial, fanIds, scripts, restored: true }, null, 2));
});
