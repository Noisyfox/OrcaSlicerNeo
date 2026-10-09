import { selectFixturePrinter } from '../../desktop/e2e/printer-selection';
import { expectCurrentPlate, clickPlateControl } from '../../desktop/e2e/plate-controls.helpers';
import { test, expect, configuredActivation } from './browser-fixture';

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));

test('real Web Send preserves browser multipart encoding and starts the server-returned path', async ({ page }) => {
  let uploadBody = '';
  let startPath = '';
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/server/files/upload') {
      uploadBody = body;
      response.end(JSON.stringify({ result: { item: { path: 'nested/server-selected.GCODE' } } }));
    } else if (request.url === '/printer/print/start') {
      startPath = JSON.parse(body).filename;
      response.end('{}');
    } else { response.writeHead(404); response.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  try {
    await page.addInitScript(({ baseUrl, profileActivation }) => {
      localStorage.setItem('orca-slicer-neo:printer-configuration:v1', JSON.stringify({ version: 1, printers: [{
        id: 'web-fixture', displayName: 'Web fixture', driverId: 'moonraker', apiBaseUrl: baseUrl, consoleUrl: baseUrl, apiKey: '',
      }] }));
      localStorage.setItem('orca-slicer-neo:preferences', JSON.stringify({ profileActivation, version: 1, selectedProfiles: {}, rememberedBedTypes: {}, ui: { switchToDeviceAfterSend: false } }));
    }, { baseUrl, profileActivation: configuredActivation });
    await page.goto('/');
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
    await page.locator('#app-tab-prepare').click();
    await selectFixturePrinter(page, 'Creality Ender-3 0.4 nozzle');
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('btn-add-model').click();
    await (await chooser).setFiles({ name: 'cube"quoted.stl', mimeType: 'application/octet-stream', buffer: await readFile(resolve(here, '../../../packages/slicer-wasm/fixtures/cube.stl')) });
    await page.getByTestId('config-mode-project').click();
    await page.getByTestId('config-page-Other').click();
    await expect(page.getByTestId('config-input-filename_format')).toBeVisible();
    await page.getByTestId('config-input-filename_format').fill('wire"quoted.GCODE');
    await page.getByTestId('config-input-filename_format').press('Enter');
    await expect(page.getByTestId('btn-slice')).toBeEnabled();
    await page.getByTestId('btn-slice').click();
    await expect(page.getByTestId('btn-export')).toBeEnabled({ timeout: 120_000 });
    await page.getByTestId('output-mode-select').click();
    await page.getByRole('option', { name: 'Send & Print', exact: true }).click();
    await page.getByTestId('btn-send-and-print').click();
    await expect(page.getByTestId('send-printer-select')).toBeEnabled();
    await page.getByTestId('send-printer-select').click();
    await page.getByTestId('send-printer-web-fixture').click();
    await page.getByTestId('send-submit').click();
    await expect(page.getByTestId('send-operation-message')).toContainText('print started');
    expect(uploadBody.match(/filename="([^"\r\n]*)"/)?.[1]).toBe('wire%22quoted.GCODE');
    expect(uploadBody).toContain('G1');
    expect(startPath).toBe('nested/server-selected.GCODE');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('real Web G-code export downloads the native generated basename directly', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  if (process.env.ORCA_WEB_NO_ISOLATION === '1') {
    await expect(page.getByTestId('serial-fallback-status')).toBeVisible();
  } else {
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    await expect(page.getByTestId('serial-fallback-status')).toHaveCount(0);
  }
  await page.locator('#app-tab-prepare').click();
  await selectFixturePrinter(page, 'Creality Ender-3 0.4 nozzle');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click();
  await (await chooser).setFiles(resolve(here, '../../../packages/slicer-wasm/fixtures/cube.stl'));
  await expect(page.getByTestId('btn-slice')).toBeEnabled();
  await page.getByTestId('btn-slice').click();
  await expect(page.getByTestId('btn-export')).toBeEnabled({ timeout: 120_000 });
  const downloaded = page.waitForEvent('download');
  await page.getByTestId('btn-export').click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/^cube.*\.gcode$/);
  const path = await download.path();
  expect(path).toBeTruthy();
  expect(await readFile(path!, 'utf8')).toContain('G1');
  await expect(page.getByTestId('btn-export')).toBeEnabled();
});

test('Web project save downloads its suggested filename and establishes a clean named session', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click();
  await (await chooser).setFiles(resolve(here, '../../../packages/slicer-wasm/fixtures/cube.stl'));
  await expect(page.getByTestId('btn-slice')).toBeEnabled();
  await expect(page.getByTestId('titlebar-project-name')).toHaveText('Untitled Project *');
  const download = page.waitForEvent('download');
  await page.keyboard.press('ControlOrMeta+s');
  expect((await download).suggestedFilename()).toBe('Untitled.3mf');
  await expect(page.getByTestId('titlebar-project-name')).toHaveText('Untitled Project');
  await expect(page.getByTestId('project-progress-dialog')).toHaveCount(0);
});

test('real printer bed STL renders and updates with the selected printer', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  const models = () => page.evaluate(() => (window as unknown as {
    __orcaE2e?: { bedModelStates?: () => Array<{ geometry: string; vertices: number; position: number[]; visible: boolean }> };
  }).__orcaE2e?.bedModelStates?.() ?? []);
  async function selectPrinter(name: string) {
    await selectFixturePrinter(page, name);
  }
  await selectPrinter('Bambu Lab P1P 0.4 nozzle');
  await expect.poll(async () => (await models()).length).toBe(1);
  const first = (await models())[0];
  expect(first.vertices).toBeGreaterThan(3);
  expect(first.position[0]).toBeCloseTo(0);
  expect(first.position[1]).toBeCloseTo(0);
  expect(first.position[2]).toBeCloseTo(-0.45);
  await selectPrinter('Bambu Lab A1 mini 0.4 nozzle');
  await expect.poll(async () => (await models())[0]?.geometry).not.toBe(first.geometry);
  await expect.poll(async () => (await models())[0]?.vertices ?? 0).toBeGreaterThan(3);
  expect((await models())[0].position[0]).toBeCloseTo(0);
  expect((await models())[0].position[1]).toBeCloseTo(0);
  await page.screenshot({ path: test.info().outputPath('printer-bed.png') });
  const mini = (await models())[0];
  await clickPlateControl(page, 'add-plate');
  await expect.poll(async () => (await models())[0]?.position).not.toEqual(mini.position);
  expect(await models()).toHaveLength(1);
  expect((await models())[0].geometry).toBe(mini.geometry);
  const grids = () => page.evaluate(() => (window as unknown as {
    __orcaE2e?: { bedGridStates?: () => Array<{ position: number[]; visible: boolean }> };
  }).__orcaE2e?.bedGridStates?.() ?? []);
  await expect.poll(async () => (await grids()).length).toBe(2);
  for (const grid of await grids()) {
    expect(grid.visible).toBe(true);
    expect(grid.position[2]).toBeCloseTo(-0.26);
  }
  // Click the first bed in world coordinates and verify the existing geometry
  // moves back to it rather than leaving another model on the former current bed.
  const point = await page.evaluate(() => (window as unknown as {
    __orcaE2e?: { projectWorldToScreen?: (p: [number, number, number]) => { x: number; y: number } | null };
  }).__orcaE2e?.projectWorldToScreen?.([90, 90, 0]));
  expect(point).toBeTruthy();
  const canvas = await page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]').boundingBox();
  expect(canvas).toBeTruthy();
  await page.mouse.click(canvas!.x + point!.x, canvas!.y + point!.y);
  await expect.poll(async () => (await models())[0]?.position).toEqual(mini.position);
  expect(await models()).toHaveLength(1);
  await page.screenshot({ path: test.info().outputPath('printer-bed-multiple.png') });
  await selectPrinter('Prusa MK4 0.4 nozzle');
  await expect.poll(async () => (await models())[0]?.position[0]).toBeCloseTo(125);
  expect((await models())[0].position[1]).toBeCloseTo(105);
  expect((await models())[0].position[2]).toBeCloseTo(-0.45);
  const artwork = () => page.evaluate(() => (window as unknown as {
    __orcaE2e?: { bedTextureStates?: () => Array<{ path: string; position: number[]; size: number[]; depthWrite: boolean; visible: boolean }> };
  }).__orcaE2e?.bedTextureStates?.() ?? []);
  await expect.poll(async () => (await artwork())[0]?.path).toBe('/system/Prusa/mk4is.svg');
  expect(await artwork()).toHaveLength(1);
  expect((await artwork())[0].position[2]).toBeCloseTo(-0.01);
  expect((await artwork())[0].depthWrite).toBe(false);
  expect(Math.max(...(await artwork())[0].size)).toBe(2048);
  await page.screenshot({ path: test.info().outputPath('printer-bed-artwork.png') });
  const geometry = (await models())[0].geometry;
  async function viewFrom(z: number) {
    await page.evaluate((z) => (window as unknown as {
      __orcaE2e?: { setCameraView?: (position: [number, number, number], target: [number, number, number]) => void };
    }).__orcaE2e?.setCameraView?.([125, -250, z], [125, 105, 0]), z);
  }
  await viewFrom(-300);
  await expect.poll(async () => (await models())[0]?.visible).toBe(false);
  await expect.poll(async () => (await artwork())[0]?.visible).toBe(false);
  expect((await grids()).every((grid) => grid.visible)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('printer-bed-from-below.png') });
  await viewFrom(300);
  await expect.poll(async () => (await models())[0]?.visible).toBe(true);
  await expect.poll(async () => (await artwork())[0]?.visible).toBe(true);
  expect((await models())[0].geometry).toBe(geometry);
});

test('Web Help opens one nonmodal Worker File Manager and reopening it resets to root', async ({ page }) => {
  let releaseManifest!: () => void;
  const manifestGate = new Promise<void>((resolve) => { releaseManifest = resolve; });
  let manifestRequestStarted!: () => void;
  const manifestStarted = new Promise<void>((resolve) => { manifestRequestStarted = resolve; });
  await page.context().route('**/profiles/manifest.json', async (route) => {
    manifestRequestStarted();
    await manifestGate;
    await route.continue();
  });
  const manager = page.getByTestId('file-manager-window');
  const path = page.getByTestId('file-manager-path');
  const openCommand = page.getByTestId('help-file-manager');
  let earlyPath: string | null = null;
  try {
    await page.goto('/');
    await manifestStarted;
    await expect(page.getByTestId('startup-screen')).toBeVisible();
    if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
      await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
      await page.getByTestId('titlebar-menu-trigger').click();
    }
    await page.getByTestId('menu-file-trigger').hover();
    await page.locator('[data-slot=\"menubar-sub-content\"]').hover({ position: { x: 8, y: 8 } });
    await expect(page.getByTestId('file-add-model')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('file-add-model')).toHaveCount(0);
    if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
      await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
      await page.getByTestId('titlebar-menu-trigger').click();
    }
    await page.getByTestId('menu-help-trigger').hover();
    await expect(openCommand).toBeEnabled();
    await expect.poll(() => openCommand.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('auto');
    const hitTestId = await openCommand.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      return document.elementFromPoint(x, y)?.getAttribute('data-testid');
    });
    expect(hitTestId).toBe('help-file-manager');
    await openCommand.click();
    await expect(manager).toBeVisible();
    await expect(manager.locator('thead th')).toHaveText(['Name', 'Size']);
    const earlyDirectory = manager.locator('[data-testid^="file-manager-entry-"][data-entry-type="directory"]').first();
    await expect(earlyDirectory).toBeVisible({ timeout: 30_000 });
    await earlyDirectory.dblclick();
    await expect(path).not.toHaveText('/');
    earlyPath = await path.textContent();
  } finally {
    releaseManifest();
  }
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await expect(path).toHaveText(earlyPath ?? '');
  if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
    await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
    await page.getByTestId('titlebar-menu-trigger').click();
  }
  await page.getByTestId('menu-help-trigger').hover();
  await page.getByTestId('help-file-manager').click();
  await expect(page.getByTestId('file-manager-window')).toHaveCount(1);
  await expect(manager).toBeFocused();
  await expect(path).toHaveText(earlyPath ?? '');
  await manager.getByTestId('file-manager-parent').dblclick();
  await expect(path).toHaveText('/');
  await page.locator('#app-tab-prepare').click();
  await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: 120_000 });

  if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
    await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
    await page.getByTestId('titlebar-menu-trigger').click();
  }

  await page.getByTestId('menu-help-trigger').hover();
  await expect(openCommand).toBeEnabled();
  await openCommand.click();

  await expect(manager).toBeVisible();
  await expect(manager).toHaveAttribute('aria-modal', 'false');
  await expect(path).toHaveText('/');
  await expect(page.getByTestId('file-manager-parent')).toHaveAttribute('aria-disabled', 'true');
  await expect(manager.locator('thead th')).toHaveText(['Name', 'Size']);
  const headerColors = await manager.locator('thead').evaluate((header) => {
    const cell = header.querySelector('th');
    return {
      background: getComputedStyle(header).backgroundColor,
      foreground: cell ? getComputedStyle(cell).color : '',
    };
  });
  expect(headerColors).toEqual({ background: 'rgb(61, 63, 70)', foreground: 'rgb(239, 239, 240)' });

  const infoDirectory = manager.locator('[data-testid^="file-manager-entry-"][data-entry-name="info"][data-entry-type="directory"]');
  await expect(infoDirectory).toBeVisible();
  await infoDirectory.dblclick();
  await expect(path).toHaveText('/info');
  await manager.getByTestId('file-manager-refresh').click();
  await expect(path).toHaveText('/info');
  const nozzleInfo = manager.locator('[data-testid^="file-manager-entry-"][data-entry-name="nozzle_info.json"][data-entry-type="file"]');
  await expect(nozzleInfo).toBeVisible();
  const fileSize = Number((await nozzleInfo.locator('td').nth(1).textContent())?.replace(/ B$/, ''));
  expect(fileSize).toBeGreaterThan(0);
  expect(fileSize).toBeLessThan(1024 * 1024);
  const downloadPromise = page.waitForEvent('download');
  await nozzleInfo.dblclick();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('nozzle_info.json');
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  const downloadedBytes = await readFile(downloadedPath!);
  expect(downloadedBytes.byteLength).toBe(fileSize);
  expect(JSON.parse(downloadedBytes.toString('utf8'))).toEqual(expect.any(Object));
  await expect(nozzleInfo).toHaveAttribute('aria-disabled', 'false');
  await manager.getByTestId('file-manager-parent').dblclick();
  await expect(path).toHaveText('/');

  const directory = page.locator('[data-testid^="file-manager-entry-"][data-entry-type="directory"]').first();
  await expect(directory).toBeVisible();
  await directory.dblclick();
  await expect(path).not.toHaveText('/');
  const visitedPath = await path.textContent();

  if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
    await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
    await page.getByTestId('titlebar-menu-trigger').click();
  }

  await page.getByTestId('menu-help-trigger').hover();
  await page.getByTestId('help-file-manager').click();
  await expect(page.getByTestId('file-manager-window')).toHaveCount(1);
  await expect(manager).toBeFocused();
  await expect(path).toHaveText(visitedPath ?? '');

  const beforeMove = await manager.boundingBox();
  const titlebarBox = await page.getByTestId('file-manager-titlebar').boundingBox();
  expect(beforeMove).not.toBeNull();
  expect(titlebarBox).not.toBeNull();
  await page.mouse.move(titlebarBox!.x + 100, titlebarBox!.y + 18);
  await page.mouse.down();
  await page.mouse.move(titlebarBox!.x + 140, titlebarBox!.y + 48);
  await page.mouse.up();
  const afterMove = await manager.boundingBox();
  expect(afterMove!.x).toBeGreaterThan(beforeMove!.x);

  const beforeResize = await manager.boundingBox();
  await page.getByTestId('file-manager-resize').hover();
  await page.mouse.move(beforeResize!.x + beforeResize!.width - 8, beforeResize!.y + beforeResize!.height - 8);
  await page.mouse.down();
  await page.mouse.move(beforeResize!.x + beforeResize!.width + 60, beforeResize!.y + beforeResize!.height + 60);
  await page.mouse.up();
  const afterResize = await manager.boundingBox();
  const viewport = page.viewportSize()!;
  expect(afterResize!.width).toBeGreaterThan(beforeResize!.width);
  expect(afterResize!.x + afterResize!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(afterResize!.y + afterResize!.height).toBeLessThanOrEqual(viewport.height + 1);

  await page.getByTestId('file-manager-close').click();
  await expect(manager).toHaveCount(0);
  if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
    await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
    await page.getByTestId('titlebar-menu-trigger').click();
  }
  await page.getByTestId('menu-help-trigger').hover();
  await page.getByTestId('help-file-manager').click();
  await expect(page.getByTestId('file-manager-path')).toHaveText('/');
});

test('Web Help keeps File Manager available after profile startup fails', async ({ page }) => {
  let failManifest!: () => void;
  const manifestGate = new Promise<void>((resolve) => { failManifest = resolve; });
  let manifestRequestStarted!: () => void;
  const manifestStarted = new Promise<void>((resolve) => { manifestRequestStarted = resolve; });
  await page.context().route('**/profiles/manifest.json', async (route) => {
    manifestRequestStarted();
    await manifestGate;
    await route.abort();
  });

  const manager = page.getByTestId('file-manager-window');
  const openCommand = page.getByTestId('help-file-manager');
  try {
    await page.goto('/');
    await manifestStarted;
    await expect(page.getByTestId('startup-screen')).toBeVisible();
    if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
      await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
      await page.getByTestId('titlebar-menu-trigger').click();
    }
    await page.getByTestId('menu-file-trigger').hover();
    await page.locator('[data-slot=\"menubar-sub-content\"]').hover({ position: { x: 8, y: 8 } });
    await expect(page.getByTestId('file-add-model')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('file-add-model')).toHaveCount(0);
    if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
      await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
      await page.getByTestId('titlebar-menu-trigger').click();
    }
    await page.getByTestId('menu-help-trigger').hover();
    await expect(openCommand).toBeEnabled();
    await expect.poll(() => openCommand.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('auto');
    await openCommand.click();
    await expect(manager).toBeVisible();
    await expect(manager.locator('thead th')).toHaveText(['Name', 'Size']);
    await expect(manager.locator('[data-testid^="file-manager-entry-"][data-entry-type="directory"]').first()).toBeVisible({ timeout: 30_000 });
  } finally {
    failManifest();
  }

  await expect(page.getByTestId('startup-error')).toBeVisible({ timeout: 30_000 });
  await expect(manager).toBeVisible();
  await page.getByTestId('file-manager-close').click();
  if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
    await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
    await page.getByTestId('titlebar-menu-trigger').click();
  }
  await page.getByTestId('menu-help-trigger').hover();
  await expect(openCommand).toBeEnabled();
  await openCommand.click();
  await expect(manager).toBeVisible();
  await expect(page.getByTestId('startup-error')).toBeVisible();
  await manager.getByTestId('file-manager-refresh').click();
  await expect(manager.getByTestId('file-manager-error')).toHaveCount(0);
});

test('Web memory indicator shows a JS-heap plus WASM estimate with shared details', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  const indicator = page.getByTestId('memory-indicator');
  await expect(indicator).toHaveText(/^Memory: \d/, { timeout: 30_000 });
  await indicator.click();
  const popup = page.getByTestId('memory-indicator-popup');
  await expect(popup).toContainText('Total memory estimate');
  await expect(popup).toContainText('Shared runtime diagnostics');
  await expect(popup).toContainText('Renderer JS heap');
  await expect(popup).toContainText('WASM linear-memory capacity');
});

// This suite intentionally has no mock mode. The staging step must have
// published both real wasm64 variants before either invocation is run.
test('real Web flow: import DRC → profile → slice → layer → G-code download', async ({ page }) => {
  await page.addInitScript((profileActivation) => {
    const opened: string[] = [];
    (window as unknown as { __orcaOpenedSources: string[] }).__orcaOpenedSources = opened;
    window.open = ((url?: string | URL) => {
      if (url !== undefined) opened.push(String(url));
      return null;
    }) as typeof window.open;
    localStorage.setItem('orca-slicer-neo:preferences', JSON.stringify({ profileActivation,
      version: 1,
      projectLoadBehaviour: 'always_ask',
      selectedProfiles: {},
      ui: {},
    }));
  }, configuredActivation);
  page.on('console', (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (error) => console.log(`[browser:error] ${String(error)}`));
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await expect(page.locator('#app-panel-home')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.getByTestId('home-page')).toBeAttached();
  await expect(page.locator('#app-panel-workspace')).toHaveAttribute('aria-hidden', 'true');
  await page.locator('#app-tab-prepare').click();
  if (process.env.ORCA_WEB_NO_ISOLATION === '1') {
    await expect(page.getByTestId('serial-fallback-status')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('serial-fallback-status')).toContainText('serial wasm64 fallback');
  } else {
    await expect(page.getByTestId('serial-fallback-status')).toHaveCount(0);
  }
  await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready');
  // A file drop over the nested object list must reach the shared Open
  // Project action even though that target stops propagation for text drags.
  const urlBeforeDrop = page.url();
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([80, 75, 3, 4])], 'dropped.3mf'));
    const target = document.querySelector('[data-testid="object-list"]') ?? document;
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.getByTestId('project-load-choice-dialog')).toBeVisible();
  expect(page.url()).toBe(urlBeforeDrop);
  await page.getByTestId('project-load-cancel').click();
  await expect(page.getByTestId('project-load-choice-dialog')).toBeHidden();
  await expect(page.getByTestId('titlebar-menu')).toBeVisible();
  await expect(page.getByTestId('titlebar-menu-trigger')).toBeVisible();
  if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
    await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
    await page.getByTestId('titlebar-menu-trigger').click();
  }
  await page.getByTestId('menu-file-trigger').hover();
  await page.locator('[data-slot=\"menubar-sub-content\"]').hover({ position: { x: 8, y: 8 } });
  await expect(page.getByTestId('file-add-model')).toBeEnabled();
  await expect(page.getByTestId('file-clear-scene')).toBeDisabled();
  await expect(page.getByTestId('file-slice')).toBeDisabled();
  await expect(page.getByTestId('file-export-gcode')).toBeDisabled();
  await expect(page.getByTestId('file-quit')).toHaveCount(0);
  if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
    await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
    await page.getByTestId('titlebar-menu-trigger').click();
  }
  await page.getByTestId('menu-help-trigger').hover();
  // Activate the visible menu item programmatically. In headless Chrome the
  // popup's visual layer can be geometrically overlapped by the tab strip.
  await page.getByTestId('help-source').evaluate((element) => (element as HTMLElement).click());
  await expect.poll(() => page.evaluate(() => (window as unknown as { __orcaOpenedSources?: string[] }).__orcaOpenedSources ?? [])).toEqual([
    'https://github.com/Noisyfox/OrcaSlicerNeo',
  ]);
  expect(page.url()).toContain('127.0.0.1:4173');
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(false);

  await selectFixturePrinter(page, 'Creality Ender-3 0.4 nozzle');

  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click();
  await (await chooser).setFiles(resolve(
    here,
    '../../../packages/slicer-wasm/fixtures/drc/test_nm.obj.edgebreaker.cl4.2.2.drc',
  ));
  await expect(page.getByTestId('btn-slice')).toBeEnabled();
  if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
    await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
    await page.getByTestId('titlebar-menu-trigger').click();
  }
  await page.getByTestId('menu-file-trigger').hover();
  await page.locator('[data-slot=\"menubar-sub-content\"]').hover({ position: { x: 8, y: 8 } });
  await expect(page.getByTestId('file-clear-scene')).toBeEnabled();
  await expect(page.getByTestId('file-slice')).toBeEnabled();
  await expect(page.getByTestId('file-export-gcode')).toBeDisabled();
  if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
    await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
    await page.getByTestId('titlebar-menu-trigger').click();
  }
  await page.getByTestId('menu-file-trigger').hover();
  await page.locator('[data-slot=\"menubar-sub-content\"]').hover({ position: { x: 8, y: 8 } });
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
  const layerHeight = page.locator('#layer_height');
  if (await layerHeight.count()) await layerHeight.fill('0.21');
  await page.getByTestId('btn-slice').click();
  await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 120_000 });
  // The native SegmentTemplate renderer is the sole preview backend. A
  // capability/context failure is surfaced as an explicit diagnostic.
  await expect.poll(() => page.evaluate(() => {
    const hooks = (window as unknown as {
      __orcaE2e?: {
        gpuStreamingStatus?: () => string;
        gpuStreamingDiagnostic?: () => { reason?: string } | null;
      };
    }).__orcaE2e;
    const status = hooks?.gpuStreamingStatus?.();
    return status === 'ready' || (status === 'unavailable' && Boolean(hooks?.gpuStreamingDiagnostic?.()?.reason));
  }), { timeout: 20_000 }).toBe(true);
  await page.setViewportSize({ width: 720, height: 520 });
  if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
    await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
    await page.getByTestId('titlebar-menu-trigger').click();
  }
  await page.getByTestId('menu-file-trigger').hover();
  await page.locator('[data-slot=\"menubar-sub-content\"]').hover({ position: { x: 8, y: 8 } });
  await expect(page.getByTestId('file-export-gcode')).toBeEnabled();
  // Leave both the submenu and hamburger before interacting with Preview.
  // Its modal backdrop otherwise correctly intercepts the later tab click.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('titlebar-menu-trigger')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('viewport')).toBeVisible();
  const scrubber = page.getByTestId('layer-scrubber');
  await expect(scrubber).toBeAttached({ timeout: 30_000 });
  await scrubber.scrollIntoViewIfNeeded();
  // The layer control has two thumbs; target the end thumb by its stable
  // semantic test id instead of relying on an ambiguous descendant locator.
  const range = scrubber.getByTestId('layer-scrubber-end').locator('input[type="range"]');
  await expect(range).toBeAttached();
  const before = await range.inputValue();
  await range.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = input.max === '0' ? '0' : '1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(await range.inputValue()).not.toBe(before);

  // Phase-B Orca-style overlay contract: feature legend uses hide/show
  // semantics, travel is a global toggle, layer/move controls are present,
  // and the camera-facing marker is in the scene at the inspection position.
  await page.locator('#app-tab-preview').click();
  await expect(page.getByTestId('preview-controls')).toBeVisible({ timeout: 30_000 });
  const feature = page.locator('[data-testid^="preview-feature-visibility-"]').first();
  await expect(feature).toHaveAttribute('aria-pressed', 'true');
  await feature.click();
  await expect(feature).toHaveAttribute('aria-pressed', 'false');
  await feature.click();
  await expect(feature).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('preview-travel-toggle').click();
  await expect(page.getByTestId('preview-travel-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('preview-travel-toggle').click();
  await expect(page.getByTestId('preview-travel-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('preview-layer-range')).toBeVisible();
  await expect(page.getByTestId('preview-move-range')).toBeVisible();
  const overlayGeometry = await page.evaluate(() => {
    const controls = document.querySelector('[data-testid="preview-controls"]')?.getBoundingClientRect();
    const layer = document.querySelector('[data-testid="preview-layer-range"]')?.getBoundingClientRect();
    if (!controls || !layer) return null;
    return {
      intersects: controls.left < layer.right && controls.right > layer.left
        && controls.top < layer.bottom && controls.bottom > layer.top,
    };
  });
  expect(overlayGeometry).not.toBeNull();
  expect(overlayGeometry?.intersects).toBe(false);
  const moveInputs = page.getByTestId('preview-move-range').locator('input[type="range"]');
  await expect(moveInputs).toHaveCount(1);
  await expect(page.getByTestId('preview-move-range').locator('[role="group"]')).toHaveAttribute('aria-label', 'Active layer move end');
  const moveInput = moveInputs.first();
  await moveInput.focus();
  await page.keyboard.press('Home');
  await expect(moveInput).toHaveValue('0');
  const layerInputs = page.getByTestId('preview-layer-range').locator('input[type="range"]');
  await expect(layerInputs).toHaveCount(2);
  const layerStartInput = page.getByTestId('layer-scrubber-start').locator('input[type="range"]');
  const layerEndInput = page.getByTestId('layer-scrubber-end').locator('input[type="range"]');
  await expect(layerStartInput).toBeAttached();
  await expect(layerEndInput).toBeAttached();
  await layerEndInput.focus();
  await page.keyboard.press('Home');
  await expect(layerEndInput).toHaveValue('0');

  // Single-layer inspection keeps the vertical control dual-thumb. Starting
  // from a multi-layer range, both thumbs collapse to the active layer and
  // either thumb can then move that layer without reversing the range.
  const singleLayerToggle = page.getByTestId('preview-single-layer');
  await singleLayerToggle.click();
  await expect(singleLayerToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(layerStartInput).toHaveValue(await layerEndInput.inputValue());
  await layerStartInput.focus();
  await page.keyboard.press('Home');
  await expect(layerStartInput).toHaveValue('0');
  await expect(layerEndInput).toHaveValue('0');
  await layerEndInput.focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => layerStartInput.inputValue()).toBe('1');
  await expect(layerEndInput).toHaveValue('1');
  await expect(singleLayerToggle).toHaveAttribute('aria-pressed', 'true');
  await singleLayerToggle.click();
  await expect(singleLayerToggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => Number(await layerInputs.nth(0).inputValue()) <= Number(await layerInputs.nth(1).inputValue())).toBe(true);

  const currentLayer = await layerEndInput.inputValue();
  await layerEndInput.focus();
  await page.keyboard.press('Home');
  await expect.poll(() => layerEndInput.inputValue()).not.toBe(currentLayer);
  await expect.poll(() => moveInput.inputValue()).toBe(await moveInput.getAttribute('max'));
  await expect.poll(() => page.evaluate(() => (window as unknown as { __orcaE2e?: { previewMarkerPresent?: () => boolean } }).__orcaE2e?.previewMarkerPresent?.() ?? false)).toBe(true);
  const themeToken = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-card').trim());
  expect(themeToken).not.toBe('');
  await page.evaluate(() => document.documentElement.classList.toggle('dark'));
  await expect(page.getByTestId('preview-controls')).toBeVisible();

  // A settings override invalidates the old toolpath and therefore export.
  if (await layerHeight.count()) {
    await layerHeight.fill('0.2');
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready');
    await expect(page.getByTestId('btn-export')).toHaveCount(0);
    // The invalidated G-code preview is cleared as well: the toolpath leaves
    // the scene and the scrubber unmounts with it (spec §8).
    await expect(scrubber).toBeAttached({ attached: false });
    await page.getByTestId('btn-slice').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 120_000 });
    await expect(scrubber).toBeAttached({ timeout: 30_000 });
  }

  const download = page.waitForEvent('download');
  await page.getByTestId('btn-export').click();
  const result = await download;
  expect(result.suggestedFilename()).toMatch(/\.gcode$/);
  expect(await result.path()).toBeTruthy();
});

test('shared history toolbar keeps shortcuts and direct navigation host-neutral', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: 120_000 });

  await selectFixturePrinter(page, 'Creality Ender-3 0.4 nozzle');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click();
  await (await chooser).setFiles(resolve(here, '../../../packages/slicer-wasm/fixtures/drc/test_nm.obj.edgebreaker.cl4.2.2.drc'));
  await expect(page.getByTestId('history-undo')).toHaveAttribute('aria-label', /^Undo Add /, { timeout: 120_000 });
  await expect(page.getByTestId('history-undo')).toBeEnabled({ timeout: 120_000 });

  // Switching away only gates navigation. It neither consumes the shortcut
  // nor loses the Worker-owned entry when Prepare is revisited.
  await page.locator('#app-tab-preview').click();
  await expect(page.getByTestId('history-undo')).toBeDisabled();
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('history-undo')).toBeDisabled();
  await page.locator('#app-tab-prepare').click();
  await expect(page.getByTestId('history-undo')).toBeEnabled({ timeout: 120_000 });

  const layerHeight = page.locator('#layer_height');
  if (await layerHeight.count()) {
    const before = await layerHeight.inputValue();
    await layerHeight.fill('0.21');
    await layerHeight.press('Control+z');
    await expect(layerHeight).toHaveValue(before);
  }
  // Undo the model import and then the preceding atomic Printer selection.
  // Wait for committed entry labels rather than a transient disabled state.
  await page.getByTestId('history-undo').focus();
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('history-undo')).toHaveAttribute('aria-label', 'Undo Select Printer', { timeout: 30_000 });
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('history-undo')).toBeDisabled({ timeout: 30_000 });

  // Reloading gives the real Web host a clean Worker session for the direct
  // menu route while keeping this test independent of frontend history state.
  await page.reload();
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: 120_000 });
  await selectFixturePrinter(page, 'Creality Ender-3 0.4 nozzle');
  const reloadedChooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click();
  await (await reloadedChooser).setFiles(resolve(here, '../../../packages/slicer-wasm/fixtures/drc/test_nm.obj.edgebreaker.cl4.2.2.drc'));
  await expect(page.getByTestId('history-undo')).toHaveAttribute('aria-label', /^Undo Add /, { timeout: 120_000 });
  await expect(page.getByTestId('history-undo')).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId('history-undo').click({ button: 'right' });
  await expect(page.getByTestId(/history-undo-entry-/).first()).toBeVisible();
  await page.getByTestId(/history-undo-entry-/).first().click();
  await expect(page.getByTestId('history-undo')).toHaveAttribute('aria-label', 'Undo Select Printer', { timeout: 30_000 });
  await page.getByTestId('history-undo').click({ button: 'right' });
  await page.getByTestId(/history-undo-entry-/).first().click();
  await expect(page.getByTestId('history-undo')).toBeDisabled({ timeout: 30_000 });
});

test('multi-plate Prepare grid interactions use authoritative plates and preserve camera', async ({ page }) => {
  await page.addInitScript((profileActivation) => {
    localStorage.setItem('orca-slicer-neo:preferences', JSON.stringify({ profileActivation,
      version: 1,
      projectLoadBehaviour: 'always_ask',
      selectedProfiles: {},
      ui: {},
    }));
  }, configuredActivation);
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  await page.getByTestId('config-mode-plates').click();
  await expect(page.getByTestId('plate-controls')).toBeVisible({ timeout: 120_000 });

  await expect(page.getByTestId('delete-plate')).toBeDisabled();
  const readBeds = () => page.evaluate(() =>
    (window as unknown as {
      __orcaE2e?: {
        bedPlateStates?: () => Array<{
          plateId?: string;
          current: boolean;
          outOfBounds: boolean;
          position: [number, number, number];
        }>;
      };
    }).__orcaE2e?.bedPlateStates?.() ?? [],
  );
  const readModels = () => page.evaluate(() =>
    (window as unknown as { __orcaE2e?: { modelWorldCenters?: () => Array<[number, number, number]> } })
      .__orcaE2e?.modelWorldCenters?.() ?? [],
  );
  const readCamera = () => page.evaluate(() => {
    const value = (window as unknown as { __orcaE2e?: { cameraState?: () => { position: number[]; target: number[] } } }).__orcaE2e?.cameraState?.();
    if (!value) return undefined;
    const round = (n: number) => Math.round(n * 100) / 100;
    return { position: value.position.map(round), target: value.target.map(round) };
  });
  const clickWorld = async (point: [number, number, number]) => {
    const projected = await page.evaluate((p) =>
      (window as unknown as { __orcaE2e?: { projectWorldToScreen?: (q: [number, number, number]) => { x: number; y: number } | null } })
        .__orcaE2e?.projectWorldToScreen?.(p) ?? null,
      point,
    );
    expect(projected).not.toBeNull();
    const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
    const box = await canvas.boundingBox();
    if (!box || !projected) throw new Error('viewport projection is unavailable');
    await page.mouse.click(box.x + projected.x, box.y + projected.y);
  };
  const clickBed = async (index: number) => {
    const beds = await readBeds();
    const bed = beds[index];
    if (!bed) throw new Error(`missing bed ${index}`);
    await clickWorld([bed.position[0] + 200, bed.position[1] + 200, bed.position[2]]);
  };

  await page.locator('#app-tab-preview').click();
  await expect.poll(readBeds).toHaveLength(1);
  await page.locator('#app-tab-prepare').click();
  await page.getByTestId('config-mode-plates').click();
  await expect(page.getByTestId('plate-controls')).toBeVisible();
  await expect.poll(readBeds).toHaveLength(1);

  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click();
  await (await chooser).setFiles(resolve(here, '../../../packages/slicer-wasm/fixtures/cube.stl'));
  await expect(page.getByTestId('btn-slice')).toBeEnabled();
  await expect.poll(readModels).not.toHaveLength(0);

  await expect.poll(readCamera).not.toBeUndefined();
  const cameraBefore = await readCamera();
  await clickPlateControl(page, 'add-plate');
  await expectCurrentPlate(page, 'Plate 2', 2);
  await expect.poll(readCamera).toEqual(cameraBefore);

  // Preview deliberately keeps only the selected authoritative bed after
  // Prepare has added another plate. Switching back restores the full
  // Prepare grid and its current-plate context.
  await page.locator('#app-tab-preview').click();
  await expect.poll(readBeds).toHaveLength(1);
  await page.locator('#app-tab-prepare').click();
  await page.getByTestId('config-mode-plates').click();
  await expect(page.getByTestId('plate-controls')).toBeVisible();
  await expect.poll(readBeds).toHaveLength(2);

  await clickBed(0);
  await expectCurrentPlate(page, 'Plate 1', 2);
  await clickBed(1);
  await expectCurrentPlate(page, 'Plate 2', 2);
  const modelCenter = (await readModels())[0];
  if (!modelCenter) throw new Error('model center is unavailable');
  await clickWorld(modelCenter);
  await expectCurrentPlate(page, 'Plate 2', 2);

  await clickPlateControl(page, 'add-plate');
  await expectCurrentPlate(page, 'Plate 3', 3);
  const bedsBeforeReflow = await readBeds();
  const plate3Before = bedsBeforeReflow[2];
  if (!plate3Before?.plateId) throw new Error('third plate identity is unavailable');
  const secondChooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click();
  await (await secondChooser).setFiles(resolve(here, '../../../packages/slicer-wasm/fixtures/cube.stl'));
  await expect.poll(readModels).toHaveLength(2);
  const modelsBeforeReflow = await readModels();
  await clickBed(1);
  await expectCurrentPlate(page, 'Plate 2', 3);
  await clickPlateControl(page, 'delete-plate');
  await expect.poll(readBeds).toHaveLength(2);
  const bedsAfterReflow = await readBeds();
  const plate3After = bedsAfterReflow.find((bed) => bed.plateId === plate3Before.plateId);
  if (!plate3After) throw new Error('reflowed third plate identity is unavailable');
  expect(bedsAfterReflow.find((bed) => bed.current)?.plateId).toBe(plate3Before.plateId);
  await expectCurrentPlate(page, 'Plate 3', 2);
  const modelsAfterReflow = await readModels();
  expect(modelsAfterReflow).toHaveLength(modelsBeforeReflow.length);
  expect(modelsAfterReflow[1][0] - modelsBeforeReflow[1][0])
    .toBeCloseTo(plate3After.position[0] - plate3Before.position[0], 4);
  expect(modelsAfterReflow[1][1] - modelsBeforeReflow[1][1])
    .toBeCloseTo(plate3After.position[1] - plate3Before.position[1], 4);
  await expect.poll(readCamera).toEqual(cameraBefore);

  for (let count = 3; count <= 36; count += 1) {
    await clickPlateControl(page, 'add-plate');
    await expectCurrentPlate(page, `Plate ${count}`, count);
  }
  await expectCurrentPlate(page, 'Plate 36', 36);
  await page.getByTestId('config-mode-plates').click();
  await expect(page.getByTestId('add-plate')).toBeDisabled();
});

test('multi-plate Preview renders only the current plate in world coordinates', async ({ page }) => {
  // This scenario intentionally performs two real native slices so both
  // retained cores can be revisited. Each phase has its own timeout; the test
  // timeout remains only a final runaway guard.
  test.setTimeout(15 * 60_000);
  const timeline: Array<{ phase: string; elapsedMs: number }> = [];
  let currentPhase = 'initialization';
  const failureDiagnostics = async () => page.evaluate(() => ({
    readyState: document.readyState,
    status: document.querySelector('[data-testid="slicer-status"]')?.textContent ?? null,
    error: document.querySelector('[data-testid="slicer-error"]')?.textContent ?? null,
    projection: document.querySelector('[data-testid="viewport"]')?.getAttribute('data-preview-projection-state') ?? null,
    previewMessage: document.querySelector('[role="status"]')?.textContent ?? null,
    plates: [...document.querySelectorAll('[data-testid^="preview-plate-"]')].map((element) => ({
      testId: element.getAttribute('data-testid'),
      selected: element.getAttribute('aria-selected'),
      status: element.getAttribute('data-plate-status'),
    })),
    worker: (window as unknown as { __previewWorkerDiagnostics?: unknown }).__previewWorkerDiagnostics ?? null,
  }));
  const boundedFailureDiagnostics = () => Promise.race([
    failureDiagnostics(),
    new Promise<{ diagnosticError: string }>((resolveDiagnostic) => setTimeout(
      () => resolveDiagnostic({ diagnosticError: 'diagnostic snapshot timed out after 5s' }), 5_000,
    )),
  ]);
  const phaseStep = async <T,>(phase: string, timeout: number, action: () => Promise<T>): Promise<T> => {
    currentPhase = phase;
    const startedAt = Date.now();
    try {
      const result = await test.step(phase, action, { timeout });
      const elapsedMs = Date.now() - startedAt;
      timeline.push({ phase, elapsedMs });
      console.log(`[multi-preview timing] ${phase}: ${elapsedMs} ms`);
      return result;
    } catch (cause) {
      const diagnostics = page.isClosed() ? { pageClosed: true } : await boundedFailureDiagnostics().catch((error) => ({
        diagnosticError: String(error),
      }));
      const detail = cause instanceof Error ? cause.stack ?? cause.message : String(cause);
      throw new Error(`${phase} failed\n${JSON.stringify({ currentPhase, timeline, ...diagnostics }, null, 2)}\n${detail}`);
    }
  };
  const markBrowserMilestone = (label: string) => page.evaluate((milestone) => {
    const diagnosticWindow = window as unknown as { __previewWorkerDiagnostics?: {
      paints?: Array<{ label: string; atMs: number }>;
    } };
    diagnosticWindow.__previewWorkerDiagnostics?.paints?.push({ label: milestone, atMs: performance.now() });
  }, label);
  const waitForSliceTerminal = async (plate: string) => phaseStep(`${plate}: native slice terminal`, 180_000, async () => {
    await expect(page.getByTestId('slicer-status')).toHaveText(/Slicing…|Sliced|Error/);
    await expect(page.getByTestId('slicer-status')).toHaveText(/Sliced|Error/, { timeout: 170_000 });
    // Query the optional error node without a locator wait. `textContent()` on
    // an absent locator waits until the enclosing phase timeout before its
    // rejection reaches `.catch()`, which looked like a post-slice UI hang.
    const { status, error } = await page.evaluate(() => ({
      status: document.querySelector('[data-testid="slicer-status"]')?.textContent ?? null,
      error: document.querySelector('[data-testid="slicer-error"]')?.textContent ?? null,
    }));
    expect(status, error ?? undefined).toBe('Sliced');
    await markBrowserMilestone(`${plate}: slice status painted`);
  });
  const waitForInteractionReady = async (plate: string) => phaseStep(`${plate}: React paint and interaction ready`, 60_000, async () => {
    const probeStartedAt = Date.now();
    const paint = await page.evaluate((label) => new Promise<{ atMs: number; frameDelayMs: number }>((resolve) => {
      const startedAt = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const atMs = performance.now();
        const diagnosticWindow = window as unknown as { __previewWorkerDiagnostics?: {
          paints?: Array<{ label: string; atMs: number }>;
        } };
        diagnosticWindow.__previewWorkerDiagnostics?.paints?.push({ label, atMs });
        resolve({ atMs, frameDelayMs: atMs - startedAt });
      }));
    }), `${plate}: interaction ready`);
    console.log(`[multi-preview timing] ${plate}: double-rAF ${paint.frameDelayMs.toFixed(1)} ms, Playwright round trip ${Date.now() - probeStartedAt} ms`);
  });
  await page.addInitScript((profileActivation) => {
    localStorage.setItem('orca-slicer-neo:preferences', JSON.stringify({ profileActivation,
      version: 1,
      projectLoadBehaviour: 'always_ask',
      selectedProfiles: {},
      ui: {},
    }));
    const diagnostics = {
      events: [] as Array<Record<string, unknown>>,
      lastReceipt: null as unknown,
      paints: [] as Array<{ label: string; atMs: number }>,
    };
    (window as unknown as { __previewWorkerDiagnostics: typeof diagnostics }).__previewWorkerDiagnostics = diagnostics;
    const NativeWorker = window.Worker;
    const requests = new Map<number, string>();
    window.Worker = class DiagnosticWorker extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        this.addEventListener('message', (event: MessageEvent<unknown>) => {
          const message = event.data as { type?: unknown; id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
          if (message?.type !== 'response' || typeof message.id !== 'number') return;
          const operation = requests.get(message.id) ?? 'unknown';
          const result = message.result as {
            ok?: unknown; status?: unknown; receipt?: unknown; objects?: unknown; layers?: unknown; error?: unknown;
            toolpath?: { segmentCount?: unknown };
          } | undefined;
          if (result?.receipt) diagnostics.lastReceipt = result.receipt;
          const buffers = new Set<ArrayBufferLike>();
          const visited = new WeakSet<object>();
          const collectBufferBytes = (value: unknown): void => {
            if (!value || typeof value !== 'object') return;
            if (ArrayBuffer.isView(value)) {
              buffers.add(value.buffer);
              return;
            }
            if (value instanceof ArrayBuffer) {
              buffers.add(value);
              return;
            }
            if (visited.has(value)) return;
            visited.add(value);
            for (const nested of Object.values(value)) collectBufferBytes(nested);
          };
          collectBufferBytes(result);
          diagnostics.events.push({ direction: 'response', atMs: performance.now(), id: message.id, operation, ok: message.ok,
            result: result ? { ok: result.ok, status: result.status, receipt: result.receipt,
              objects: result.objects, layers: result.layers, error: result.error,
              segmentCount: result.toolpath?.segmentCount,
              transferBytes: [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0) } : undefined,
            error: message.error });
          if (diagnostics.events.length > 64) diagnostics.events.shift();
        });
      }

      postMessage(message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions): void {
        const request = message as { type?: unknown; id?: unknown; op?: unknown };
        if (request?.type === 'request' && typeof request.id === 'number' && typeof request.op === 'string') {
          requests.set(request.id, request.op);
          diagnostics.events.push({ direction: 'request', atMs: performance.now(), id: request.id, operation: request.op });
          if (diagnostics.events.length > 64) diagnostics.events.shift();
        }
        if (transferOrOptions === undefined) super.postMessage(message);
        else if (Array.isArray(transferOrOptions)) super.postMessage(message, transferOrOptions);
        else super.postMessage(message, transferOrOptions);
      }
    };
  }, configuredActivation);
  await phaseStep('runtime bootstrap', 180_000, async () => {
    await page.goto('/');
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 170_000 });
  });
  await phaseStep('enter Prepare', 60_000, async () => {
    await page.locator('#app-tab-prepare').click({ timeout: 30_000 });
    await page.getByTestId('config-mode-plates').click();
    await expect(page.getByTestId('plate-controls')).toBeVisible({ timeout: 30_000 });
  });

  await phaseStep('plate 1: model load and plate 2 creation', 180_000, async () => {
    const chooser = page.waitForEvent('filechooser', { timeout: 30_000 });
    await page.getByTestId('btn-add-model').click({ timeout: 30_000 });
    await (await chooser).setFiles(resolve(here, '../../../packages/slicer-wasm/fixtures/cube.stl'));
    await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 120_000 });
    await clickPlateControl(page, 'add-plate', { timeout: 30_000 });
    await expectCurrentPlate(page, 'Plate 2', 2, { timeout: 30_000 });
  });
  const beds = await page.evaluate(() => (window as unknown as {
    __orcaE2e?: { bedPlateStates?: () => Array<{ plateId?: string; current: boolean; position: [number, number, number]; bounds: { minX: number; maxX: number; minY: number; maxY: number } }> };
  }).__orcaE2e?.bedPlateStates?.() ?? []);
  const plate1 = beds.find((bed) => !bed.current);
  const plate2 = beds.find((bed) => bed.current);
  if (!plate1?.plateId || !plate2?.plateId) throw new Error('multi-plate identities are unavailable');

  await phaseStep('plate 2: model load and slice dispatch', 180_000, async () => {
    const secondChooser = page.waitForEvent('filechooser', { timeout: 30_000 });
    await page.getByTestId('btn-add-model').click({ timeout: 30_000 });
    await (await secondChooser).setFiles(resolve(here, '../../../packages/slicer-wasm/fixtures/cube.stl'));
    await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 120_000 });
    await page.getByTestId('btn-slice').click({ timeout: 30_000 });
    // Slice owns Preview navigation. Waiting for the selected tab is the
    // observable terminal; clicking the already-selected tab again obscured
    // whether the renderer was merely busy finishing its first paint.
    await expect(page.locator('#app-tab-preview')).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
    await expect(page.getByTestId('preview-controls')).toBeVisible({ timeout: 30_000 });
  });
  await waitForSliceTerminal('plate 2');
  const readBeds = () => page.evaluate(() => (window as unknown as {
    __orcaE2e?: { bedPlateStates?: () => Array<{ plateId?: string; current: boolean; position: [number, number, number]; bounds: { minX: number; maxX: number; minY: number; maxY: number } }> };
  }).__orcaE2e?.bedPlateStates?.() ?? []);
  const readModels = () => page.evaluate(() => (window as unknown as {
    __orcaE2e?: { modelWorldCenters?: () => Array<[number, number, number]> };
  }).__orcaE2e?.modelWorldCenters?.() ?? []);
  const readToolpathBounds = () => page.evaluate(() => (window as unknown as {
    __orcaE2e?: { previewToolpathWorldBounds?: () => { min: [number, number, number]; max: [number, number, number] } | null };
  }).__orcaE2e?.previewToolpathWorldBounds?.() ?? null);
  const readCameraTarget = () => page.evaluate(() => (window as unknown as {
    __orcaE2e?: { cameraState?: () => { target: [number, number, number] } };
  }).__orcaE2e?.cameraState?.().target ?? null);

  await phaseStep('plate 2: renderer projection terminal', 180_000, async () => {
    await expect(page.getByTestId('viewport')).toHaveAttribute(
      'data-preview-projection-state', /ready|failed/, { timeout: 120_000 },
    );
    await expect(page.getByTestId('viewport')).toHaveAttribute('data-preview-projection-state', 'ready');
    await markBrowserMilestone('plate 2: projection DOM ready');
    await expect.poll(readBeds, { timeout: 30_000 }).toEqual([
      expect.objectContaining({ plateId: plate2.plateId, current: true }),
    ]);
    await expect.poll(readModels, { timeout: 30_000 }).toHaveLength(1);
    await expect.poll(readToolpathBounds, { timeout: 30_000 }).not.toBeNull();
  });
  await waitForInteractionReady('plate 2');
  const plate2Bounds = await readToolpathBounds();
  if (!plate2Bounds) throw new Error('plate 2 preview bounds are unavailable');
  const bed2 = beds.find((bed) => bed.plateId === plate2.plateId)!;
  expect(plate2Bounds.min[0]).toBeGreaterThanOrEqual(plate2.position[0] + bed2.bounds.minX - 0.5);
  expect(plate2Bounds.max[0]).toBeLessThanOrEqual(plate2.position[0] + bed2.bounds.maxX + 0.5);
  expect(plate2Bounds.min[1]).toBeGreaterThanOrEqual(plate2.position[1] + bed2.bounds.minY - 0.5);
  expect(plate2Bounds.max[1]).toBeLessThanOrEqual(plate2.position[1] + bed2.bounds.maxY + 0.5);
  expect(plate2Bounds.max[0]).toBeGreaterThan(plate2Bounds.min[0]);
  expect(plate2Bounds.max[1]).toBeGreaterThan(plate2Bounds.min[1]);
  expect(plate2Bounds.min[0]).toBeGreaterThan(plate1.position[0] + bed2.bounds.maxX + 0.5);

  // Preview exposes the same authoritative plate selection transaction in its
  // left sidebar. The first plate is valid but unsliced, so selecting it must
  // release plate 2's renderer projection and show the explicit empty state.
  await page.getByTestId('config-mode-plates').click();
  const plateList = page.getByTestId('preview-plate-list');
  await expect(plateList).toBeVisible();
  const plate1Option = page.getByTestId(`preview-plate-${plate1.plateId}`);
  const plate2Option = page.getByTestId(`preview-plate-${plate2.plateId}`);
  await expect(plate2Option).toHaveAttribute('aria-selected', 'true');
  await expect(plate2Option).toHaveAttribute('data-plate-status', 'sliced');
  await expect(plate1Option).toHaveAttribute('data-plate-status', 'unsliced');
  await phaseStep('plate 1: unsliced activation terminal', 90_000, async () => {
    await plate1Option.click({ timeout: 30_000 });
    await expect(plate1Option).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
    await expect(plate2Option).toHaveAttribute('aria-selected', 'false', { timeout: 30_000 });
    await expect.poll(readBeds, { timeout: 30_000 }).toEqual([
      expect.objectContaining({ plateId: plate1.plateId, current: true }),
    ]);
    await expect.poll(readModels, { timeout: 30_000 }).toHaveLength(1);
    await expect(page.getByTestId('viewport')).toHaveAttribute(
      'data-preview-projection-state', 'needs-slicing', { timeout: 30_000 },
    );
    await expect(page.getByTestId('viewport').getByRole('status'))
      .toHaveText('Needs slicing', { timeout: 30_000 });
    await expect.poll(readToolpathBounds, { timeout: 30_000 }).toBeNull();
  });
  await phaseStep('plate 1: slice dispatch', 60_000, async () => {
    await page.getByTestId('btn-slice').click({ timeout: 30_000 });
  });
  await waitForSliceTerminal('plate 1');
  await phaseStep('plate 1: renderer projection terminal', 180_000, async () => {
    await expect(page.getByTestId('viewport')).toHaveAttribute(
      'data-preview-projection-state', /ready|failed/, { timeout: 120_000 },
    );
    await expect(page.getByTestId('viewport')).toHaveAttribute('data-preview-projection-state', 'ready');
    await markBrowserMilestone('plate 1: projection DOM ready');
    await expect.poll(readToolpathBounds, { timeout: 30_000 }).not.toBeNull();
  });
  await waitForInteractionReady('plate 1');
  const plate1Bounds = await readToolpathBounds();
  if (!plate1Bounds) throw new Error('plate 1 preview bounds are unavailable');
  const bed1 = beds.find((bed) => bed.plateId === plate1.plateId)!;
  expect(plate1Bounds.min[0]).toBeGreaterThanOrEqual(plate1.position[0] + bed1.bounds.minX - 0.5);
  expect(plate1Bounds.max[0]).toBeLessThanOrEqual(plate1.position[0] + bed1.bounds.maxX + 0.5);
  expect(plate1Bounds.min[1]).toBeGreaterThanOrEqual(plate1.position[1] + bed1.bounds.minY - 0.5);
  expect(plate1Bounds.max[1]).toBeLessThanOrEqual(plate1.position[1] + bed1.bounds.maxY + 0.5);
  expect(plate1Bounds.max[0]).toBeGreaterThan(plate1Bounds.min[0]);
  expect(plate1Bounds.max[1]).toBeGreaterThan(plate1Bounds.min[1]);
  await expect(plate1Option).toHaveAttribute('data-plate-status', 'sliced');
  // The text inspector must use the selected plate's retained G-code rather
  // than the one native Print currently held by the worker. This catches the
  // multi-plate case where both results are complete and the user switches
  // away from the plate whose native result was loaded most recently.
  await phaseStep('plate 1: text projection terminal', 90_000, async () => {
    await page.getByTestId('viewport').focus();
    await page.keyboard.press('c');
    await expect(page.getByTestId('gcode-text-window')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid^="gcode-line-"]').first()).toContainText(/\S/, { timeout: 30_000 });
    await expect.poll(readCameraTarget, { timeout: 30_000 }).not.toBeNull();
  });
  const plate1CameraTarget = await readCameraTarget();
  if (!plate1CameraTarget) throw new Error('plate 1 camera target is unavailable');
  // Selecting and slicing the other plate must not advance plate 2's input
  // revision: its retained result remains sliced when it becomes inactive.
  await phaseStep('plate 2: retained projection revisit terminal', 180_000, async () => {
    await plate2Option.click({ timeout: 30_000 });
    await expect(plate2Option).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
    await expect(plate2Option).toHaveAttribute('data-plate-status', 'sliced', { timeout: 30_000 });
    await expect(plate1Option).toHaveAttribute('data-plate-status', 'sliced', { timeout: 30_000 });
    await expect(page.getByTestId('viewport')).toHaveAttribute(
      'data-preview-projection-state', /ready|failed/, { timeout: 120_000 },
    );
    await expect(page.getByTestId('viewport')).toHaveAttribute('data-preview-projection-state', 'ready');
    await markBrowserMilestone('plate 2 revisit: projection DOM ready');
    await expect.poll(readCameraTarget, { timeout: 30_000 }).toEqual([
      plate1CameraTarget[0] + (plate2.position[0] - plate1.position[0]),
      plate1CameraTarget[1] + (plate2.position[1] - plate1.position[1]),
      plate1CameraTarget[2],
    ]);
    await expect(page.getByTestId('gcode-text-window')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid^="gcode-line-"]').first()).toContainText(/\S/, { timeout: 30_000 });
    await expect(page.getByTestId('gcode-text-window')).not.toContainText(
      'preview text page is unavailable', { timeout: 30_000 },
    );
  });
  await waitForInteractionReady('plate 2 revisit');
  const performanceEvidence = await page.evaluate(() => {
    const diagnostics = (window as unknown as { __previewWorkerDiagnostics?: {
      events: Array<{ direction?: unknown; atMs?: unknown; operation?: unknown; result?: {
        segmentCount?: unknown; transferBytes?: unknown;
      } }>;
      paints: Array<{ label: string; atMs: number }>;
    } }).__previewWorkerDiagnostics;
    return {
      workerTerminals: diagnostics?.events.filter((event) => event.direction === 'response' &&
        (event.operation === 'slicePlate' || event.operation === 'getSliceResult')).map((event) => ({
          operation: event.operation,
          atMs: event.atMs,
          segmentCount: event.result?.segmentCount,
          transferBytes: event.result?.transferBytes,
        })) ?? [],
      browserMilestones: diagnostics?.paints ?? [],
    };
  });
  console.log(`[multi-preview timing] performance evidence ${JSON.stringify(performanceEvidence)}`);
});

test('GPU streaming preview: native renderer is the default backend', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: 120_000 });
  await selectFixturePrinter(page, 'Creality Ender-3 0.4 nozzle');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click();
  await (await chooser).setFiles(resolve(here, '../../../packages/slicer-wasm/fixtures/drc/test_nm.obj.edgebreaker.cl4.2.2.drc'));
  await expect(page.getByTestId('btn-slice')).toBeEnabled();
  await page.getByTestId('btn-slice').click();
  await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 120_000 });
  await expect.poll(() => page.evaluate(() => {
    const hooks = (window as unknown as {
      __orcaE2e?: {
        gpuStreamingStatus?: () => string;
        gpuStreamingDiagnostic?: () => { reason?: string } | null;
      };
    }).__orcaE2e;
    const status = hooks?.gpuStreamingStatus?.();
    return status === 'ready' || (status === 'unavailable' && Boolean(hooks?.gpuStreamingDiagnostic?.()?.reason));
  }), { timeout: 20_000 }).toBe(true);
});
