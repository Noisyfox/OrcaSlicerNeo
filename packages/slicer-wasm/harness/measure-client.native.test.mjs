// Opt-in real WASM + typed-client protocol coverage. Mock tests do not prove
// native feature recognition, measurements, or resource lifetime.
import { beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, fixtureProfileOptions, installProfilePackages } from './profile-installer.mjs';
import { createClient } from '../src/client/client.ts';

const artifact = process.env.ORCA_MEASURE_MODULE;
describe.skipIf(!artifact)('real measurement typed client', () => {
  let client;
  beforeAll(async () => {
    const module = await (await loadModuleFactory(resolve(artifact)))({ noInitialRun: true, print: () => {}, printErr: () => {} });
    await installProfilePackages(module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
    const pointer = Number(module.ccall('orc_init', 'number', ['string'], [fixtureProfileOptions(module)]));
    try { expect(JSON.parse(module.UTF8ToString(pointer)).ok).toBe(true); } finally { module._free(pointer); }
    client = createClient(async () => module);
  }, 120_000);

  it('opens, picks, copies plane geometry, selects and closes', async () => {
    expect(await client.addShape('Cube', 'Measure client')).toMatchObject({ ok: true });
    const object = (await client.getModelStructure()).objects[0];
    const target = { objectId: object.id, instanceId: object.instances[0].id, volumeId: object.volumes[0].id };
    const mesh = await client.getModelMesh();
    const offset = mesh.objects[0].offset;
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const projection = [...identity]; projection[0] = .025; projection[5] = .025; projection[10] = -.01;
    const view = [...identity]; view[12] = -offset[0]; view[13] = -offset[1]; view[14] = -100;
    const event = { pointer: [(3 + 40) * 1.25, (40 - 4) * 1.25], viewport: [0, 0, 100, 100], projection, view };
    const opened = await client.openMeasureSession({ version: 1, targets: [target] });
    expect(opened).toMatchObject({ ok: true, first: null, selectionRevision: 1 });
    const handle = { version: 1, sessionId: opened.sessionId, targetRevision: opened.targetRevision };
    const display = await client.getMeasureDisplay({ ...handle, event });
    expect(display.hover.feature.type).toBe('plane');
    const plane = await client.getMeasurePlane({ ...handle, displayId: display.displayId, role: 'hover', resourceId: display.hover.feature.resourceId });
    expect(plane.ok).toBe(true);
    expect(plane.vertices.length).toBeGreaterThan(0);
    expect(plane.vertices.length % 9).toBe(0);
    const selected = await client.clickMeasure({ ...handle, displayId: display.displayId, event, shift: true });
    expect(selected).toMatchObject({ ok: true, outcome: 'selected', first: { kind: 'pointOnFeature' } });
    await client.releaseMeasureDisplay({ version: 1, sessionId: opened.sessionId, displayId: display.displayId });
    expect(await client.getMeasurePlane({ ...handle, displayId: display.displayId, role: 'hover', resourceId: display.hover.feature.resourceId })).toHaveProperty('error');
    expect(await client.closeMeasureSession({ version: 1, sessionId: opened.sessionId })).toMatchObject({ ok: true });
    expect(await client.readMeasureSession(handle)).toHaveProperty('error');
  }, 120_000);
});
