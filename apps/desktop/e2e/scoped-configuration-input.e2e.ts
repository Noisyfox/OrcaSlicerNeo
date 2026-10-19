import { _electron } from './electron-fixture';
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus, totalmem, release } from 'node:os';
import { resolve } from 'node:path';

test('conditional settings preserve controls through hiding and read-only changes', async () => {
  test.skip(process.env.VITE_SCOPED_CONFIGURATION_GATE !== '1', 'Requires the existing configuration test gate in the renderer build');
  const desktop = resolve(__dirname, '..');
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_MODEL: resolve(desktop, '../../packages/slicer-wasm/fixtures/cube.stl') } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: desktop, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 60_000 });
    await page.locator('#app-tab-prepare').click();
    await page.waitForFunction(() => Boolean((window as any).__orcaScopedConfigurationGate));
    await page.getByTestId('config-page-Multi.').click();
    const tower = page.getByTestId('config-input-enable_prime_tower');
    if (await tower.getAttribute('aria-checked') !== 'true') await tower.click();
    const width = page.getByTestId('config-input-prime_tower_width');
    await expect(width).toBeVisible();
    await width.fill('35'); await width.press('Enter');
    await expect(width).toHaveValue('35'); await expect(width).toBeEnabled();
    const originalWidth = await width.elementHandle();
    await tower.click(); await expect(width).toBeHidden();
    expect(await page.getByTestId('config-field-prime_tower_width').getAttribute('hidden')).not.toBeNull();
    // The ordinary configuration command remains valid while its UI is hidden.
    await page.evaluate(async () => (window as any).__orcaScopedConfigurationGate.configure({
      version: 1, operation: 'set', targets: [{ scope: 'project' }], key: 'prime_tower_width', value: '42',
    }));
    await tower.click(); await expect(width).toBeVisible(); await expect(width).toHaveValue('42');
    expect(await width.evaluate((node, original) => node === original, originalWidth)).toBe(true);

    await page.getByTestId('btn-add-model').click();
    await page.getByTestId('config-mode-scoped').click();
    await expect.poll(() => page.evaluate(() => (window as any).__orcaE2e.selectMockInstance(0, false))).toBe(true);
    await page.getByTestId('config-page-Speed').click();
    const speed = page.getByTestId('config-input-outer_wall_speed');
    await expect(speed).toBeVisible(); const originalSpeed = await speed.elementHandle();
    const setWalls = async (value: string) => page.evaluate(async value => {
      const gate = (window as any).__orcaScopedConfigurationGate;
      const object = gate.snapshot().objects[0];
      await gate.configure({ version: 1, operation: 'set', targets: [{ scope: 'object', id: String(object.id) }], key: 'wall_loops', value });
    }, value);
    await setWalls('0'); await expect(speed).toBeDisabled();
    await setWalls('2'); await expect(speed).toBeEnabled();
    expect(await speed.evaluate((node, original) => node === original, originalSpeed)).toBe(true);
    await originalWidth?.dispose(); await originalSpeed?.dispose();
  } finally { await app.close(); }
});

test('Project override highlights its category and enables Reset only while local values exist', async () => {
  const desktop = resolve(__dirname, '..');
  const env = { ...process.env, ORCA_E2E: '1' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: desktop, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 60_000 });
    await page.locator('#app-tab-prepare').click();
    const height = page.getByTestId('config-input-layer_height');
    const category = page.locator('[data-testid^="config-category-"]').filter({ has: height });
    const categoryToggle = category.locator('[data-testid^="config-category-toggle-"]');
    const categoryReset = page.locator('[data-testid^="config-reset-category-"]');
    const openReset = async () => {
      await height.evaluate((el) => el.blur());
      await page.keyboard.press('Escape');
      await categoryToggle.click({ button: 'right' });
      await expect(categoryReset).toBeVisible();
    };
    const resetAll = page.getByTestId('config-reset-all');
    if (await resetAll.isEnabled()) await resetAll.click();
    await expect(page.getByTestId('config-mode-project')).not.toHaveAttribute('data-local-override-highlight');
    await expect(page.getByTestId('config-mode-scoped')).not.toHaveAttribute('data-local-override-highlight');
    await expect(categoryToggle).toHaveAttribute('data-local-override-highlight', 'false');
    await openReset();
    await expect(categoryReset).toHaveAttribute('data-disabled', '');
    await page.keyboard.press('Escape');
    await expect(resetAll).toBeDisabled();

    const sourceHeight = await height.inputValue();
    const changedHeight = String(Number(sourceHeight) + 0.01);
    await height.fill(changedHeight);
    await height.press('Enter');
    await expect(categoryToggle).toHaveAttribute('data-local-override-highlight', 'true');
    await expect(categoryToggle).toHaveCSS('color', 'rgb(247, 148, 29)');
    await openReset();
    await expect(categoryReset).not.toHaveAttribute('data-disabled');
    await expect(resetAll).toBeEnabled();

    await categoryReset.click();
    await expect(categoryToggle).toHaveAttribute('data-local-override-highlight', 'false');
    await openReset();
    await expect(categoryReset).toHaveAttribute('data-disabled', '');
    await page.keyboard.press('Escape');
    await expect(resetAll).toBeDisabled();
  } finally {
    await app.close();
  }
});

test('scoped fields edit mixed drafts and percentages and cancel with Escape', async () => {
  const desktop = resolve(__dirname, '..');
  const env = { ...process.env, ORCA_E2E: '1',
    ORCA_E2E_MODEL: resolve(desktop, '../../packages/slicer-wasm/fixtures/cube.stl'),
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: desktop, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 60_000 });
    await page.locator('#app-tab-prepare').click();
    const rows = page.getByTestId('object-list').locator('div[data-testid^="object-"]:not([data-testid="object-list"])');
    for (let i = 0; i < 2; i++) {
      await page.getByTestId('btn-add-model').click();
      await expect(rows).toHaveCount(i + 1);
    }
    await page.getByTestId('config-mode-scoped').click();
    const height = page.getByTestId('config-input-layer_height');
    const settle = async () => {
      await expect.poll(() => page.evaluate(() =>
        (window as unknown as { __orcaE2e: { selectMockInstance(index: number, additive: boolean): boolean } })
          .__orcaE2e.selectMockInstance(0, false),
      )).toBe(true);
    };
    for (let i = 0; i < 2; i++) {
      await rows.nth(i).locator('button').first().click();
      await height.fill(i === 0 ? '0.21' : '0.31');
      await height.press('Enter');
      // The native history patch must retain selection, allowing continued
      // editing without selecting the object again.
      await expect(rows.nth(i).locator('[data-testid^="config-marker-object-"]')).toBeVisible();
      await expect(rows.nth(i).locator(':scope > div > button[data-state="selected"]')).toBeVisible();
      await expect(rows.nth(i).locator(':scope > div > button > span').last()).toHaveCSS('color', 'rgb(247, 148, 29)');
      await expect(height).toHaveValue(i === 0 ? '0.21' : '0.31');
      await height.evaluate((el) => el.blur());
      await page.mouse.move(0, 0);
      await height.hover();
      await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText('Effective value source: Object.');
    }
    await rows.nth(0).locator('button').first().click({ modifiers: ['ControlOrMeta'] });
    await expect(page.getByTestId('config-mixed-layer_height')).toBeVisible();
    await height.focus();
    await height.pressSequentially('0.25');
    await expect(height).toHaveValue('0.25');
    await height.press('Enter');
    await settle();
    await rows.nth(0).locator('button').first().click();
    await expect(page.getByTestId('config-mixed-layer_height')).toHaveCount(0);
    await expect(height).toHaveValue('0.25');
    await height.fill('0.4');
    await height.press('Escape');
    await expect(height).toHaveValue('0.25');
    // Selecting each target proves the multi-target commit and Escape result.
    for (let i = 0; i < 2; i++) {
      await rows.nth(i).locator('button').first().click();
      await expect(height).toHaveValue('0.25');
    }
    await page.getByTestId('config-page-Strength').click();
    const percent = page.getByTestId('config-input-sparse_infill_density');
    const sourcePercent = await percent.inputValue();
    const field = page.getByTestId('config-field-sparse_infill_density');
    const decrease = field.locator('button[aria-label^="Decrease"]');
    const increase = field.locator('button[aria-label^="Increase"]');
    await percent.fill('0%');
    await expect(decrease).toBeDisabled();
    await expect(increase).toBeEnabled();
    await percent.fill('100%');
    await expect(increase).toBeDisabled();
    await expect(decrease).toBeEnabled();
    await percent.press('Escape');
    await expect(percent).toHaveValue(sourcePercent);
    await page.getByTestId('config-option-label-sparse_infill_density').hover();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText('Range: [0%, 100%]');
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText('parameter name: sparse_infill_density');
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText('Default: 20%');
    await page.mouse.move(0, 0);
    await percent.fill('22%');
    await percent.press('Enter');
    await settle();
    await rows.nth(1).locator('button').first().click();
    await expect(percent).toHaveValue('22%');
    await percent.evaluate((el) => el.blur());
    await page.mouse.move(0, 0);
    await percent.hover();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText('Effective value source: Object.');
    await expect(page.locator('[data-testid^="config-error-"]')).toHaveCount(0);
    await rows.nth(1).locator('[data-testid^="config-marker-object-"]').click();
    await expect(rows.nth(1).locator('[data-testid^="config-marker-object-"]')).toHaveCount(0);
    await expect(rows.nth(1).locator(':scope > div > button[data-state="selected"]')).toBeVisible();
    await expect(percent).not.toHaveValue('22%');
    await expect(rows.nth(0).locator('[data-testid^="config-marker-object-"]')).toBeVisible();
  } finally {
    await app.close();
  }
});

// Manual real-WASM benchmark. Keep timing assertions out of hosted CI.
test('profiles an empty Project option update through editable and visual completion', async () => {
  test.skip(process.env.ORCA_OPTION_PROFILE !== '1', 'Dedicated local real-WASM performance run');
  test.setTimeout(480_000);
  const out = process.env.ORCA_OPTION_PROFILE_OUTPUT ?? '/tmp/orca-option-update-profile';
  const expectedEditorReads = Number(process.env.ORCA_OPTION_PROFILE_EDITOR_READS ?? '1');
  mkdirSync(out, { recursive: true });
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  const report: any = {
    samples: [],
    environment: {
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      sourceRef: process.env.ORCA_OPTION_PROFILE_SOURCE_REF ?? 'HEAD',
      cpu: cpus()[0]?.model, memory: totalmem(), platform: process.platform, arch: process.arch, os: release(),
      wasmSha256: createHash('sha256').update(readFileSync(resolve(__dirname, '../out/renderer/wasm/threaded/orca_slice.wasm'))).digest('hex'),
      realWasm: true, optimized: !process.env.ELECTRON_RENDERER_URL, scene: 'empty, one plate',
    },
  };
  try {
    const page = await app.firstWindow();
    page.on('pageerror', error => console.log('[pageerror]', error.message));
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 180_000 });
    await page.locator('#app-tab-prepare').click();
    await page.getByTestId('preset-select').click();
    await page.getByPlaceholder('Search presets…').fill('Snapmaker U1');
    await page.getByRole('option', { name: 'Snapmaker U1', exact: true }).click();
    await expect(page.getByTestId('preset-transition-region')).toHaveAttribute('aria-busy', 'false');
    report.versions = await app.evaluate(({ app }) => ({ electron: process.versions.electron, chrome: process.versions.chrome, version: app.getVersion() }));
    report.execution = await page.evaluate(() => (window as any).__orcaScopedConfigurationGate.execution());
    report.printer = await page.getByTestId('preset-select').textContent();
    const scene = await page.evaluate(() => (window as any).__orcaScopedConfigurationGate.snapshot());
    expect(scene.objects).toHaveLength(0);
    expect(scene.plates.plates).toHaveLength(1);
    await page.waitForTimeout(500);

    // Observe the existing typed transport and DOM; no production instrumentation
    // or calls into native state are introduced by this measurement.
    await page.evaluate(() => {
      const p: any = (window as any).__optionProfile = { events: [], pending: new Map(), background: new Map(), active: false, last: 0 };
      const add = (event: any) => {
        if (!p.active) return;
        p.events.push({ at: performance.now(), ...event });
        if (!event.background) p.last = performance.now();
      };
      const observed = new WeakSet();
      for (const proto of [MessagePort.prototype, Worker.prototype]) {
        const original = proto.postMessage;
        proto.postMessage = function(this: MessagePort | Worker, message: any, ...args: any[]) {
          if (!observed.has(this)) {
            observed.add(this);
            const observe = (event: Event) => {
              const response = (event as MessageEvent).data;
              if (response?.type !== 'response') return;
              const background = p.background.has(response.id);
              const op = p.pending.get(response.id) ?? p.background.get(response.id);
              p.pending.delete(response.id); p.background.delete(response.id);
              if (op) add({ type: 'response', id: response.id, op, background, ok: response.ok, resultOk: response.result?.ok });
            };
            const consumer = this.onmessage;
            if (consumer) this.onmessage = function(this: MessagePort | Worker, event: MessageEvent) {
              observe(event);
              return Reflect.apply(consumer, this, [event]);
            };
            else this.addEventListener('message', observe, { capture: true });
          }
          if (message?.type === 'request') {
            const background = message.op === 'getRuntimeMemory';
            (background ? p.background : p.pending).set(message.id, message.op);
            add({ type: 'request', id: message.id, op: message.op, background });
          }
          return Reflect.apply(original, this, [message, ...args]);
        } as any;
      }
      const region = '[data-testid="configuration-panel"], [data-testid="configuration-options-scroll"], [role="dialog"], [data-testid="history-undo"]';
      new MutationObserver(records => {
        if (!p.active) return;
        const relevant = records.filter(record => (record.target instanceof Element ? record.target : record.target.parentElement)?.closest(region));
        if (relevant.length) add({ type: 'dom', count: relevant.length });
      }).observe(document.body, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['disabled', 'hidden', 'aria-disabled', 'aria-busy', 'data-condition-readonly', 'data-draft-override-highlight', 'data-local-override-highlight'],
      });
      document.addEventListener('keydown', event => {
        if (!p.armed || event.key !== 'Enter') return;
        p.active = true; p.armed = false; p.start = performance.now(); p.last = p.start;
        add({ type: 'input', testid: (event.target as Element).getAttribute('data-testid') });
      }, true);
    });

    const input = page.getByTestId('config-input-layer_height');
    for (let index = 0; index < 8; index++) {
      await expect(input).toBeVisible();
      await expect(input).toBeEnabled();
      const value = index % 2 ? '0.22' : '0.21';
      await input.fill(value);
      await page.waitForTimeout(250);
      await page.evaluate(() => {
        const p = (window as any).__optionProfile;
        p.events = []; p.pending.clear(); p.background.clear(); p.active = false; p.armed = true;
        p.readyAt = 0; p.animations = []; p.visualDoneAt = 0; p.lastActive = false;
      });
      await input.press('Enter');
      const sample = await page.evaluate(async index => {
        const p = (window as any).__optionProfile;
        const begin = performance.now();
        while (performance.now() - begin < 60_000) {
          await new Promise(requestAnimationFrame);
          const animations = document.getAnimations().filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime));
          for (const animation of animations) {
            if (p.animations.some((entry: any) => entry.animation === animation)) continue;
            const effect = animation.effect as KeyframeEffect;
            p.animations.push({ animation, at: performance.now(), startTime: animation.startTime,
              endTime: effect.getComputedTiming().endTime, duration: effect.getComputedTiming().duration,
              delay: effect.getTiming().delay, type: animation.constructor.name,
              testid: effect.target?.getAttribute('data-testid'),
              properties: Object.keys(effect.getKeyframes()[0] ?? {}).filter(key => !['offset', 'computedOffset', 'easing', 'composite'].includes(key)),
            });
          }
          if (!animations.length && p.lastActive) p.visualDoneAt = performance.now();
          p.lastActive = animations.length > 0;
          const element = document.querySelector('[data-testid="config-input-layer_height"]')!;
          const ready = !element.matches(':disabled') && !document.querySelector('[data-testid="configuration-option-lock"]:disabled');
          if (!ready) p.readyAt = 0;
          if (ready && p.events.some((event: any) => event.type === 'response' && event.op === 'getPrintConfigEditor') && !p.pending.size && !p.readyAt) p.readyAt = performance.now();
          // Quiet confirmation and two additional frames establish stability;
          // their waiting time is recorded separately, not added to UI latency.
          if (!p.readyAt || performance.now() - p.last <= 250 || p.pending.size || animations.length) continue;
          const last = p.last;
          await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
          if (last !== p.last) continue;
          p.active = false;
          return { index, start: p.start, readyAt: p.readyAt, lastActivityAt: last, observedAt: performance.now(),
            visualDoneAt: p.visualDoneAt, events: p.events,
            animations: p.animations.map(({ animation, ...rest }: any) => rest),
          };
        }
        throw new Error('UI did not stabilize: ' + JSON.stringify(p.events));
      }, index);
      await expect(input).toHaveValue(value);
      const requests = sample.events.filter((event: any) => event.type === 'request' && !event.background);
      expect(requests.filter((event: any) => event.op === 'mutateNativeScopedConfig')).toHaveLength(1);
      expect(requests.filter((event: any) => event.op === 'getPrintConfigEditor')).toHaveLength(expectedEditorReads);
      expect(sample.events.find((event: any) => event.type === 'response' && event.op === 'mutateNativeScopedConfig')?.resultOk).toBe(true);
      report.samples.push(sample);
      console.log('[option-profile]', JSON.stringify({ index, readyMs: sample.readyAt - sample.start,
        stableMs: Math.max(sample.readyAt, sample.lastActivityAt, sample.visualDoneAt) - sample.start,
        rpcs: requests.map((event: any) => event.op),
      }));
      writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
    }
  } finally {
    writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
    await app.close();
  }
});
