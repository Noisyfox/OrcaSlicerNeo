import { _electron } from './electron-fixture';
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus, totalmem, release } from 'node:os';
import { resolve } from 'node:path';

// Manual real-WASM benchmark. Keep timing assertions out of hosted CI.
test.skip(process.env.ORCA_OPTION_PROFILE !== '1', 'Dedicated local real-WASM performance run');
test('profiles an empty Project option update through editable and visual completion', async () => {
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
