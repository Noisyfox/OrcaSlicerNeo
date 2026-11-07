import { startSnapmakerFixture } from './snapmaker-fixture';
import { _electron } from './electron-fixture';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');
const MODEL_PATH = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/cube.stl');
const API_KEY = 'fixture-api-key-do-not-log';

interface MoonrakerFixtureState {
  consoleApiKeys: string[];
  uploadBodies: Buffer[];
  uploadApiKeys: Array<string | undefined>;
  startPaths: string[];
  startApiKeys: Array<string | undefined>;
  startFailures: number;
  statusReads: number;
}

interface MoonrakerFixture {
  baseUrl: string;
  state: MoonrakerFixtureState;
  holdUploadResponse(): void;
  releaseUploadResponse(): void;
  close(): Promise<void>;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

function requestApiKey(request: IncomingMessage): string | undefined {
  const key = request.headers['x-api-key'];
  return Array.isArray(key) ? key[0] : key;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function startMoonrakerFixture(startFailures = 1): Promise<MoonrakerFixture> {
  let uploadResponseGate: Promise<void> | undefined;
  let releaseUploadResponse = () => {};
  const state: MoonrakerFixtureState = {
    consoleApiKeys: [],
    uploadBodies: [],
    uploadApiKeys: [],
    startPaths: [],
    startApiKeys: [],
    // The first Send & Print start fails. The explicit retry succeeds.
    startFailures,
    statusReads: 0,
  };

  const server: Server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && pathname === '/console-worker.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end("postMessage('console-worker-ready')");
      return;
    }
    if (request.method === 'GET' && pathname === '/console') {
      const body = `<!doctype html><meta charset="utf-8"><title>Local printer console</title>
        <script>window.addEventListener('load',function(){(function waitForOrcaKey(){if(window.__orcaSlicerNeoMoonrakerFetchV1){fetch('/console-receipt',{cache:'no-store'});}else{setTimeout(waitForOrcaKey,0);}})();});</script>
        <main>Local printer console fixture</main>`;
      // The parent renderer is cross-origin isolated for threaded WASM. CORP
      // makes this loopback guest document a valid resource under that policy.
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cross-origin-resource-policy': 'cross-origin' });
      response.end(body);
      return;
    }
    if (request.method === 'GET' && pathname === '/console-receipt') {
      const key = request.headers['x-api-key'];
      state.consoleApiKeys.push(Array.isArray(key) ? key[0] ?? '' : key ?? '');
      response.writeHead(204, { 'cross-origin-resource-policy': 'cross-origin' });
      response.end();
      return;
    }
    if (request.method === 'GET' && pathname === '/server/info') {
      sendJson(response, 200, { result: { machine_name: 'local-fixture', moonraker_version: 'fixture', klippy_state: 'ready' } });
      return;
    }
    if (request.method === 'POST' && pathname === '/server/files/upload') {
      state.uploadApiKeys.push(requestApiKey(request));
      state.uploadBodies.push(await readBody(request));
      await uploadResponseGate;
      sendJson(response, 201, { item: { root: 'gcodes', path: 'fixture-output.gcode' }, action: 'create_file', print_started: false, print_queued: false });
      return;
    }
    if (request.method === 'POST' && pathname === '/printer/print/start') {
      state.startApiKeys.push(requestApiKey(request));
      const body = JSON.parse((await readBody(request)).toString('utf8')) as { filename?: unknown };
      state.startPaths.push(typeof body.filename === 'string' ? body.filename : '');
      if (state.startFailures > 0) {
        state.startFailures -= 1;
        sendJson(response, 500, { error: 'fixture start failure' });
      } else {
        sendJson(response, 200, { result: 'ok' });
      }
      return;
    }
    if (request.method === 'GET' && pathname === '/printer/objects/query') {
      state.statusReads += 1;
      sendJson(response, 200, { result: { status: { print_stats: { state: 'standby' } } } });
      return;
    }
    if (request.method === 'POST' && pathname === '/printer/gcode/script') {
      sendJson(response, 200, { result: 'ok' });
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveReady);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind to an ephemeral port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    holdUploadResponse: () => {
      uploadResponseGate = new Promise<void>((resolve) => { releaseUploadResponse = resolve; });
    },
    releaseUploadResponse: () => { releaseUploadResponse(); uploadResponseGate = undefined; },
    close: () => new Promise<void>((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed())),
  };
}

async function launchApp(printerConfig: unknown): Promise<{ app: ElectronApplication; fixtureDir: string }> {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'orca-printer-e2e-'));
  const printerConfigPath = join(fixtureDir, 'printer-config.json');
  writeFileSync(printerConfigPath, JSON.stringify(printerConfig));
  const env = {
    ...process.env,
    ORCA_E2E: '1',
    ORCA_E2E_MODEL: MODEL_PATH,
    ORCA_E2E_PRINTER_CONFIG: printerConfigPath,
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const glFlag = process.platform === 'linux' ? ['--use-angle=swiftshader-webgl'] : [];
  // Each launch owns its Chromium storage and cache, avoiding shared profile
  // state between consecutive webview tests on Windows.
  const app = await _electron.launch({
    args: ['.', `--user-data-dir=${join(fixtureDir, 'user-data')}`, ...glFlag],
    cwd: DESKTOP_ROOT,
    env,
  });
  return { app, fixtureDir };
}

async function waitForConsoleKey(fixture: MoonrakerFixture, key: string): Promise<void> {
  await expect.poll(() => fixture.state.consoleApiKeys, { timeout: 20_000 }).toContain(key);
}

async function waitForReady(page: Page): Promise<void> {
  const messages: string[] = [];
  const onConsole = (message: { type(): string; text(): string }) => messages.push(`[${message.type()}] ${message.text()}`);
  const onError = (error: Error) => messages.push(String(error));
  page.on('console', onConsole);
  page.on('pageerror', onError);
  try {
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
  } catch (error) {
    console.error('Printer E2E startup failed', {
      url: page.url(),
      body: await page.locator('body').innerText().catch(() => '(unavailable)'),
      messages,
    });
    throw error;
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onError);
  }
  await page.locator('#app-tab-prepare').click();
  await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: 30_000 });
}

async function addFixtureModelAndSlice(page: Page): Promise<void> {
  await page.locator('#app-tab-prepare').click();
  await page.getByTestId('btn-add-model').click();
  await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('btn-slice').click();
  await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 30_000 });
}

async function chooseSendPrinter(page: Page, printerId: string): Promise<void> {
  await page.getByTestId('send-printer-select').click();
  await page.getByTestId(`send-printer-${printerId}`).click();
  await expect(page.getByTestId('send-submit')).toBeEnabled();
}

test('Snapmaker manual connection persists and reopens without a model', async () => {
  const { app, fixtureDir } = await launchApp({ version: 1, printers: [] });
  try {
    const page = await app.firstWindow(); await waitForReady(page);
    await page.getByTestId('tab-device').click();
    await page.getByTestId('device-add-printer').click();
    await page.getByTestId('device-adapter').click();
    await page.getByRole('option', { name: 'Snapmaker', exact: true }).click();
    await page.getByTestId('device-display-name').fill('U1 offline');
    await page.getByTestId('device-api-base-url').fill('http://127.0.0.1:9');
    await page.getByTestId('device-save-printer').click();
    await expect(page.getByTestId('device-config-dialog')).toBeHidden();
    const saved = JSON.parse(readFileSync(join(fixtureDir, 'printer-config.json'), 'utf8')).printers[0];
    expect(saved.driverId).toBe('snapmaker'); expect(saved.printerModel).toBeUndefined();
    await page.getByTestId('device-printer-select').click();
    await page.getByTestId(`device-select-${saved.id}`).click();
    await page.getByTestId(`device-edit-${saved.id}`).click();
    await expect(page.getByTestId('device-adapter')).toContainText('Snapmaker');
    await expect(page.getByTestId('device-printer-model')).toContainText('Not specified');
  } finally { await app.close(); }
});

test('manual printer model selection persists, reopens and clears without changing project profiles', async () => {
  test.skip(process.env.ORCA_E2E_REAL === '1', 'Uses the deterministic enabled mock profile catalogue.');
  const fixture = await startMoonrakerFixture();
  const printPreferences = { 'bambu:fixture': { timelapse: false } };
  const { app, fixtureDir } = await launchApp({ version: 1, printers: [], printPreferences });
  try {
    const page = await app.firstWindow(); await waitForReady(page);
    const projectPrinter = await page.getByTestId('preset-select').textContent();
    await page.getByTestId('tab-device').click();
    await page.getByTestId('device-add-printer').click();
    await page.getByTestId('device-display-name').fill('Model fixture');
    await page.getByTestId('device-api-base-url').fill(fixture.baseUrl);
    await expect(page.getByTestId('device-printer-model')).toContainText('Not specified');
    await page.getByTestId('device-printer-model').click();
    await expect(page.getByRole('option', { name: /Afinia|Hidden/ })).toHaveCount(0);
    await page.getByLabel('Search printer models', { exact: true }).fill('X1');
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.getByRole('option', { name: 'bambulab · X1 Carbon', exact: true }).click();
    await page.getByTestId('device-save-printer').click();
    await expect(page.getByTestId('device-config-dialog')).toBeHidden();
    const saved = () => JSON.parse(readFileSync(join(fixtureDir, 'printer-config.json'), 'utf8'));
    expect(saved().printers[0].printerModel).toEqual({ vendorId: 'bambulab', model: 'X1 Carbon' });
    expect(saved().printPreferences).toEqual(printPreferences);
    const id = saved().printers[0].id;
    await page.getByTestId('device-printer-select').click();
    await page.getByTestId(`device-select-${id}`).click();
    await page.getByTestId(`device-edit-${id}`).click();
    await expect(page.getByTestId('device-printer-model')).toContainText('X1 Carbon');
    await page.getByTestId('device-printer-model').click();
    await page.getByRole('option', { name: 'Not specified', exact: true }).click();
    await page.getByTestId('device-save-printer').click();
    await expect(page.getByTestId('device-config-dialog')).toBeHidden();
    expect(saved().printers[0]).not.toHaveProperty('printerModel');
    expect(saved().printPreferences).toEqual(printPreferences);
    await page.locator('#app-tab-prepare').click();
    await expect(page.getByTestId('preset-select')).toHaveText(projectPrinter!);
  } finally { await app.close(); await fixture.close(); }
});

test('device model form follows shared control layout and keyboard behavior', async ({}, testInfo) => {
  test.skip(process.env.ORCA_E2E_REAL === '1', 'Uses the deterministic enabled mock profile catalogue.');
  const longModel = 'A printer model with a long descriptive name '.repeat(5);
  const { app } = await launchApp({ version: 1, printers: [{ id: 'ui-fixture', displayName: 'UI fixture', driverId: 'moonraker',
    apiBaseUrl: 'http://127.0.0.1:1/', consoleUrl: '', apiKey: '', printerModel: { vendorId: 'Vendor', model: longModel } }] });
  try {
    const page = await app.firstWindow(); await waitForReady(page);
    await page.getByTestId('tab-device').click();
    await page.getByTestId('device-printer-select').click();
    await page.getByTestId('device-select-ui-fixture').click();
    const edit = page.getByTestId('device-edit-ui-fixture');
    await edit.click();
    const dialog = page.getByRole('dialog', { name: 'Edit printer', exact: true });
    const trigger = page.getByTestId('device-printer-model');
    const name = page.getByTestId('device-display-name');
    await expect(name).toBeFocused();
    await expect(page.getByTestId('device-adapter').locator('[data-slot="select-value"]')).toHaveText('Moonraker');
    await expect(trigger).toHaveAccessibleDescription('Not specified allows any project printer model.');
    await expect(trigger).toHaveAttribute('title', `Vendor · ${longModel.trim()}`);
    expect(await trigger.locator('span').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await page.getByTestId('device-save-printer').focus();
    await page.keyboard.press('Tab');
    await expect(name).toBeFocused();
    await name.press('Shift+Tab');
    await expect(page.getByTestId('device-save-printer')).toBeFocused();

    for (const control of [trigger, name, dialog.locator('label[for="device-printer-model"]')]) await expect(control).toHaveCSS('font-size', '13px');
    await expect(trigger).toHaveCSS('height', '28px');
    const labelBox = (await dialog.locator('label[for="device-printer-model"]').boundingBox())!;
    const triggerBox = (await trigger.boundingBox())!;
    expect(triggerBox.x).toBeGreaterThan(labelBox.x + labelBox.width);
    expect(Math.abs(triggerBox.y - labelBox.y)).toBeLessThan(2);
    for (const field of ['device-display-name', 'device-adapter', 'device-api-base-url', 'device-console-url', 'device-api-key']) {
      expect(Math.abs((await page.getByTestId(field).boundingBox())!.x - triggerBox.x)).toBeLessThan(1);
    }
    await trigger.focus(); await trigger.press('Enter');
    const search = page.getByRole('combobox', { name: 'Search printer models', exact: true });
    await expect(search).toBeFocused();
    const popup = page.locator('[data-slot="combobox-content"]');
    await expect(popup).toHaveCSS('opacity', '1');
    const popupBox = (await popup.boundingBox())!;
    expect(popupBox.width).toBeGreaterThanOrEqual(triggerBox.width);
    expect(popupBox.x).toBeGreaterThanOrEqual(0);
    expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
    await expect(page.getByRole('option').first()).toHaveCSS('font-size', '13px');
    await page.screenshot({ path: testInfo.outputPath('device-model-popup.png'), animations: 'disabled' });
    // Exercise the actual shared list's native scrolling with the small mock catalogue.
    const list = page.locator('[data-slot="combobox-list"]');
    await list.evaluate(element => { element.style.maxHeight = '40px'; });
    expect(await list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await expect(list).toHaveCSS('overflow-y', 'auto');
    expect(await list.evaluate(element => getComputedStyle(element, '::-webkit-scrollbar').width)).toBe('6px');
    await search.fill('no-such-printer-model');
    await expect(popup).toContainText('No matching printer models.');
    await popup.getByRole('button', { name: 'Clear search', exact: true }).click();
    await expect(search).toBeFocused(); await expect(search).toHaveValue('');
    await search.press('Escape');
    await expect(popup).toBeHidden(); await expect(dialog).toBeVisible(); await expect(trigger).toBeFocused();
    await trigger.press('Enter');
    await search.fill('X1'); await search.press('ArrowDown'); await search.press('Enter');
    await expect(trigger).toContainText('X1 Carbon'); await expect(trigger).toBeFocused();
    await trigger.press('Tab'); await expect(page.getByTestId('device-api-base-url')).toBeFocused();
    await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(edit).toBeFocused();
    await edit.click();
    await page.setViewportSize({ width: 420, height: 360 });
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(420); expect(bounds.y + bounds.height).toBeLessThanOrEqual(360);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.getByTestId('device-save-printer').scrollIntoViewIfNeeded();
    await expect(dialog).toHaveCSS('opacity', '1');
    await page.screenshot({ path: testInfo.outputPath('device-model-small-window.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(edit).toBeFocused();
  } finally { await app.close(); }
});

test('Device config and Electron console fixture inject the API key', async () => {
  const fixture = await startMoonrakerFixture();
  const { app } = await launchApp({ version: 1, printers: [] });
  try {
    const page = await app.firstWindow();
    // This journey asserts wide columns before explicitly exercising the narrow layout.
    await page.setViewportSize({ width: 1280, height: 800 });
    await waitForReady(page);
    await page.getByTestId('tab-device').click();
    await expect(page.getByTestId('device-empty-list')).toBeVisible();

    async function addPrinter(name: string, key: string): Promise<void> {
      await page.getByTestId('device-add-printer').click();
      await page.getByTestId('device-display-name').fill(name);
      await page.getByTestId('device-console-url').fill(`${fixture.baseUrl}/console`);
      await page.getByTestId('device-api-base-url').fill(fixture.baseUrl);
      await page.getByTestId('device-api-key').fill(key);
      await page.getByTestId('device-save-printer').click();
      await expect(page.getByTestId('device-config-dialog')).toBeHidden();
    }

    await addPrinter('Fixture A', API_KEY);
    await addPrinter('Fixture B', 'second-fixture-key');
    await page.getByTestId('device-printer-select').click();
    await expect(page.getByRole('option')).toHaveCount(2);
    await page.keyboard.press('Escape');
    // Newly saved records remain unselected until the user explicitly chooses one.
    await expect(page.getByTestId('device-console-empty')).toContainText('Select a printer');

    await page.getByTestId('device-printer-select').click();
    await page.getByRole('option', { name: 'Fixture A', exact: true }).click();
    await waitForConsoleKey(fixture, API_KEY);
    // The console and its Workers must retain the printer's policy rather
    // than receiving the slicer's cross-origin isolation response headers.
    const guestProbe = await page.locator('webview').evaluate(async (element) => {
      const guest = element as unknown as { executeJavaScript<T>(script: string): Promise<T> };
      return guest.executeJavaScript<{ coop: string | null; coep: string | null; worker: string }>(`(async () => {
        const response = await fetch('/console-worker.js');
        const worker = await new Promise((resolve, reject) => {
          const instance = new Worker('/console-worker.js');
          const timer = setTimeout(() => { instance.terminate(); reject(new Error('console Worker timed out')); }, 5000);
          instance.onmessage = (event) => { clearTimeout(timer); instance.terminate(); resolve(event.data); };
          instance.onerror = (event) => { clearTimeout(timer); instance.terminate(); reject(new Error(event.message)); };
        });
        return { coop: response.headers.get('cross-origin-opener-policy'), coep: response.headers.get('cross-origin-embedder-policy'), worker };
      })()`);
    });
    expect(guestProbe).toEqual({ coop: null, coep: null, worker: 'console-worker-ready' });
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    await expect(page.getByTestId('device-console-status')).toHaveCount(0);

    await expect(page.getByRole('tab', { name: 'Web Interface', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Monitor', exact: true }).click();
    await expect(page.getByTestId('device-monitor')).toBeVisible();
    const monitor = page.getByTestId('device-monitor');
    await expect(monitor.getByRole('heading', { name: 'Printing progress', exact: true })).toBeVisible();
    expect(fixture.state.statusReads).toBe(0);
    await expect(monitor.getByRole('combobox', { name: 'Print speed' })).toHaveCount(0);
    await expect(monitor.getByRole('spinbutton')).toHaveCount(0);
    await expect(monitor.getByRole('button', { name: 'Home axes' })).toHaveCount(0);
    await monitor.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => fixture.state.statusReads).toBe(1);
    await expect(monitor.getByText('No readings requested. Use Refresh to read the printer.')).toHaveCount(0);
    const preview = await monitor.getByLabel('Print preview', { exact: true }).boundingBox();
    const progress = await monitor.getByRole('progressbar', { name: 'Print progress' }).boundingBox();
    expect(preview!.x + preview!.width).toBeLessThan(progress!.x);
    expect(progress!.y).toBeGreaterThanOrEqual(preview!.y);
    expect(progress!.y).toBeLessThan(preview!.y + preview!.height);
    const control = await monitor.getByRole('heading', { name: 'Control', exact: true }).boundingBox();
    expect(control!.x).toBeGreaterThan(preview!.x + preview!.width);
    await page.screenshot({ path: '/tmp/orca-moonraker-monitor.png' });
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.setViewportSize({ width: 820, height: 900 });
    await expect.poll(() => monitor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: '/tmp/orca-moonraker-monitor-narrow.png' });
    await page.setViewportSize(viewport);
    expect(fixture.state.statusReads).toBe(1);

    await expect(page.locator('webview')).toBeHidden();
    await page.getByRole('tab', { name: 'Web Interface', exact: true }).click();
    const collapse = page.getByTestId('titlebar-toggle-left-sidebar');
    await collapse.click();
    await expect(page.locator('#device-sidebar')).toBeHidden();
    await expect(page.getByTestId('device-sidebar-resizer')).toBeHidden();
    await page.locator('#app-tab-prepare').click();
    await expect(collapse).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('tab-device').click();
    await expect(collapse).toHaveAttribute('aria-pressed', 'false');
    await collapse.click();
    await expect(page.locator('#device-sidebar')).toBeVisible();

    // A guest reload creates a new document without another panel.load().
    // The API-key wrapper must be installed again in that document.
    const receiptsBeforeReload = fixture.state.consoleApiKeys.length;
    await page.locator('webview').evaluate((element) => {
      (element as unknown as { reload(): void }).reload();
    });
    await expect.poll(() => fixture.state.consoleApiKeys.slice(receiptsBeforeReload), { timeout: 20_000 }).toContain(API_KEY);

    // Editing a selected printer keeps its console integration attached.
    await page.getByTestId(/device-edit-/).click();
    await page.getByTestId('device-display-name').fill('Fixture A edited');
    await page.getByTestId('device-save-printer').click();

    // Delete requires confirmation and removes the second record only.
    await page.getByTestId('device-printer-select').click();
    await page.getByRole('option', { name: 'Fixture B', exact: true }).click();
    await page.getByTestId(/device-delete-/).click();
    await expect(page.getByTestId('device-delete-dialog')).toBeVisible();
    await page.getByTestId('device-confirm-delete').click();
    await page.getByTestId('device-printer-select').click();
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.getByRole('option', { name: 'Fixture A edited', exact: true }).click();
    // A host-published change reaches the mounted catalogue without a form refresh.
    await page.evaluate(async () => {
      const repository = (window as unknown as { orca: import('../src/shared/ipc').ElectronBridge }).orca.printers.configuration;
      const document = await repository.load();
      document.printers[0].displayName = 'Updated through host';
      await repository.save(document);
    });
    await expect(page.getByTestId('device-printer-select')).toContainText('Updated through host');
    await page.screenshot({ path: test.info().outputPath('device-web-interface.png') });
    await collapse.click();
    await expect.poll(async () => page.evaluate(async () => {
      const result = await (window as unknown as { orca: import('../src/shared/ipc').ElectronBridge }).orca.preferences.load();
      return result;
    })).toMatchObject({ json: { ui: { deviceSidebarCollapsed: true } } });
    await page.reload();
    await waitForReady(page);
    await expect(page.getByTestId('titlebar-toggle-left-sidebar')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('tab-device').click();
    await expect(page.locator('#device-sidebar')).toBeHidden();
    await expect(page.getByTestId('titlebar-toggle-left-sidebar')).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await app.close();
    await fixture.close();
  }
});

test('manual printer model filters Send and Send & Print without hiding devices in Device', async () => {
  test.skip(process.env.ORCA_E2E_REAL === '1', 'Uses the deterministic enabled mock profile catalogue.');
  const fixture = await startMoonrakerFixture();
  const connection = { driverId: 'moonraker', consoleUrl: `${fixture.baseUrl}/console`, apiBaseUrl: fixture.baseUrl, apiKey: '' };
  const { app } = await launchApp({ version: 1, printers: [
    { ...connection, id: 'match', displayName: 'Matching model', printerModel: { vendorId: 'bambulab', model: 'X1 Carbon' } },
    { ...connection, id: 'mismatch', displayName: 'Different model', printerModel: { vendorId: 'bambulab', model: 'P1S' } },
    { ...connection, id: 'any', displayName: 'Unspecified model' },
  ] });
  try {
    const page = await app.firstWindow(); await waitForReady(page);
    await page.getByTestId('tab-device').click();
    await page.getByTestId('device-printer-select').click();
    await expect(page.getByRole('option')).toHaveCount(3);
    await page.getByTestId('device-select-mismatch').click();
    await addFixtureModelAndSlice(page);
    for (const action of ['Send', 'Send & Print']) {
      await page.getByTestId('output-mode-select').click();
      await page.getByRole('menuitemradio', { name: action, exact: true }).click();
      await page.getByTestId(action === 'Send' ? 'btn-send' : 'btn-send-and-print').click();
      await expect(page.getByTestId('send-printer-select')).toBeEnabled();
      await expect(page.getByTestId('send-submit')).toBeDisabled();
      await page.getByTestId('send-printer-select').click();
      await expect(page.getByTestId('send-printer-match')).toBeVisible();
      await expect(page.getByTestId('send-printer-any')).toBeVisible();
      await expect(page.getByTestId('send-printer-mismatch')).toHaveCount(0);
      await page.getByTestId('send-printer-match').click();
      await expect(page.getByTestId('send-submit')).toBeEnabled();
      await page.getByTestId('send-close').click();
    }
    expect(fixture.state.uploadBodies).toHaveLength(0);
  } finally { await app.close(); await fixture.close(); }
});

test('Send and Send & Print use Moonraker fixture without re-upload on start failure', async () => {
  const fixture = await startMoonrakerFixture();
  const printerId = 'fixture-printer';
  const { app } = await launchApp({
    version: 1,
    printers: [{
      id: printerId,
      displayName: 'Fixture Printer',
      driverId: 'moonraker',
      consoleUrl: `${fixture.baseUrl}/console`,
      apiBaseUrl: fixture.baseUrl,
      apiKey: API_KEY,
    }],
  });
  try {
    const page = await app.firstWindow();
    await waitForReady(page);
    await page.getByTestId('tab-device').click();
    await page.getByTestId('device-printer-select').click();
    await page.getByTestId(`device-select-${printerId}`).click();
    await waitForConsoleKey(fixture, API_KEY);
    await addFixtureModelAndSlice(page);

    // Send is upload-only.
    await page.getByTestId('output-mode-select').click();
    await page.getByRole('menuitemradio', { name: 'Send', exact: true }).click();
    await page.getByTestId('btn-send').click();
    await chooseSendPrinter(page, printerId);
    fixture.holdUploadResponse();
    await page.getByTestId('send-submit').click();
    await expect.poll(() => fixture.state.uploadBodies.length).toBe(1);
    expect(fixture.state.uploadBodies[0].toString('utf8')).toMatch(/filename="[^"/\\]+\.gcode"/);
    await expect(page.getByTestId('send-progress-status')).toContainText('Waiting for printer confirmation');
    await expect(page.getByTestId('send-progress-status')).toContainText('100%');
    await expect(page.getByTestId('send-transfer-stats')).toContainText('0.0 KiB/s');
    await expect(page.getByTestId('send-transfer-stats')).toContainText(/\d.* \/ \d/);
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    await expect(page.getByTestId('send-operation-message')).toHaveCount(0);
    fixture.releaseUploadResponse();
    await expect(page.getByTestId('send-operation-message')).toContainText('uploaded');
    await expect.poll(() => fixture.state.uploadBodies.length).toBe(1);
    await expect.poll(() => fixture.state.startPaths.length).toBe(0);
    await page.getByTestId('send-close').click();

    // Send & Print uploads once, reports the failed start, then retries start only.
    await page.getByTestId('output-mode-select').click();
    await page.getByRole('menuitemradio', { name: 'Send & Print', exact: true }).click();
    await page.getByTestId('btn-send-and-print').click();
    await chooseSendPrinter(page, printerId);
    await page.getByTestId('send-submit').click();
    await expect(page.getByTestId('send-operation-message')).toHaveAttribute('data-error-code', 'start-failed-after-upload');
    await expect(page.getByTestId('send-operation-message')).toContainText('file remains on the printer');
    await expect.poll(() => fixture.state.uploadBodies.length).toBe(2);
    await expect.poll(() => fixture.state.startPaths.length).toBe(1);
    await expect(fixture.state.startPaths[0]).toBe('fixture-output.gcode');
    await page.getByTestId('send-retry-start').click();
    await expect(page.getByTestId('send-operation-message')).toContainText('Print started.');
    await expect.poll(() => fixture.state.uploadBodies.length).toBe(2);
    await expect.poll(() => fixture.state.startPaths.length).toBe(2);
    await expect(fixture.state.startPaths[1]).toBe('fixture-output.gcode');
  } finally {
    fixture.releaseUploadResponse();
    await app.close();
    await fixture.close();
  }
});

test('Send & Print works with a keyless Moonraker printer and sends no API-key headers', async () => {
  const fixture = await startMoonrakerFixture(0);
  const printerId = 'keyless-fixture-printer';
  const { app } = await launchApp({
    version: 1,
    printers: [{
      id: printerId,
      displayName: 'Keyless Fixture Printer',
      driverId: 'moonraker',
      consoleUrl: `${fixture.baseUrl}/console`,
      apiBaseUrl: fixture.baseUrl,
      apiKey: '',
    }],
  });
  try {
    const page = await app.firstWindow();
    await waitForReady(page);
    await addFixtureModelAndSlice(page);
    await page.getByTestId('output-mode-select').click();
    await page.getByRole('menuitemradio', { name: 'Send & Print', exact: true }).click();
    await page.getByTestId('btn-send-and-print').click();
    await chooseSendPrinter(page, printerId);
    await page.getByTestId('send-submit').click();
    await expect(page.getByTestId('send-operation-message')).toContainText('uploaded and print started');
    await expect.poll(() => fixture.state.uploadApiKeys).toEqual([undefined]);
    await expect.poll(() => fixture.state.startApiKeys).toEqual([undefined]);
  } finally {
    await app.close();
    await fixture.close();
  }
});


test('Snapmaker Device uses Electron transport for physical controls and verified preferences', async ({}, testInfo) => {
  const fixture = await startSnapmakerFixture();
  const { app } = await launchApp({ version: 1, printers: [{ id: 'u1', driverId: 'snapmaker', displayName: 'U1 fixture', apiBaseUrl: fixture.baseUrl, apiKey: '', consoleUrl: '' }] });
  try {
    const page = await app.firstWindow(); await waitForReady(page);
    await page.getByTestId('tab-device').click(); await page.getByTestId('device-printer-select').click(); await page.getByTestId('device-select-u1').click();
    const tabs = page.getByRole('tablist', { name: 'Printer features' }).getByRole('tab');
    await expect(tabs.nth(0)).toHaveText('Monitor'); await expect(tabs.nth(1)).toHaveText('Web Interface');
    await expect(page.locator('#device-tab-monitor')).toHaveAttribute('aria-selected', 'true');
    await page.locator('#device-tab-web').click();
    await expect(page.locator('#device-tab-web')).toHaveAttribute('aria-selected', 'true');
    await page.locator('#device-tab-monitor').click();
    const preview = page.getByRole('img', { name: 'Current print preview', exact: true });
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
    await expect(page.getByRole('button', { name: 'Load to Toolhead 1', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Load to Toolhead 1', exact: true }).click({ noWaitAfter: true });
    await expect.poll(() => fixture.scripts).toContain('FEED_AUTO MODULE=left CHANNEL=1 LOAD=1');
    await page.getByRole('button', { name: 'Material information for Toolhead 1 · Filament 1', exact: true }).click({ noWaitAfter: true });
    await page.getByLabel('Brand', { exact: true }).fill('Generic');
    await page.getByLabel('Material type', { exact: true }).fill('PLA-Silk');
    await page.screenshot({ path: testInfo.outputPath('snapmaker-material-editor.png'), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: 'Save material information', exact: true }).click({ noWaitAfter: true });
    await expect(page.getByRole('heading', { name: 'Material information', exact: true })).toBeHidden();
    expect(fixture.scripts.some(script => script.includes('FILAMENT_TYPE="PLA" FILAMENT_SUBTYPE="Silk"'))).toBe(true);
    const autoRefill = page.getByRole('combobox', { name: 'Auto-refill', exact: true });
    await autoRefill.click();
    await page.getByRole('option', { name: 'On', exact: true }).click();
    await expect(autoRefill).toContainText('On');
    await page.getByRole('button', { name: 'Save printer preferences' }).click({ noWaitAfter: true });
    await expect(page.getByText('Printer preferences saved and verified.')).toBeVisible();
    await expect(page.locator('[data-testid="device-monitor"] .printer-control-column').getByRole('heading', { name: 'Printer preferences', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('snapmaker-preferences.png'), fullPage: true, animations: 'disabled' });
    expect(fixture.scripts).toContain('SET_PRINT_PREFERENCES AUTO_REPLENISH_FILAMENT=1');
    await page.locator('#app-tab-prepare').click();
    const count = fixture.queryCount();
    await expect.poll(() => fixture.queryCount()).toBeGreaterThan(count);
  } finally { await app.close(); await fixture.close(); }
});


test('unfinished sending guards desktop close after the project decision and cancels before exit', async ({}, testInfo) => {
  const fixture = await startMoonrakerFixture(0);
  const { app } = await launchApp({ version: 1, printers: [{ id: 'exit-printer', driverId: 'moonraker', displayName: 'Exit fixture', apiBaseUrl: fixture.baseUrl, apiKey: '', consoleUrl: '' }] });
  try {
    const page = await app.firstWindow(); await waitForReady(page); await addFixtureModelAndSlice(page);
    await page.getByTestId('output-mode-select').click(); await page.getByRole('menuitemradio', { name: 'Send & Print', exact: true }).click();
    await page.getByTestId('btn-send-and-print').click(); await chooseSendPrinter(page, 'exit-printer');
    fixture.holdUploadResponse(); await page.getByTestId('send-submit').click({ noWaitAfter: true });
    await expect.poll(() => fixture.state.uploadBodies.length).toBe(1);
    async function requestClose() {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
      await expect(page.getByTestId('project-dirty-dialog')).toBeVisible();
      await page.getByTestId('project-dirty-dont-save').click({ noWaitAfter: true });
      await expect(page.getByText('Sending is still in progress', { exact: true })).toBeVisible();
    }
    await requestClose();
    const dialog = page.getByRole('alertdialog', { name: 'Sending is still in progress', exact: true });
    const returnButton = dialog.getByRole('button', { name: 'Return to app', exact: true });
    const stopButton = dialog.getByRole('button', { name: 'Stop sending and exit', exact: true });
    await expect(returnButton).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(stopButton).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(returnButton).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('unfinished-send-dialog.png'), fullPage: true, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(page.isClosed()).toBe(false); expect(fixture.state.startPaths).toHaveLength(0);
    await requestClose(); await returnButton.click();
    expect(page.isClosed()).toBe(false); expect(fixture.state.startPaths).toHaveLength(0);
    await requestClose(); const closed = page.waitForEvent('close');
    await stopButton.click({ noWaitAfter: true }).catch(error => {
      // Successful exit can close the renderer before the click acknowledgement.
      if (!page.isClosed()) throw error;
    });
    await closed; expect(fixture.state.startPaths).toHaveLength(0);
  } finally {
    fixture.releaseUploadResponse();
    if (app.windows().some(window => !window.isClosed())) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy()));
    await app.close(); await fixture.close();
  }
});
