import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as D from '@orca/printer-control/domain';
import type { BambuNative, NativePrintResult, NativePrintParameters } from '@orca/bambu-native';
import type { BambuMonitor } from './monitor';
import type { BambuDevices } from './devices';
import type { BambuRepository } from './repository';
import { BambuPrintSubmissions } from './printSubmission';
import { printContext, printRequest, printTarget } from './printFixtures';
import { prepareBambuPrint } from './printValidation';
import { id } from './telemetry';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(cloud = false, timelapse = false, recordingSpaceAction?: D.PrintSubmissionRequest['recordingSpaceAction'], initial?: { context: ReturnType<typeof printContext>; input: D.PrintPreparationRequest }) {
  const directory = await mkdtemp(join(tmpdir(), 'neo-print-test-'));
  let context = initial?.context ?? printContext();
  let complete!: (result: NativePrintResult) => void;
  const native = { installDeviceCertificate: vi.fn(async () => undefined), connectPrinter: vi.fn(async () => 0),
    startPrint: vi.fn((_route: string, _params: NativePrintParameters) => new Promise<NativePrintResult>(resolve => { complete = resolve; })), cancelPrint: vi.fn(() => true) };
  const commands = vi.fn(async (_section: string, _fields: Record<string, unknown>, _qos: number) => 0);
  const monitor = { context: vi.fn(async () => ({ ok: true as const, value: context })), read: vi.fn(async () => ({ ok: false as const, error: { code: 'offline', message: 'No fixture response' } })), acquire: vi.fn(async () => ({ ok: true as const, value: 'lease' })), stop: vi.fn(async () => undefined),
    dispatch: vi.fn(async (_target, fn) => fn(context, commands)) };
  const devices = { list: vi.fn(async () => [{ deviceId: 'fixture', name: 'H2D', routes: [{ channel: 'lan', revision: 'r1' }, ...(cloud ? [{ channel: 'cloud', revision: 'c1' }] : [])] }]) };
  const repository = { read: vi.fn(async () => ({ lan: [{ deviceId: 'fixture', revision: 'r1', ip: '127.0.0.1', accessCode: 'fixture-only' }] })) };
  const service = new BambuPrintSubmissions(native as unknown as BambuNative, monitor as unknown as BambuMonitor, devices as unknown as BambuDevices, repository as unknown as BambuRepository, directory, vi.fn());
  cleanups.push(async () => { complete?.({ code: -18, mayHaveStarted: false, cancelRequested: true }); await service.close(); await rm(directory, { recursive: true, force: true }); });
  const input = initial?.input ?? printRequest(); input.options.timelapse = timelapse;
  const prepared = prepareBambuPrint(input, context, 'lan');
  const request = { ...input, recordingSpaceAction, bindings: prepared.bindings, requestId: id<'request'>('request'), jobName: '测试 Cube', acknowledgedIssues: prepared.issues.filter(i => i.severity === 'warning').map(i => i.id) };
  const artifacts = (['print', 'configuration'] as const).map(role => ({ role, fileName: 'Cube_PETG_1h35m.gcode.3mf', sizeBytes: 1 }));
  const begin = await service.begin({ request, artifacts }); if (!begin.ok) throw new Error(begin.error.message);
  const ref = begin.value.ref;
  const state = () => { const result = service.get(ref); if (!result.ok) throw new Error(result.error.message); return result.value; };
  const send = async () => { for (const artifact of artifacts) expect(await service.chunk({ ref, role: artifact.role, offset: 0, bytes: new Uint8Array([1]) })).toEqual({ ok: true, value: null }); await service.commit(ref); await vi.waitFor(() => expect(native.startPrint).toHaveBeenCalled()); };
  const push = async (patch: Record<string, unknown>, channel: 'local-message' | 'message' = 'local-message', deviceId = 'fixture') => {
    const generation = context.generation + 1;
    context = printContext({ ...context.report, ...patch }); context.generation = generation;
    await service.onEvent({ type: channel, args: [deviceId, JSON.stringify({ print: { command: 'push_status', ...patch } })] });
  };
  return { service, native, monitor, devices, repository, commands, request, artifacts, ref, state, send, push, directory, update: (next: typeof context) => { context = next; }, complete: (result: NativePrintResult) => complete(result) };
}
function singleTool(model: string, patch: Record<string, unknown> = {}) {
  const context = printContext({ device: {}, cfg: undefined, nozzle_temper: 25, nozzle_target_temper: 0, nozzle_type: 'hardened_steel', nozzle_diameter: .4, ...patch });
  context.model = model;
  context.values.firmware = [{ name: 'ota', version: '01.01.50.01' }];
  const input = printRequest();
  input.requirements = { ...input.requirements, printerModel: model, printerModelId: model, nozzleDiameters: [.4], nozzleFlowTypes: ['Standard'], filamentMap: [1], materials: [{ ...input.requirements.materials[0], toolIndex: 0 }] };
  return { context, input };
}
it.each(['N1', 'N2S'])('uses the pinned %s Cloud-only default for preparation and sending', async model => {
  const initial = singleTool(model), f = await fixture(true, false, undefined, initial);
  expect(await f.service.prepare(initial.input)).toMatchObject({ ok: true, value: { route: 'cloud' } });
  await f.send();
  expect(f.native.connectPrinter).not.toHaveBeenCalled();
  expect(f.native.startPrint.mock.calls[0][0]).toBe('cloud');
  f.complete({ code: 0, mayHaveStarted: true, cancelRequested: false });
  await vi.waitFor(() => expect(f.state().phase).toBe('sent'));
});
it.each([
  { support_cloud_print_only: false },
  { capabilities: { flags: { support_cloud_print_only: false } } },
])('lets explicit reported false override the model Cloud-only default: %j', async patch => {
  const initial = singleTool('N1', patch), f = await fixture(true, false, undefined, initial);
  expect(await f.service.prepare(initial.input)).toMatchObject({ ok: true, value: { route: 'lan' } });
  await f.send(); expect(f.native.startPrint.mock.calls[0][0]).toBe('lan');
});
it.each([
  { support_cloud_print_only: true },
  { capabilities: { flags: { support_cloud_print_only: true } } },
])('applies reported Cloud-only support and rechecks it at sending: %j', async patch => {
  const f = await fixture(true); f.update(printContext(patch));
  expect(await f.service.prepare(printRequest())).toMatchObject({ ok: true, value: { route: 'cloud' } });
  await f.send(); expect(f.native.startPrint.mock.calls[0][0]).toBe('cloud');
  expect(f.native.connectPrinter).not.toHaveBeenCalled();
});
it('keeps a LAN-only device local even when its model defaults to Cloud-only', async () => {
  const initial = singleTool('N1'), f = await fixture(false, false, undefined, initial);
  expect(await f.service.prepare(initial.input)).toMatchObject({ ok: true, value: { route: 'lan' } });
  await f.send(); expect(f.native.startPrint.mock.calls[0][0]).toBe('lan');
});
it('retains the sending snapshot when device state and connection data change during LAN connection, like Orca', async () => {
  const f = await fixture(true);
  f.devices.list.mockClear(); f.repository.read.mockClear(); f.monitor.context.mockClear();
  f.native.connectPrinter.mockImplementation(async () => {
    const context = printContext({ support_cloud_print_only: true, gcode_state: 'RUNNING' });
    context.configurationRevision = 'r2'; context.fresh = false; f.update(context);
    f.repository.read.mockResolvedValue({ lan: [{ deviceId: 'fixture', revision: 'r2', ip: '192.0.2.2', accessCode: 'replacement-fixture' }] });
    return 0;
  });
  await f.send();
  expect(f.native.startPrint.mock.calls[0][0]).toBe('lan');
  expect(f.native.startPrint.mock.calls[0][1]).toMatchObject({ dev_ip: '127.0.0.1', password: 'fixture-only' });
  expect(f.devices.list).toHaveBeenCalledOnce(); expect(f.repository.read).toHaveBeenCalledOnce();
  expect(f.monitor.context).toHaveBeenCalledOnce(); expect(f.monitor.dispatch).not.toHaveBeenCalled();
  f.complete({ code: 0, mayHaveStarted: true, cancelRequested: false });
  await vi.waitFor(() => expect(f.state()).toMatchObject({ phase: 'sent', route: 'lan' }));
});
it.each([0, -1])('cancels during LAN connection (result %i) without starting or falling back to Cloud', async code => {
  const f = await fixture(true);
  f.native.connectPrinter.mockImplementation(async () => { await f.service.cancel(f.ref); return code; });
  for (const artifact of f.artifacts) await f.service.chunk({ ref: f.ref, role: artifact.role, offset: 0, bytes: new Uint8Array([1]) });
  await f.service.commit(f.ref);
  await vi.waitFor(() => expect(f.state().phase).toBe('cancelled'));
  expect(f.native.startPrint).not.toHaveBeenCalled();
  expect(f.monitor.stop).toHaveBeenCalledWith('lease'); expect(await readdir(f.directory)).toEqual([]);
});
it('deduplicates admission, rejects conflicting request identities and out-of-order chunks, and cancels before dispatch', async () => {
  const f = await fixture();
  expect(await f.service.begin({ request: f.request, artifacts: f.artifacts })).toEqual({ ok: true, value: { ref: f.ref, created: false } });
  expect((await f.service.begin({ request: { ...f.request, options: {} }, artifacts: f.artifacts })).ok).toBe(false);
  expect((await f.service.chunk({ ref: f.ref, role: 'print', offset: 1, bytes: new Uint8Array([1]) })).ok).toBe(false);
  expect((await f.service.commit(f.ref)).ok).toBe(false);
  await f.service.cancel(f.ref);
  expect(f.state().phase).toBe('cancelled'); expect(f.native.startPrint).not.toHaveBeenCalled();
  expect(await readdir(f.directory)).toEqual([]); expect(f.monitor.stop).toHaveBeenCalledWith('lease');
});
it('keeps cancellation pending until the plugin confirms that no start occurred', async () => {
  const f = await fixture(); await f.send(); await f.service.cancel(f.ref);
  expect(f.state().phase).toBe('cancelling'); expect(f.native.cancelPrint).toHaveBeenCalledOnce();
  f.complete({ code: -18, mayHaveStarted: false, cancelRequested: true });
  await vi.waitFor(() => expect(f.state().phase).toBe('cancelled'));
});
it.each([0, 1])('completes sending on plugin success %i without matching filenames or task telemetry', async code => {
  const f = await fixture(); await f.send();
  const params = f.native.startPrint.mock.calls[0][1];
  expect(params.task_name).toBe('测试 Cube');
  expect(params.project_name).toBe('测试 Cube');
  expect(params.preset_name).toBe('测试 Cube_plate_1');
  expect(params.ftp_file).toMatch(/^Neo_[a-f0-9]+\.gcode\.3mf$/);
  if (code === 1) await f.push({ gcode_state: 'RUNNING', subtask_name: params.task_name, gcode_file: '/测试 Cube.gcode.3mf' });
  expect(f.state().phase).toBe('sending'); // A report cannot finish an outstanding native call.
  expect(await readdir(f.directory)).not.toEqual([]);
  f.complete({ code, mayHaveStarted: code === 0, cancelRequested: false });
  await vi.waitFor(() => expect(f.state()).toMatchObject({ phase: 'sent', message: 'Print job sent.', canCancel: false }));
  await vi.waitFor(async () => expect(await readdir(f.directory)).toEqual([]));
  expect(f.monitor.stop).toHaveBeenCalledWith('lease');
  expect(f.monitor.read).not.toHaveBeenCalled();
});
it('Cloud send success also finishes without device start confirmation', async () => {
  const f = await fixture(true); f.native.connectPrinter.mockResolvedValue(-1); await f.send();
  f.complete({ code: 0, mayHaveStarted: true, cancelRequested: false });
  await vi.waitFor(() => expect(f.state()).toMatchObject({ route: 'cloud', phase: 'sent' }));
  expect(f.native.startPrint).toHaveBeenCalledOnce();
});
it.each([{ code: 0, phase: 'sent' }, { code: -18, phase: 'unknown' }] as const)(
  'keeps cancellation racing possible dispatch until native outcome $code', async ({ code, phase }) => {
    const f = await fixture(); await f.send(); await f.service.cancel(f.ref);
    expect(f.state().phase).toBe('cancelling');
    await f.service.onEvent({ type: 'print-progress', args: [2, 0, true] });
    expect(f.state()).toMatchObject({ phase: 'sending', canCancel: false });
    f.complete({ code, mayHaveStarted: true, cancelRequested: true });
    await vi.waitFor(() => expect(f.state().phase).toBe(phase));
    expect(f.native.startPrint).toHaveBeenCalledOnce();
  },
);
it('releases an unknown send without retrying or cancelling a possible physical print', async () => {
  const f = await fixture(true); await f.send();
  await f.service.onEvent({ type: 'print-progress', args: [3, 0, true] });
  await f.service.cancel(f.ref); expect(f.native.cancelPrint).not.toHaveBeenCalled();
  f.complete({ code: -1, mayHaveStarted: true, cancelRequested: false });
  await vi.waitFor(() => expect(f.state().phase).toBe('unknown'));
  await f.push({ gcode_state: 'RUNNING', subtask_name: f.request.jobName, gcode_file: '/测试 Cube.gcode.3mf' });
  expect(f.state().phase).toBe('unknown');
  expect(f.native.startPrint).toHaveBeenCalledOnce();
  expect(await readdir(f.directory)).toEqual([]);
  expect(f.monitor.stop).toHaveBeenCalledWith('lease');
  expect(await f.service.begin({ request: f.request, artifacts: f.artifacts })).toEqual({ ok: true, value: { ref: f.ref, created: false } });
  f.update(printContext());
  expect(await f.service.prepare(printRequest())).toMatchObject({ ok: true, value: { issues: expect.not.arrayContaining([expect.objectContaining({ id: 'submission-busy' })]) } });
  f.devices.list.mockResolvedValueOnce([{ deviceId: 'another', name: 'Another', routes: [{ channel: 'cloud', revision: 'c1' }] }]);
  const another = await f.service.begin({ request: { ...f.request, target: { printerId: id('bambu:another'), routeId: id('bambu:another:agent') }, requestId: id('another') }, artifacts: f.artifacts });
  expect(another, JSON.stringify(another)).toMatchObject({ ok: true, value: { created: true } });
  expect(f.state().phase).toBe('unknown');
});
it('also releases the connection and artifacts when the native send rejects', async () => {
  const f = await fixture();
  f.native.startPrint.mockRejectedValueOnce(new Error('Connection interrupted'));
  await f.send();
  await vi.waitFor(() => expect(f.state()).toMatchObject({ phase: 'unknown', canCancel: false, progress: null }));
  expect(await readdir(f.directory)).toEqual([]);
  expect(f.monitor.stop).toHaveBeenCalledWith('lease');
  expect(f.native.startPrint).toHaveBeenCalledOnce();
});
it('known LAN connection failure may fall back to Cloud before invoking print', async () => {
  const f = await fixture(true); f.native.connectPrinter.mockResolvedValue(-1); await f.send();
  expect(f.native.startPrint.mock.calls[0][0]).toBe('cloud');
  f.complete({ code: -6010, mayHaveStarted: false, cancelRequested: false });
  await vi.waitFor(() => expect(f.state().phase).toBe('failed'));
});
it('reuses prepared print parameters for a known non-start LAN failure followed by Cloud', async () => {
  const f = await fixture(true);
  f.native.startPrint.mockResolvedValueOnce({ code: -6010, mayHaveStarted: false, cancelRequested: false });
  f.monitor.context.mockClear(); f.devices.list.mockClear(); f.repository.read.mockClear();
  await f.send(); await vi.waitFor(() => expect(f.native.startPrint).toHaveBeenCalledTimes(2));
  const [local, cloud] = f.native.startPrint.mock.calls;
  expect([local[0], cloud[0]]).toEqual(['lan', 'cloud']);
  expect(cloud[1]).toEqual({ ...local[1], connection_type: 'cloud', dev_ip: '', password: '' });
  expect(f.monitor.context).toHaveBeenCalledOnce(); expect(f.devices.list).toHaveBeenCalledOnce(); expect(f.repository.read).toHaveBeenCalledOnce();
  f.complete({ code: 0, mayHaveStarted: true, cancelRequested: false });
  await vi.waitFor(() => expect(f.state()).toMatchObject({ phase: 'sent', route: 'cloud' }));
});
it('validates changed readiness when sending begins without falling back or starting a job', async () => {
  const f = await fixture(true); f.update(printContext({ gcode_state: 'RUNNING' }));
  for (const artifact of f.artifacts) await f.service.chunk({ ref: f.ref, role: artifact.role, offset: 0, bytes: new Uint8Array([1]) });
  await f.service.commit(f.ref); await vi.waitFor(() => expect(f.state().phase).toBe('failed'));
  expect(f.native.startPrint).not.toHaveBeenCalled();
});
async function commitRecording(f: Awaited<ReturnType<typeof fixture>>) {
  for (const artifact of f.artifacts) await f.service.chunk({ ref: f.ref, role: artifact.role, offset: 0, bytes: new Uint8Array([1]) });
  await f.service.commit(f.ref);
  await vi.waitFor(() => expect(f.commands).toHaveBeenCalled());
}
async function capacityReply(f: Awaited<ReturnType<typeof fixture>>, enough: boolean) {
  const query = f.commands.mock.calls.find(c => c[1].command === 'ipcam_get_media_info')![1];
  await f.service.onEvent({ type: 'local-message', args: ['fixture', JSON.stringify({ camera: { ...query, result: 0, is_enough: enough, file_count: 2 } })] });
}
it('insufficient recording space does not delete videos without this submission authorization', async () => {
  const f = await fixture(false, true); await commitRecording(f); await capacityReply(f, false);
  await vi.waitFor(() => expect(f.state().phase).toBe('failed'));
  expect(f.commands.mock.calls.some(c => c[1].command === 'ipcam_delete_oldest_timelapse')).toBe(false); expect(f.native.startPrint).not.toHaveBeenCalled();
});
it('explicit cleanup authorization sends oldest-video cleanup before native printing', async () => {
  const f = await fixture(false, true, 'clean-oldest'); await commitRecording(f); await capacityReply(f, false);
  await vi.waitFor(() => expect(f.native.startPrint).toHaveBeenCalledOnce());
  expect(f.commands.mock.calls.map(c => c[1].command)).toEqual(['ipcam_get_media_info', 'ipcam_delete_oldest_timelapse']);
  f.complete({ code: -6010, mayHaveStarted: false, cancelRequested: false });
});
it('cancelling while recording space is queried never starts the printer', async () => {
  const f = await fixture(false, true, 'clean-oldest'); await commitRecording(f); await f.service.cancel(f.ref); await capacityReply(f, false);
  await vi.waitFor(() => expect(f.state().phase).toBe('cancelled')); expect(f.native.startPrint).not.toHaveBeenCalled();
  expect(f.commands.mock.calls.some(c => c[1].command === 'ipcam_delete_oldest_timelapse')).toBe(false);
});
