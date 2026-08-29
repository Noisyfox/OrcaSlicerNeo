import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
}

interface MoonrakerFixture {
  baseUrl: string;
  state: MoonrakerFixtureState;
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
  const state: MoonrakerFixtureState = {
    consoleApiKeys: [],
    uploadBodies: [],
    uploadApiKeys: [],
    startPaths: [],
    startApiKeys: [],
    // The first Send & Print start fails. The explicit retry succeeds.
    startFailures,
  };

  const server: Server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
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
      sendJson(response, 200, { result: { item: { path: 'gcodes/fixture-output.gcode' } } });
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
  const app = await _electron.launch({ args: ['.', ...glFlag], cwd: DESKTOP_ROOT, env });
  return { app, fixtureDir };
}

async function waitForConsoleKey(fixture: MoonrakerFixture, key: string): Promise<void> {
  await expect.poll(() => fixture.state.consoleApiKeys, { timeout: 20_000 }).toContain(key);
}

async function waitForReady(page: Page): Promise<void> {
  await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready');
}

async function addFixtureModelAndSlice(page: Page): Promise<void> {
  await page.locator('[role="tab"]').first().click();
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

test('Device config and Electron console fixture inject the API key', async () => {
  const fixture = await startMoonrakerFixture();
  const { app } = await launchApp({ version: 1, printers: [] });
  try {
    const page = await app.firstWindow();
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
    const rows = page.locator('[role="listitem"]');
    await expect(rows).toHaveCount(2);
    // Newly saved records remain unselected until the user explicitly chooses one.
    await expect(page.getByTestId('device-console-empty')).toContainText('Select a printer');

    await rows.filter({ hasText: 'Fixture A' }).locator('button[data-testid^="device-select-"]').click();
    await waitForConsoleKey(fixture, API_KEY);
    await expect(page.getByTestId('device-console-status')).toHaveCount(0);

    // Editing a selected printer keeps its console integration attached.
    await rows.filter({ hasText: 'Fixture A' }).getByTestId(/device-edit-/).click();
    await page.getByTestId('device-display-name').fill('Fixture A edited');
    await page.getByTestId('device-save-printer').click();

    // Delete requires confirmation and removes the second record only.
    await rows.filter({ hasText: 'Fixture B' }).getByTestId(/device-delete-/).click();
    await expect(page.getByTestId('device-delete-dialog')).toBeVisible();
    await page.getByTestId('device-confirm-delete').click();
    await expect(page.locator('[role="listitem"]')).toHaveCount(1);
    await expect(page.locator('[role="listitem"]')).toContainText('Fixture A edited');
  } finally {
    await app.close();
    await fixture.close();
  }
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
    await page.getByTestId(`device-select-${printerId}`).click();
    await waitForConsoleKey(fixture, API_KEY);
    await addFixtureModelAndSlice(page);

    // Send is upload-only.
    await page.getByTestId('btn-send').click();
    await chooseSendPrinter(page, printerId);
    await page.getByTestId('send-submit').click();
    await expect(page.getByTestId('send-operation-message')).toContainText('uploaded');
    await expect.poll(() => fixture.state.uploadBodies.length).toBe(1);
    await expect.poll(() => fixture.state.startPaths.length).toBe(0);
    await page.getByTestId('send-close').click();

    // Send & Print uploads once, reports the failed start, then retries start only.
    await page.getByTestId('btn-send-and-print').click();
    await chooseSendPrinter(page, printerId);
    await page.getByTestId('send-submit').click();
    await expect(page.getByTestId('send-operation-message')).toHaveAttribute('data-error-code', 'start-failed-after-upload');
    await expect(page.getByTestId('send-operation-message')).toContainText('file remains on the printer');
    await expect.poll(() => fixture.state.uploadBodies.length).toBe(2);
    await expect.poll(() => fixture.state.startPaths.length).toBe(1);
    await expect(fixture.state.startPaths[0]).toBe('gcodes/fixture-output.gcode');
    await page.getByTestId('send-retry-start').click();
    await expect(page.getByTestId('send-operation-message')).toContainText('Print started.');
    await expect.poll(() => fixture.state.uploadBodies.length).toBe(2);
    await expect.poll(() => fixture.state.startPaths.length).toBe(2);
    await expect(fixture.state.startPaths[1]).toBe('gcodes/fixture-output.gcode');
  } finally {
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
