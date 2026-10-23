import { expect, it, vi } from 'vitest';
import { BambuTelemetry } from './telemetry';
import { readCurrentPrintPreview } from './preview';
import type * as D from '@orca/printer-control/domain';
const target = { printerId: 'bambu:p' as D.Id<'printer'>, routeId: 'bambu:p:cloud' as D.Id<'route'> };
function fixture() {
  const telemetry = new BambuTelemetry();
  const push = (task = '123') => telemetry.accept(JSON.stringify({ print: { command: 'push_status', msg: 0, gcode_state: 'RUNNING', subtask_id: task } }));
  push();
  const identity: D.PrinterIdentity = { id: target.printerId, displayName: 'Printer', model: 'H2D', manufacturer: 'Bambu Lab', serialNumber: 'p', externalRefs: [] };
  const monitor = { acquire: vi.fn(async () => ({ ok: true as const, value: 'internal-read' })), stop: vi.fn(async () => ({ ok: true as const, value: null })),
    context: async () => ({ ok: true as const, value: { ...telemetry.project(target, identity), target, configurationRevision: 'r1', model: 'H2D' } }) };
  const native = { getSubtaskInfo: vi.fn(async () => ({ result: 0, httpCode: 200, body: JSON.stringify({ content: JSON.stringify({ info: { plate_idx: 2 } }), context: { plates: [
    { index: 1, thumbnail: { url: 'https://cdn.bambulab.com/wrong.png' } }, { index: 2, thumbnail: { url: 'https://cdn.bambulab.com/task.png?secret=signed' } },
  ] } }) })) };
  const image = () => new Response(new Uint8Array([137,80,78,71,13,10,26,10,1]), { headers: { 'content-type': 'image/png' } });
  return { push, monitor, native, image };
}
it('reads current task metadata without a UI watch and returns image bytes without signed URLs', async () => {
  const f = fixture(), fetchImage = vi.fn<typeof fetch>(async () => f.image());
  const result = await readCurrentPrintPreview(f.monitor, f.native, target, fetchImage);
  expect(f.native.getSubtaskInfo).toHaveBeenCalledWith('123');
  expect(String(fetchImage.mock.calls[0]?.[0])).toContain('/task.png');
  expect(result).toMatchObject({ ok: true, value: { ...target, taskId: '123', mimeType: 'image/png' } });
  expect(JSON.stringify(result)).not.toMatch(/secret|signed|https/); expect(f.monitor.stop).toHaveBeenCalledWith('internal-read');
});
it('discards a preview when the task changes during download', async () => {
  const f = fixture();
  const result = await readCurrentPrintPreview(f.monitor, f.native, target, async () => { f.push('456'); return f.image(); });
  expect(result).toMatchObject({ ok: false, error: { code: 'stale-context' } });
});
it('rejects private destinations, wrong image signatures and oversized responses', async () => {
  const f = fixture();
  f.native.getSubtaskInfo.mockResolvedValueOnce({ result: 0, httpCode: 200, body: JSON.stringify({ content: '{"info":{"plate_idx":1}}', context: { plates: [{ index: 1, thumbnail: { url: 'http://127.0.0.1/private' } }] } }) });
  const fetchImage = vi.fn<typeof fetch>(async () => f.image());
  expect(await readCurrentPrintPreview(f.monitor, f.native, target, fetchImage)).toMatchObject({ ok: false, error: { code: 'preview-unavailable' } });
  expect(fetchImage).not.toHaveBeenCalled();
  expect(await readCurrentPrintPreview(f.monitor, f.native, target, async () => new Response('html', { headers: { 'content-type': 'image/png' } }))).toMatchObject({ ok: false });
  expect(await readCurrentPrintPreview(f.monitor, f.native, target, async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } }))).toMatchObject({ ok: false, error: { code: 'out-of-range' } });
});
