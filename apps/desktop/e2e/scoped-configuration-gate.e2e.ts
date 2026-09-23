import { _electron, test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const enabled = process.env.VITE_SCOPED_CONFIGURATION_GATE === '1';
test.skip(!enabled, 'requires the fixture-safe release gate runner');
test.setTimeout(3_600_000);
const scenarios = ['transform', 'object-set', 'object-reset', 'volume-set', 'volume-reset',
  'plate-set', 'plate-reset', 'project-set', 'project-reset', 'multi-target',
  ...(process.env.VITE_SCOPED_CONFIGURATION_GATE_VARIANT === 'threaded' ? ['active-slice'] : []),
  'configured-delete', 'history-jump'];

test('release scoped configuration full history matrix', async () => {
  const fixture = process.env.ORCA_REAL_PROJECT_FIXTURE_COPY!;
  const output = process.env.ORCA_SCOPED_GATE_OUTPUT!;
  const bytes = readFileSync(fixture);
  expect(bytes.length).toBe(45_586_816);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('6db07e50b4692f95bfef65595e9fcd0bf902c9660b7b1d7bc1a4f98b4d7d2425');
  expect(resolve(fixture).toLowerCase()).not.toBe(resolve(process.env.ORCA_REAL_PROJECT_FIXTURE_SOURCE!).toLowerCase());
  const report: any = { version: 1, variant: process.env.VITE_SCOPED_CONFIGURATION_GATE_VARIANT,
    processIndex: Number(process.env.ORCA_SCOPED_GATE_PROCESS), fixture, release: true, mock: false,
    boundary: 'renderer DOM event before coordinator.restore to two RAFs after canonical publication and idle readiness',
    deleteBoundary: 'after coordinator completion and explicit waitForGLVolumeRevision(modelRevision), through two RAFs and idle readiness; full event duration retained separately',
    scenarios: [], samples: [], failures: [], startedAt: new Date().toISOString() };
  const persist = async () => {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(`${output}.next`, JSON.stringify(report, null, 2));
    for (let attempt = 0; ; attempt++) {
      try { renameSync(`${output}.next`, output); return; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 100 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error;
        // Windows readers/virus scanners may briefly hold the old report.
        // Retry outside every measurement interval, never drop a sample.
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  };
  await persist();
  const preferences = join(dirname(output), 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ version: 1, projectLoadBehaviour: 'load_all', selectedProfiles: {}, ui: {} }));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1', ORCA_E2E_VISIBLE: '1',
    ORCA_E2E_MODEL: fixture, ORCA_E2E_PREFERENCES: preferences,
    ORCA_E2E_PROJECT_SAVE: join(dirname(output), 'saved-roundtrip.3mf') } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
    const page = await app.firstWindow();
    await page.bringToFront();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    await page.locator('#app-tab-prepare').click();
    await page.getByTestId('menu-file-trigger').click();
    const openedAt = Date.now();
    await page.getByTestId('file-open-project').click();
    await expect.poll(() => page.evaluate(() => (window as any).__orcaE2e?.projectLoadEvidence?.()), { timeout: 300_000 })
      .toMatchObject({ receipt: { sourceDisplayName: basename(fixture), sourceByteLength: bytes.length,
        nativeResult: { ok: true, mode: 'project', multiPlate: true, plateCount: 11 } } });
    await page.waitForFunction(() => Boolean((window as any).__orcaScopedConfigurationGate), undefined, { timeout: 300_000 });
    await page.evaluate(() => (window as any).__orcaScopedConfigurationGate.ready());
    report.execution = await page.evaluate(() => (window as any).__orcaScopedConfigurationGate.execution());
    expect(report.execution.threaded).toBe(report.variant === 'threaded');
    report.openToReadyMs = Date.now() - openedAt;
    const snapshot = () => page.evaluate(() => (window as any).__orcaScopedConfigurationGate.snapshot());
    const configure = (request: any) => page.evaluate((request) => (window as any).__orcaScopedConfigurationGate.configure(request), request);
    const first = await snapshot();
    const object = first.objects[0];
    const targets: Record<string, any[]> = {
      object: [{ scope: 'object', id: object.id }], volume: [{ scope: 'part', id: object.volumes[0].id }],
      plate: [{ scope: 'plate', id: first.plates.currentPlateId }], project: [{ scope: 'project' }],
      'multi-target': first.objects.slice(0, 2).map((o: any) => ({ scope: 'object', id: o.id })),
    };
    const warmups = Number(process.env.ORCA_SCOPED_GATE_WARMUPS ?? 5);
    const measured = Number(process.env.ORCA_SCOPED_GATE_PAIRS ?? 20);
    report.warmups = warmups; report.measuredPairs = measured;
    for (const scenario of scenarios) {
      const cell: any = { scenario, passed: false, completedPairs: 0 };
      report.scenarios.push(cell);
      try {
        await page.evaluate(() => (window as any).__orcaScopedConfigurationGate.resetHistory());
        const scope = scenario.split('-')[0];
        const selected = targets[scope] ?? targets['multi-target'];
        const set = { version: 1, operation: 'set', targets: selected,
          key: scope === 'plate' ? 'spiral_mode' : scope === 'volume' ? 'wall_loops' : 'layer_height',
          value: scope === 'plate' ? '1' : scope === 'volume' ? '4' : '0.23' };
        if (scenario.endsWith('-reset') || scenario === 'configured-delete')
          await configure({ ...set, value: scope === 'plate' ? '0' : scope === 'volume' ? '5' : '0.27',
            targets: scenario === 'configured-delete' ? targets.object : selected });
        const before = await snapshot();
        if (scenario === 'transform') await page.evaluate(() => (window as any).__orcaScopedConfigurationGate.move());
        else if (scenario === 'configured-delete') await page.evaluate((id) => (window as any).__orcaScopedConfigurationGate.delete(id), object.id);
        else if (scenario === 'history-jump') {
          await configure({ ...set, targets: targets.project, value: '0.24' });
          await configure({ ...set, targets: targets.project, value: '0.25' });
        } else if (scenario === 'active-slice') await configure({ ...set, targets: targets.project, value: '0.26' });
        else await configure({ ...set, operation: scenario.endsWith('-reset') ? 'reset' : 'set' });
        await page.evaluate(() => (window as any).__orcaScopedConfigurationGate.ready());
        const after = await snapshot();
        cell.mutationAttribution = await page.evaluate(() => (window as any).__orcaScopedConfigurationGate.attribution());
        const expected = { undo: before, redo: after };
        let jumpRedo: string | undefined;
        for (let pair = -warmups - 1; pair < measured; pair++) {
          for (const direction of ['undo', 'redo'] as const) {
            if (scenario === 'active-slice') {
              await page.evaluate(() => (window as any).__orcaScopedConfigurationGate.startSlice());
              await page.waitForFunction(() => (window as any).__orcaScopedConfigurationGate.execution().sliceActive,
                undefined, { timeout: 60_000 });
              await expect.poll(() => page.evaluate(() => (window as any).__orcaScopedConfigurationGate.admittedSliceCount()),
                { timeout: 60_000 }).toBeGreaterThan(0);
            }
            let action: any = direction;
            if (scenario === 'history-jump') {
              if (direction === 'undo') action = { jump: after.status.undoEntries[1].id, direction };
              else action = { jump: jumpRedo!, direction };
            }
            const result: any = await page.evaluate(({ action, active }) =>
              (window as any).__orcaScopedConfigurationGate.restore(action, active), { action, active: scenario === 'active-slice' });
            const actual = await snapshot();
            const attribution = await page.evaluate(() => (window as any).__orcaScopedConfigurationGate.attribution());
            if (scenario === 'history-jump' && direction === 'undo') jumpRedo = actual.status.redoEntries[1]?.id;
            const sample = { scenario, pair, direction, population: pair === -warmups - 1 ? 'first' : pair < 0 ? 'warmup' : 'measured',
              eligibleMs: scenario === 'configured-delete' ? result.postModelReadyToEditableMs : result.eventToEditableMs,
              ...result, attribution, history: actual.status, snapshotBytes: Buffer.byteLength(JSON.stringify(actual.configuration)),
              functional: false };
            report.samples.push(sample);
            if (scenario === 'active-slice') {
              expect(result.execution).toMatchObject({ threaded: true, sliceActive: true });
              expect(result.pendingSliceTaskCountAtEvent).toBeGreaterThan(0);
            }
            expect(actual.configuration).toEqual(expected[direction].configuration);
            expect(actual.objects.map((o: any) => o.id)).toEqual(expected[direction].objects.map((o: any) => o.id));
            expect(actual.volumeIds).toEqual(expected[direction].volumeIds);
            expect(actual.transforms.map((v: any) => v.id)).toEqual(expected[direction].transforms.map((v: any) => v.id));
            let maximumTransformError = 0;
            for (let i = 0; i < actual.transforms.length; i++) {
              for (const key of ['offset', 'rotation', 'scale', 'mirror']) {
                for (let axis = 0; axis < 3; axis++) {
                  maximumTransformError = Math.max(maximumTransformError,
                    Math.abs(actual.transforms[i].transform[key][axis] - expected[direction].transforms[i].transform[key][axis]),
                    Math.abs(actual.transforms[i].volumeTransform[key][axis] - expected[direction].transforms[i].volumeTransform[key][axis]));
                }
              }
            }
            expect(maximumTransformError).toBeLessThan(0.0000005);
            expect(actual.glRevision).toBe(actual.modelRevision);
            sample.functional = true;
            if (scenario === 'active-slice') {
              await page.evaluate(() => (window as any).__orcaScopedConfigurationGate.cancelSlice());
              await page.waitForFunction(() => !(window as any).__orcaScopedConfigurationGate.execution().sliceActive,
                undefined, { timeout: 60_000 });
            }
            await persist();
          }
          if (pair >= 0) cell.completedPairs++;
        }
        cell.passed = true;
      } catch (error) { cell.error = String(error); report.failures.push({ scenario, error: String(error) }); }
      await persist();
    }
    try {
      const savedPath = env.ORCA_E2E_PROJECT_SAVE;
      const beforeSave = await snapshot();
      await page.getByTestId('menu-file-trigger').click();
      const saveAt = Date.now();
      await page.getByTestId('file-save-project-as').click();
      await expect.poll(() => existsSync(savedPath), { timeout: 300_000 }).toBe(true);
      report.saveMs = Date.now() - saveAt;
      const saved = readFileSync(savedPath);
      report.savedBytes = saved.length;
      expect(saved.includes(Buffer.from('Metadata/orca_neo_config_overlay_v1.json'))).toBe(false);
      report.sidecarBytes = 0;
      await app.evaluate((_, path) => { process.env.ORCA_E2E_MODEL = path; }, savedPath);
      await page.getByTestId('menu-file-trigger').click();
      const reopenAt = Date.now();
      await page.getByTestId('file-open-project').click();
      await page.waitForFunction((name) =>
        (window as any).__orcaE2e?.projectLoadEvidence?.()?.receipt?.sourceDisplayName === name ||
        document.querySelector('[data-testid="project-load-confirmation-dialog"]') !== null,
      basename(savedPath), { timeout: 300_000 });
      await expect(page.getByTestId('project-load-confirmation-dialog')).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => (window as any).__orcaE2e?.projectLoadEvidence?.()), { timeout: 300_000 })
        .toMatchObject({ receipt: { sourceDisplayName: basename(savedPath), sourceByteLength: saved.length } });
      await page.evaluate(() => (window as any).__orcaScopedConfigurationGate.ready());
      report.reopenToReadyMs = Date.now() - reopenAt;
      const reopened = await snapshot();
      const projectValues = (state: any) => {
        const project = { ...state.configuration.project };
        const slots = project.filament_colour?.split(';').length ?? 0;
        // PresetBundle::set_num_filaments normalizes these native integer
        // vectors with resize(n, 0). Compare that native normalized form;
        // retain both original maps below so normalization remains visible.
        for (const key of ['filament_nozzle_map', 'filament_volume_map']) {
          if (slots && Object.hasOwn(project, key)) {
            const values = project[key].split(',');
            project[key] = Array.from({ length: slots }, (_, index) => values[index] ?? '0').join(',');
          }
        }
        return project;
      };
      const localMaps = (state: any) => ({
        project: projectValues(state),
        objects: state.objects.map((o: any) => ({ values: state.configuration.objects[String(o.id)] ?? {},
          parts: o.volumes.map((v: any) => state.configuration.parts[String(v.id)] ?? {}) })),
        plates: state.plates.plates.map((p: any) => state.configuration.plates[p.plateId] ?? {}),
      });
      report.roundtripNativeProjectValues = { before: beforeSave.configuration.project, after: reopened.configuration.project,
        normalization: 'native filament_nozzle_map/filament_volume_map resize to filament_colour count with zero' };
      expect(localMaps(reopened)).toEqual(localMaps(beforeSave));
      report.roundtrip = { passed: true, savedPath };
    } catch (error) { report.failures.push({ stage: 'save-reopen', error: String(error) }); }
  } catch (error) { report.failures.push({ stage: 'setup', error: String(error) }); }
  finally {
    await app?.close();
    report.finishedAt = new Date().toISOString();
    report.overBudget = report.samples.filter((s: any) => s.population !== 'warmup' && s.eligibleMs > 200);
    report.distributions = scenarios.flatMap(scenario => ['undo', 'redo'].map(direction => {
      const values = report.samples.filter((s: any) => s.scenario === scenario && s.direction === direction && s.population === 'measured')
        .map((s: any) => s.eligibleMs).sort((a: number, b: number) => a - b);
      const median = values.length ? (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2 : null;
      return { scenario, direction, count: values.length, min: values[0], median,
        p95: values[Math.max(0, Math.ceil(values.length * .95) - 1)], max: values.at(-1), warmMedianTargetMs: 100, hardGateMs: 200 };
    }));
    report.passed = report.scenarios.length === scenarios.length && report.scenarios.every((s: any) => s.passed) && report.overBudget.length === 0 && report.failures.length === 0;
    await persist();
  }
  expect(report.passed, `raw evidence: ${output}`).toBe(true);
});
