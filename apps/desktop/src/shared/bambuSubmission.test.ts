import { expect, it } from 'vitest';
import { isBambuControlRequest } from './bambuControl';
import { printRequest, printTarget } from '../utility/bambu/printFixtures';
const request = (input = printRequest()) => ({ method: 'print.prepare', input });
it('accepts bounded structured preparation and rejects malformed material/tool relationships', () => {
  expect(isBambuControlRequest(request())).toBe(true);
  const r = printRequest(); r.requirements.materials[0].index = 63;
  expect(isBambuControlRequest(request(r))).toBe(false);
  const unknown = printRequest(); unknown.requirements.materials[0].requiredNozzleHardness = NaN;
  expect(isBambuControlRequest(request(unknown))).toBe(false);
});
it('bounds binary chunks and does not accept paths, arrays or credentials as chunk data', () => {
  const base = { method: 'print.chunk', input: { ref: { ...printTarget, id: 'job' }, role: 'print', offset: 0, bytes: new Uint8Array([1]) } };
  expect(isBambuControlRequest(base)).toBe(true);
  for (const bytes of [[], '/tmp/file', new Uint8Array(256 * 1024 + 1), new Uint8Array(0)]) expect(isBambuControlRequest({ ...base, input: { ...base.input, bytes } })).toBe(false);
});
it('requires exactly one print and one configuration artifact with bounded size and no path', () => {
  const { suggest: _suggest, ...r } = printRequest();
  const input = { request: { ...r, requestId: 'request', acknowledgedIssues: [] }, artifacts: [{ role: 'print', fileName: 'file.3mf', sizeBytes: 10 }, { role: 'configuration', fileName: 'config.3mf', sizeBytes: 10 }] };
  expect(isBambuControlRequest({ method: 'print.begin', input })).toBe(true);
  input.artifacts[1].fileName = '../host-path.3mf'; expect(isBambuControlRequest({ method: 'print.begin', input })).toBe(false);
});
