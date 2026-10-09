import { _electron } from './electron-fixture';
import { selectFixturePrinter } from './printer-selection';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { openProjectMenu } from './project-menu';

const DESKTOP_ROOT = resolve(__dirname, '..');
const MODEL_PATH = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/cube.stl');
// This is an expectation, not an artifact selector. Build the real renderer
// and utility Worker with the existing forced-variant gate before running it.
const EXPECTED_VARIANT = process.env.ORCA_E2E_NODEFS_EXPECT_VARIANT ?? 'threaded';
const NODEFS = EXPECTED_VARIANT === 'threaded';
const STARTUP_TIMEOUT = 300_000;
const CLEANUP_TIMEOUT = 30_000;

test.skip(process.env.ORCA_E2E_REAL !== '1', 'requires freshly staged real WASM and VITE_E2E=1');

interface SliceReceipt {
  plateId: string;
  resultGeneration: string;
}

interface ProtocolEvidence {
  threaded: boolean | null;
  slices: SliceReceipt[];
  exports: Array<{ fileName: string; byteLength: number }>;
  projectExports: Array<{ path: string; byteLength: number }>;
}

// Observe the existing transport rather than adding a production test API or
// reaching through the runtime boundary to an Emscripten module.
function observeRuntimeProtocol(): void {
  const evidence: ProtocolEvidence = { threaded: null, slices: [], exports: [], projectExports: [] };
  (window as unknown as { __nodefsProtocol: ProtocolEvidence }).__nodefsProtocol = evidence;
  const original = MessagePort.prototype.postMessage;
  const pendingByPort = new WeakMap<MessagePort, Map<number, string>>();
  MessagePort.prototype.postMessage = function (this: MessagePort, ...args: unknown[]) {
    const request = args[0] as { type?: string; id: number; op: string } | null;
    if (request?.type === 'request') {
      let pending = pendingByPort.get(this);
      if (!pending) {
        pending = new Map();
        pendingByPort.set(this, pending);
        const requests = pending;
        this.addEventListener('message', (event: MessageEvent) => {
          const reply = event.data;
          if (reply?.type === 'runtime-state') evidence.threaded = reply.threaded;
          if (reply?.type !== 'response') return;
          const operation = requests.get(reply.id);
          requests.delete(reply.id);
          if (!reply.result?.ok) return;
          if (operation === 'slicePlate' && reply.result.receipt) {
            const { plateId, resultGeneration } = reply.result.receipt;
            evidence.slices.push({ plateId, resultGeneration });
          }
          if (operation === 'exportGcodePlate' || operation === 'exportProject') {
            if (operation === 'exportGcodePlate') {
              evidence.exports.push({ fileName: reply.result.fileName, byteLength: reply.result.bytes.byteLength });
            } else {
              evidence.projectExports.push({ path: reply.result.path, byteLength: reply.result.bytes.byteLength });
            }
          }
        });
      }
      pending.set(request.id, request.op);
    }
    return Reflect.apply(original, this, args);
  } as typeof original;
}

function protocol(page: Page): Promise<ProtocolEvidence> {
  return page.evaluate(() => (window as unknown as { __nodefsProtocol: ProtocolEvidence }).__nodefsProtocol);
}

function sessionDirectories(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('orca-slicer-'))
    .map((entry) => join(root, entry.name)).sort();
}

async function currentSession(root: string): Promise<string> {
  await expect.poll(() => sessionDirectories(root), { timeout: CLEANUP_TIMEOUT }).toHaveLength(1);
  return sessionDirectories(root)[0]!;
}

async function ready(page: Page): Promise<void> {
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: STARTUP_TIMEOUT });
  expect(page.workers()).toHaveLength(0);
}

async function runtimePids(app: ElectronApplication): Promise<number[]> {
  return app.evaluate(({ app }) => app.getAppMetrics()
    .filter((metric) => metric.name === 'Orca Slicer Runtime').map((metric) => metric.pid));
}

function assertBackingDirectory(directory: string): void {
  expect(existsSync(directory)).toBe(true);
  // The log opens lazily and can remain absent at warning/error severity.
  // Native import and generation bytes below prove the threaded mount.
  if (!NODEFS) expect(readdirSync(directory)).toEqual([]);
}

async function sliceToPreview(page: Page): Promise<SliceReceipt> {
  const previous = (await protocol(page)).slices.length;
  await page.getByTestId('btn-slice').click();
  await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 120_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __orcaE2e?: { gpuStreamingStatus?: () => string };
  }).__orcaE2e?.gpuStreamingStatus?.()), { timeout: 30_000 }).toBe('ready');
  await expect(page.getByTestId('layer-scrubber')).toBeVisible();
  await expect(page.getByTestId('btn-export')).toBeEnabled();
  const slices = (await protocol(page)).slices;
  expect(slices).toHaveLength(previous + 1);
  return slices.at(-1)!;
}

async function exportAndCompare(page: Page, output: string, directory: string, receipt: SliceReceipt) {
  if (existsSync(output)) unlinkSync(output);
  const previous = (await protocol(page)).exports.length;
  await page.getByTestId('btn-export').click();
  await expect.poll(() => existsSync(output), { timeout: 30_000 }).toBe(true);
  // File creation precedes write completion. The button unlocks only once
  // the actual Electron save promise resolves.
  await expect(page.getByTestId('btn-export')).toBeEnabled({ timeout: 30_000 });
  const exported = readFileSync(output);
  expect(exported.toString('utf8')).toContain('G1');
  expect(exported.toString('utf8')).not.toContain('; mock gcode');
  const exports = (await protocol(page)).exports;
  expect(exports).toHaveLength(previous + 1);
  const result = exports.at(-1)!;
  expect(result.fileName).toMatch(/\.gcode$/);
  expect(result.byteLength).toBe(exported.byteLength);
  let nativePath = '';
  if (NODEFS) {
    const sources = readdirSync(directory).filter((name) => /^plate-result-.*\.gcode$/.test(name));
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatch(new RegExp(`-${receipt.resultGeneration}\\.gcode$`));
    nativePath = join(directory, sources[0]!);
    expect(readFileSync(nativePath).equals(exported)).toBe(true);
    expect(readdirSync(directory).filter((name) => /^plate-result-.*\.gcode$/.test(name)))
      .toEqual(sources);
  } else {
    assertBackingDirectory(directory);
  }
  return { nativePath, bytes: exported, sha256: createHash('sha256').update(exported).digest('hex') };
}

async function assertPagedSourceMatches(page: Page, bytes: Buffer): Promise<void> {
  await page.getByTestId('viewport').focus();
  await page.keyboard.press('c');
  const sourceWindow = page.getByTestId('gcode-text-window');
  await expect(sourceWindow).toBeVisible();
  const lines = bytes.toString('utf8').split(/\r?\n/);
  // The text overlay can start around the active move, rather than line 1.
  // Compare its actual numbered rows against the same exported source bytes.
  await expect.poll(async () => {
    const rows = await sourceWindow.locator('[data-testid^="gcode-line-"]').evaluateAll((elements) =>
      elements.map((element) => ({
        line: Number(element.getAttribute('data-testid')!.slice('gcode-line-'.length)),
        text: element.lastElementChild?.textContent ?? '',
      })),
    );
    return rows.length > 0 && rows.some((row) => row.text.length > 0)
      && rows.every((row) => row.text === lines[row.line - 1]);
  }, { timeout: 30_000 }).toBe(true);
  await page.getByTestId('gcode-text-close').click();
}

test(`real ${EXPECTED_VARIANT} runtime validates temporary files, preview and session cleanup`, async ({}, testInfo) => {
  expect(['threaded', 'serial']).toContain(EXPECTED_VARIANT);
  // Four real runtime starts exercise independent session replacement paths.
  test.setTimeout(NODEFS ? 900_000 : 480_000);
  const directory = mkdtempSync(join(tmpdir(), 'orca-nodefs-e2e-'));
  const temporaryRoot = join(directory, '临时 files');
  mkdirSync(temporaryRoot);
  const output = join(directory, '导出 cube.gcode');
  const projectOutput = join(directory, '保存 cube.3mf');
  const env = {
    ...process.env,
    ORCA_E2E: '1', ORCA_E2E_MODEL: MODEL_PATH, ORCA_E2E_EXPORT: output,
    ORCA_E2E_PROJECT_SAVE: projectOutput, ORCA_E2E_PREFERENCES: join(directory, 'preferences.json'),
    TEMP: temporaryRoot, TMP: temporaryRoot, TMPDIR: temporaryRoot,
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ORCA_E2E_LIFECYCLE;
  const started = performance.now();
  const launchOptions = {
    args: ['.', ...(process.platform === 'linux' ? ['--use-angle=swiftshader-webgl'] : [])],
    cwd: DESKTOP_ROOT, env,
  };
  let app = await _electron.launch(launchOptions);
  const evidence: Record<string, unknown> = { expectedVariant: EXPECTED_VARIANT, temporaryRoot };
  let closed = false;
  let currentPage: Page | undefined;
  try {
    const page = await app.firstWindow();
    currentPage = page;
    await ready(page);
    evidence.startupMs = performance.now() - started;
    const firstSession = await currentSession(temporaryRoot);
    assertBackingDirectory(firstSession);
    const firstPids = await runtimePids(app);
    expect(firstPids).toHaveLength(1);

    // Install before a known document reload so initialization cannot race
    // the observer. The first session must disappear independently of boot.
    await page.addInitScript(observeRuntimeProtocol);
    await page.reload();
    await expect.poll(() => existsSync(firstSession), { timeout: CLEANUP_TIMEOUT }).toBe(false);
    await ready(page);
    await expect.poll(async () => (await protocol(page)).threaded).toBe(NODEFS);
    const activeSession = await currentSession(temporaryRoot);
    expect(activeSession).not.toBe(firstSession);
    expect(await runtimePids(app)).not.toContain(firstPids[0]);
    assertBackingDirectory(activeSession);

    await page.locator('#app-tab-prepare').click();
    const printer = 'Creality Ender-3 0.4 nozzle';
    await selectFixturePrinter(page, printer);
    const importAt = performance.now();
    await page.getByTestId('btn-add-model').click();
    await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });
    evidence.importMs = performance.now() - importAt;
    if (NODEFS) expect(readFileSync(join(activeSession, 'cube.stl')).equals(readFileSync(MODEL_PATH))).toBe(true);
    else assertBackingDirectory(activeSession);

    const sliceAt = performance.now();
    const firstReceipt = await sliceToPreview(page);
    evidence.sliceToPreviewMs = performance.now() - sliceAt;
    const exportAt = performance.now();
    const firstExport = await exportAndCompare(page, output, activeSession, firstReceipt);
    evidence.exportMs = performance.now() - exportAt;
    evidence.firstResult = { receipt: firstReceipt, byteLength: firstExport.bytes.byteLength, sha256: firstExport.sha256 };
    await assertPagedSourceMatches(page, firstExport.bytes);
    await testInfo.attach('cube.gcode', { body: firstExport.bytes, contentType: 'text/plain' });

    if (NODEFS) {
      await page.locator('#app-tab-prepare').click();
      // Real native metadata exposes layer_height at object scope. Select
      // the imported cube before editing rather than relying on mock scopes.
      await page.getByTestId('config-mode-scoped').click();
      const objectRows = page.getByTestId('object-list')
        .locator('div[data-testid^="object-"]:not([data-testid="object-list"])');
      await expect(objectRows).toHaveCount(1);
      await objectRows.first().locator('button').first().click();
      await page.getByTestId('sidebar-settings-panel').getByRole('button', { name: 'Search settings', exact: true }).click();
      await page.getByTestId('scoped-config-search').fill('layer_height');
      const layerHeight = page.getByTestId('config-input-layer_height');
      await expect(layerHeight).toBeVisible();
      const nextHeight = await layerHeight.inputValue() === '0.3' ? '0.2' : '0.3';
      await layerHeight.fill(nextHeight);
      await layerHeight.press('Enter');
      await expect(page.getByTestId('btn-export')).toHaveCount(0);
      await expect(page.getByTestId('btn-slice')).toBeEnabled();
      const secondReceipt = await sliceToPreview(page);
      expect(secondReceipt.plateId).toBe(firstReceipt.plateId);
      expect(secondReceipt.resultGeneration).not.toBe(firstReceipt.resultGeneration);
      const secondExport = await exportAndCompare(page, output, activeSession, secondReceipt);
      if (NODEFS) {
        expect(secondExport.nativePath).not.toBe(firstExport.nativePath);
        await expect.poll(() => existsSync(firstExport.nativePath)).toBe(false);
      }
      await assertPagedSourceMatches(page, secondExport.bytes);
      evidence.secondResult = { receipt: secondReceipt, byteLength: secondExport.bytes.byteLength, sha256: secondExport.sha256 };

      await page.locator('#app-tab-prepare').click();
      await page.getByTestId('titlebar-save-project').click();
      await expect.poll(() => existsSync(projectOutput), { timeout: 30_000 }).toBe(true);
      await expect(page.getByTestId('titlebar-save-project')).toBeDisabled();
      const projectBytes = readFileSync(projectOutput);
      expect(projectBytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
      const projectExports = (await protocol(page)).projectExports;
      expect(projectExports).toHaveLength(1);
      expect(projectExports[0]!.path).toMatch(/^\/tmp\/orca-project-\d+\.3mf$/);
      expect(projectExports[0]!.byteLength).toBe(projectBytes.byteLength);
      expect(readdirSync(activeSession).filter((name) => name.startsWith('orca-project-'))).toEqual([]);

      // Reuse the existing native picker override with the real saved 3MF.
      await app.evaluate((_, path) => { process.env.ORCA_E2E_MODEL = path; }, projectOutput);
      await openProjectMenu(page, app);
      await page.getByTestId('project-load-project').click();
      await page.getByTestId('project-load-confirm').click();
      await expect.poll(() => page.evaluate(() => (window as unknown as {
        __orcaE2e?: { projectLoadEvidence?: () => unknown };
      }).__orcaE2e?.projectLoadEvidence?.()), { timeout: STARTUP_TIMEOUT }).toMatchObject({
        receipt: {
          sourceDisplayName: basename(projectOutput), sourceByteLength: projectBytes.byteLength,
          commitRoute: 'load-project', nativeResult: { ok: true, mode: 'project', objects: 1, instances: 1 },
        },
        session: { hasContent: true, scope: 'project', hasLocation: true },
      });
      expect(readdirSync(activeSession).filter((name) => name.startsWith('orca-project-'))).toEqual([]);
      await expect.poll(() => existsSync(secondExport.nativePath)).toBe(false);
      await page.getByTestId('config-mode-scoped').click();
      await expect(objectRows).toHaveCount(1);
      await objectRows.first().locator('button').first().click();
      await expect(layerHeight).toHaveValue(nextHeight);
      evidence.projectBytes = projectBytes.byteLength;
      evidence.reopenedObjectLayerHeight = nextHeight;

      await app.evaluate(({ app }) => {
        const runtime = app.getAppMetrics().find((metric) => metric.name === 'Orca Slicer Runtime');
        if (!runtime) throw new Error('slicer utility is missing');
        process.kill(runtime.pid);
      });
      await expect.poll(() => runtimePids(app), { timeout: CLEANUP_TIMEOUT }).toHaveLength(0);
      await expect.poll(() => sessionDirectories(temporaryRoot), { timeout: CLEANUP_TIMEOUT }).toEqual([]);
      await page.reload();
      await ready(page);
      const recoveredSession = await currentSession(temporaryRoot);
      expect(recoveredSession).not.toBe(activeSession);
      assertBackingDirectory(recoveredSession);

      const crashed = page.waitForEvent('crash');
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer());
      await crashed;
      await expect.poll(() => runtimePids(app), { timeout: CLEANUP_TIMEOUT }).toHaveLength(0);
      await expect.poll(() => sessionDirectories(temporaryRoot), { timeout: CLEANUP_TIMEOUT }).toEqual([]);
      // Playwright closes a crashed Page's operation scope permanently. Its
      // crash cleanup is proved above; use a fresh app for the live quit case.
      await app.close();
      closed = true;
      app = await _electron.launch(launchOptions);
      closed = false;
      currentPage = await app.firstWindow();
      await ready(currentPage);
      const lastSession = await currentSession(temporaryRoot);
      expect(lastSession).not.toBe(recoveredSession);
      assertBackingDirectory(lastSession);
      evidence.replacedSessions = [firstSession, activeSession, recoveredSession, lastSession];
    }

    // close() exercises the real app quit barrier with an initialized runtime.
    // Assert native cleanup after process exit, not merely
    // after a stop request or test-owned directory removal.
    await app.close();
    closed = true;
    await expect.poll(() => sessionDirectories(temporaryRoot), { timeout: CLEANUP_TIMEOUT }).toEqual([]);
    evidence.elapsedMs = performance.now() - started;
    console.log('[nodefs-runtime]', JSON.stringify(evidence));
    await testInfo.attach('nodefs-evidence.json', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  } catch (error) {
    if (currentPage && !currentPage.isClosed()) {
      const body = await currentPage.locator('body').innerText({ timeout: 2_000 }).catch(() => 'Renderer unavailable');
      await testInfo.attach('nodefs-failure-state.txt', { body, contentType: 'text/plain' });
    }
    throw error;
  } finally {
    if (!closed) await app.close();
  }
});
