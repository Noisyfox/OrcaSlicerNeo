import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { readBambuProjectResource, BambuNative } from '@orca/bambu-native';
import type * as D from '@orca/printer-control/domain';
import type { BambuHostConfig } from '../../shared/bambu';
import type { BambuDevice } from '../../shared/bambuDevices';
import { BambuObjectSkipping } from './objectSkipping';
import { BambuMonitor } from './monitor';
import { BambuOperations } from './operations';
import { commandCapabilities, prepareCommand } from './commands';
const target = { printerId: 'bambu:a' as D.Id<'printer'>, routeId: 'bambu:a:agent' as D.Id<'route'> };
const metadata = (count = 3, enabled = true) => `<config><plate><metadata key="index" value="1"/><object identify_id="99" name="Other plate"/></plate><plate><metadata key="index" value="2"/><metadata key="label_object_enabled" value="${enabled}"/>${Array.from({ length: count }, (_, i) => `<object identify_id="${7 + i * 2}" name="Part ${i}"/>`).join('')}</plate></config>`;
function fixture() {
  let now = 100, xml = metadata();
  const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
  let report = { msg: 0, gcode_state: 'RUNNING', subtask_id: 'external-task', job_id: '12', plate_idx: 2,
    gcode_file: 'external.gcode.3mf', fun: (1n << 49n).toString(16), s_obj: [] as number[] };
  let devices: BambuDevice[] = [{ deviceId: 'a', name: 'Printer', model: 'H2D', routes: [{ channel: 'cloud', revision: 'c1' }, { channel: 'lan', revision: 'l1', address: '192.0.2.1' }] }];
  const native = Object.fromEntries(['setSelectedMachine', 'startSubscribe', 'stopSubscribe', 'sendMessage', 'sendMessageToPrinter', 'disconnectPrinter', 'connectPrinter', 'installDeviceCertificate'].map(method => [method, vi.fn(async () => 0)])) as unknown as BambuNative;
  native.getCameraUrl = vi.fn(async () => 'bambu:///tutk/fixture?ticket=PRIVATE');
  native.getVersion = vi.fn(async () => '02.08.01.99');
  const repository = { read: async () => ({ version: 1 as const, region: 'Others' as const, clientId: 'client', lan: [{ deviceId: 'a', name: 'Printer', model: 'H2D', ip: '192.0.2.1', accessCode: 'SECRET', revision: 'l1' }] }) };
  const catalogueChanged = vi.fn();
  const monitor = new BambuMonitor(native, { list: async () => devices }, repository, async () => {}, () => {}, () => now, 100);
  const readResource = vi.fn<typeof readBambuProjectResource>(async (_addon, _source, _route, path, _options) => path.endsWith('.png') ? png.slice() : new TextEncoder().encode(xml));
  const objects = new BambuObjectSkipping({ addonPath: '/addon', pluginPath: '/plugin/lib', directory: '/private', certificateDirectory: '/cert', osType: 'macos', osVersion: '1' } as BambuHostConfig,
    native, monitor, { list: async () => devices }, repository, catalogueChanged, readResource);
  monitor.useObjects(objects);
  const operations = new BambuOperations(monitor, () => {}, 1000, () => now);
  const push = (patch: Record<string, unknown> = {}, delta = false) => {
    report = { ...report, ...patch };
    const event = { type: 'message' as const, args: ['a', JSON.stringify({ print: { command: 'push_status', ...(delta ? { msg: 1, ...patch } : report) } })] as [string, string] };
    monitor.onEvent(event); return operations.onEvent(event);
  };
  vi.mocked(native.sendMessage).mockImplementation(async (_device, payload) => { if (JSON.parse(payload).pushing) queueMicrotask(() => { void push(); }); return 0; });
  const context = async () => { const result = await monitor.context(target); if (!result.ok) throw new Error(result.error.message); return result.value; };
  const read = async () => { const result = await objects.read(target); if (!result.ok) throw new Error(result.error.message); return result.value.value; };
  const command = (snapshot: D.PrintObjectSnapshot, indices = [0], intent: 'skip-selected' | 'cancel-print' = 'skip-selected'): Extract<D.PrinterCommand, { type: 'jobs.skipObjects' }> => ({
    type: 'jobs.skipObjects', params: { contextRef: snapshot.contextRef, objectIds: indices.map(i => snapshot.objects[i].id) as [D.Id<'print-object'>, ...D.Id<'print-object'>[]], intent },
  });
  return { objects, monitor, operations, native, readResource, catalogueChanged, read, push, context, command,
    setXml: (next: string) => { xml = next; }, setDevices: (next: BambuDevice[]) => { devices = next; }, advance: (ms: number) => { now += ms; },
    close: async () => { operations.close(); await objects.close(); await monitor.close(); } };
}

it('reads an external current-task catalogue independently, without exposing URLs or credentials', async () => {
  const f = fixture(); try {
    const result = await f.monitor.read({ target, topics: ['printObjects'], source: 'device' });
    expect(result).toMatchObject({ ok: true, value: { values: { printObjects: { kind: 'known', freshness: 'fresh', value: {
      contextRef: { ...target, taskId: 'external-task' }, objects: [{ name: 'Part 0' }, { name: 'Part 1' }, { name: 'Part 2' }],
      skippedObjectIds: { kind: 'known', value: [] }, availability: { kind: 'available' },
    } } } } });
    expect(f.readResource).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE|bambu:\/\/\//);
    expect((await f.monitor.describe(target))).toMatchObject({ ok: true, value: { capabilities: { commands: { 'jobs.skipObjects': { kind: 'supported', constraints: { maxObjects: 64 } } } } } });
  } finally { await f.close(); }
});

it('uses current plate IDs, caches owned maps and rejects foreign context references', async () => {
  const f = fixture(); try {
    const snapshot = await f.read();
    const image = await f.objects.readMap(snapshot.contextRef);
    expect(image).toMatchObject({ ok: true, value: { contextRef: snapshot.contextRef, palette: [
      { colourId: 7, objectId: snapshot.objects[0].id }, { colourId: 9 }, { colourId: 11 },
    ] } });
    expect(f.readResource.mock.calls.at(-1)?.[3]).toBe('Metadata/pick_2.png');
    if (!image.ok) throw new Error('Missing map'); image.value.bytes.fill(0);
    const cached = await f.objects.readMap(snapshot.contextRef);
    expect(cached.ok && [...cached.value.bytes.slice(0, 4)]).toEqual([137, 80, 78, 71]);
    expect(await f.objects.readMap({ ...snapshot.contextRef, token: 'foreign' as D.Id<'print-object-context'> })).toMatchObject({ ok: false, error: { code: 'stale-context' } });
  } finally { await f.close(); }
});

it('falls back to the list after an image error while preserving a valid catalogue', async () => {
  const f = fixture(); try {
    await f.monitor.start(target, 'view'); const snapshot = await f.read();
    f.readResource.mockRejectedValueOnce(new Error('PRIVATE URL SECRET'));
    expect(await f.objects.readMap(snapshot.contextRef)).toMatchObject({ ok: false, error: { message: 'Current task object information could not be loaded.' } });
    expect((await f.context()).objects?.snapshot).toMatchObject({ contextRef: snapshot.contextRef, availability: { kind: 'available' }, pickingImage: { kind: 'unsupported' } });
    expect(prepareCommand(await f.context(), f.command(snapshot))).toMatchObject({ ok: true, value: { fields: { command: 'skip_objects', obj_list: [7] }, qos: 1 } });
  } finally { await f.close(); }
});

it('updates only device-reported skipped IDs, invalidates selected skipped objects and never upgrades a partial skip to stop', async () => {
  const f = fixture(); try {
    await f.monitor.start(target, 'view'); const snapshot = await f.read();
    const ordinary = f.command(snapshot, [0, 1]);
    expect(prepareCommand(await f.context(), ordinary)).toMatchObject({ ok: true, value: { fields: { command: 'skip_objects', obj_list: [7, 9] } } });
    await f.push({ s_obj: [11] }, true);
    expect(prepareCommand(await f.context(), ordinary)).toMatchObject({ ok: false, error: { code: 'precondition-failed' } });
    expect(prepareCommand(await f.context(), f.command(snapshot, [0, 1], 'cancel-print'))).toMatchObject({ ok: true, value: { fields: { command: 'stop', param: '' } } });
    await f.push({ s_obj: [7, 11] }, true);
    expect(prepareCommand(await f.context(), ordinary)).toMatchObject({ ok: false, error: { code: 'stale-context' } });
    expect((await f.context()).objects?.snapshot.skippedObjectIds).toMatchObject({ kind: 'known', value: [snapshot.objects[0].id, snapshot.objects[2].id] });
  } finally { await f.close(); }
});

it('admits consecutive independent operations and completes them only from matching device state', async () => {
  const f = fixture(); try {
    await f.monitor.start(target, 'view'); const snapshot = await f.read();
    const first = await f.operations.submit({ target, requestId: 'first' as D.Id<'request'>, command: f.command(snapshot) });
    const second = await f.operations.submit({ target, requestId: 'second' as D.Id<'request'>, command: f.command(snapshot, [1]) });
    expect(first.kind).toBe('recorded'); expect(second.kind).toBe('recorded');
    expect((await f.context()).objects?.snapshot.skippedObjectIds).toMatchObject({ value: [] });
    const sent = vi.mocked(f.native.sendMessage).mock.calls.map(call => JSON.parse(call[1]).print).filter(p => p?.command === 'skip_objects');
    expect(sent.map(p => p.obj_list)).toEqual([[7], [9]]);
    expect(f.operations.get(first.kind === 'recorded' ? first.operation : {} as never)).toMatchObject({ ok: true, value: { operation: { phase: { kind: 'sent' } } } });
    await f.push({ s_obj: [7] }, true);
    if (first.kind === 'recorded') expect(f.operations.get(first.operation)).toMatchObject({ value: { operation: { phase: { kind: 'completed', confirmation: 'observed-state' } } } });
    if (second.kind === 'recorded') expect(f.operations.get(second.operation)).toMatchObject({ value: { operation: { phase: { kind: 'sent' } } } });
  } finally { await f.close(); }
});

it('preserves same-task context through stale status but rejects a changed task/configuration', async () => {
  const f = fixture(); try {
    await f.monitor.start(target, 'view'); const snapshot = await f.read();
    f.advance(16_000);
    expect(prepareCommand(await f.context(), f.command(snapshot))).toMatchObject({ ok: false, error: { code: 'offline' } });
    await f.push(); expect((await f.context()).objects?.snapshot.contextRef).toEqual(snapshot.contextRef);
    await f.push({ subtask_id: 'new-task' }, true);
    expect(prepareCommand(await f.context(), f.command(snapshot))).toMatchObject({ ok: false, error: { code: 'stale-context' } });
    expect(await f.objects.readMap(snapshot.contextRef)).toMatchObject({ ok: false, error: { code: 'stale-context' } });
  } finally { await f.close(); }
});

it('rejects malformed XML, duplicate IDs and missing plates without executing commands', async () => {
  for (const xml of ['<config>', '<!DOCTYPE config [<!ENTITY x "test">]><config/>', metadata().replace('identify_id="9"', 'identify_id="7"'), metadata().replace('value="2"', 'value="3"')]) {
    const f = fixture(); try { f.setXml(xml); expect(await f.objects.read(target)).toMatchObject({ ok: false }); }
    finally { await f.close(); }
  }
});

it('does not turn missing skipped state into an empty set, and enforces label and object-count limits', async () => {
  for (const count of [63, 64, 65]) {
    const f = fixture(); try {
      f.setXml(metadata(count)); const snapshot = await f.read();
      expect(snapshot.objects).toHaveLength(count);
      expect(snapshot.availability.kind).toBe(count <= 64 ? 'available' : 'blocked');
    } finally { await f.close(); }
  }
  const f = fixture(); try {
    await f.monitor.start(target, 'view'); const snapshot = await f.read();
    await f.push({ s_obj: undefined });
    expect((await f.context()).objects?.snapshot).toMatchObject({ skippedObjectIds: { kind: 'unknown' }, availability: { kind: 'blocked' } });
    await f.push({ s_obj: [999] }, true);
    expect((await f.context()).objects?.snapshot.skippedObjectIds.kind).toBe('unknown');
    f.setXml(metadata(3, false)); const disabled = await f.read();
    expect(disabled.availability).toMatchObject({ kind: 'blocked', reasons: [{ message: expect.stringContaining('not sliced') }] });
    expect(prepareCommand(await f.context(), f.command(snapshot))).toMatchObject({ ok: false });
  } finally { await f.close(); }
});

it('cancels task resources by read ID and waits for cleanup on close', async () => {
  const f = fixture(); try {
    await f.monitor.start(target, 'view');
    let cleaned = false;
    f.readResource.mockImplementationOnce(async (_a, _s, _r, _p, options) => new Promise<Uint8Array>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => { setTimeout(() => { cleaned = true; reject(new Error('aborted')); }, 5); }, { once: true });
    }));
    const pending = f.objects.read(target, 'cancel-me');
    await vi.waitFor(() => expect(f.readResource).toHaveBeenCalled());
    await f.objects.close();
    expect(cleaned).toBe(true); expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  } finally { await f.close(); }
});

it('uses authorized LAN credentials and resolves the Orca-style remote ticket only when requested', async () => {
  const f = fixture(); try {
    f.readResource.mockImplementationOnce(async (_a, _s, route, _p, _o) => {
      const source = route as { localUrl: string; remoteUrl: () => Promise<string> };
      expect(source.localUrl).toContain('192.0.2.1?port=6000');
      expect(source.localUrl).toContain('passwd=SECRET');
      expect(f.native.getCameraUrl).not.toHaveBeenCalled();
      expect(await source.remoteUrl()).toContain('device=a');
      expect(f.native.getCameraUrl).toHaveBeenCalledWith('a||"tutk","agora"');
      return new TextEncoder().encode(metadata());
    });
    await f.read();
  } finally { await f.close(); }
});

it('invalidates configuration revisions and cancels in-flight resources when the task changes', async () => {
  const f = fixture(); try {
    await f.monitor.start(target, 'view'); const snapshot = await f.read();
    f.setDevices([{ deviceId: 'a', name: 'Printer', model: 'H2D', routes: [{ channel: 'cloud', revision: 'c2' }] }]);
    await f.objects.reconcile();
    expect(prepareCommand(await f.context(), f.command(snapshot)).ok).toBe(false);
  } finally { await f.close(); }
  const g = fixture(); try {
    await g.monitor.start(target, 'view');
    g.readResource.mockImplementationOnce(async (_a, _s, _r, _p, options) => new Promise<Uint8Array>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('task changed')), { once: true });
    }));
    const pending = g.objects.read(target, 'changing-task');
    await vi.waitFor(() => expect(g.readResource).toHaveBeenCalledTimes(1));
    await g.push({ subtask_id: 'another-task' }, true);
    await g.context();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  } finally { await g.close(); }
});

it('refuses unidentified tasks and pre-cancelled resource requests', async () => {
  const f = fixture(); try {
    f.objects.cancel('cancel-before-start');
    expect(await f.objects.read(target, 'cancel-before-start')).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    await f.monitor.start(target, 'view'); await f.push({ subtask_id: '0' });
    expect(await f.objects.read(target)).toMatchObject({ ok: false, error: { code: 'precondition-failed' } });
    expect(f.readResource).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

// Generated by the real-WASM print-submission harness; separate from transport
// fixtures. Opt in explicitly so ordinary unit tests require no built artifact.
it.skipIf(!process.env.ORCA_OBJECT_RESOURCES)('consumes real WASM object packages and preserves native instance identities through dispatch', async () => {
  const directory = process.env.ORCA_OBJECT_RESOURCES!;
  const cases = await readdir(directory);
  expect(cases).toEqual(expect.arrayContaining(['two-instances', 'loaded-h2d', 'boundary-63', 'boundary-64', 'boundary-65']));
  for (const name of cases) {
    const path = join(directory, name), { count } = JSON.parse(await readFile(join(path, 'case.json'), 'utf8'));
    const xml = await readFile(join(path, 'slice_info.config')), png = await readFile(join(path, 'pick_1.png'));
    const f = fixture(); try {
      await f.monitor.start(target, 'view'); await f.push({ plate_idx: 1, s_obj: [] }, true);
      f.readResource.mockImplementation(async (_a, _s, _r, resource) => new Uint8Array(resource.endsWith('.png') ? png : xml));
      const snapshot = await f.read(); expect(snapshot.objects).toHaveLength(count);
      const image = await f.objects.readMap(snapshot.contextRef);
      expect(image.ok && image.value.bytes).toEqual(new Uint8Array(png));
      if (count > 64) {
        expect(snapshot.availability).toMatchObject({ kind: 'blocked' });
        expect(prepareCommand(await f.context(), f.command(snapshot))).toMatchObject({ ok: false, error: { code: 'out-of-range' } });
      } else {
        expect(snapshot.availability).toEqual({ kind: 'available' });
        const command = prepareCommand(await f.context(), f.command(snapshot, Array.from({ length: count - 1 }, (_, i) => i)));
        expect(command.ok).toBe(true);
        if (!command.ok || !image.ok) throw new Error('Missing integration result');
        expect(command.value.fields.obj_list).toEqual(image.value.palette.slice(0, -1).map(p => p.colourId));
        await f.push({ s_obj: [image.value.palette[0].colourId] }, true);
        expect((await f.context()).objects?.snapshot.skippedObjectIds).toMatchObject({ value: [snapshot.objects[0].id] });
      }
    } finally { await f.close(); }
  }
});

it('does not inherit a previous object skip report across job, plate or file transitions', async () => {
  for (const patch of [{ job_id: '13' }, { plate_idx: 3 }, { gcode_file: 'replacement.gcode.3mf' }]) {
    const f = fixture(); try {
      await f.monitor.start(target, 'view'); const previous = await f.read();
      await f.push({ s_obj: [7] }, true);
      await f.push({ ...patch, plate_idx: 'plate_idx' in patch ? patch.plate_idx : 2 }, true);
      if ('plate_idx' in patch) f.setXml(metadata().replace('value="2"', 'value="3"'));
      expect(prepareCommand(await f.context(), f.command(previous))).toMatchObject({ ok: false });
      const next = await f.read();
      expect(next.skippedObjectIds).toMatchObject({ kind: 'unknown' });
      expect(next.availability).toMatchObject({ kind: 'blocked' });
    } finally { await f.close(); }
  }
});
