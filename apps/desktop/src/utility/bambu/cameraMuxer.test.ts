import { expect, it } from 'vitest';
import type { MediaStreamPacket } from '@orca/printer-control/domain';
import { CameraMuxer } from './cameraMuxer';

// SPS/PPS from the generated 320x180 baseline fixture; slices below exercise admission only.
const parameters = Buffer.from('000000012742000d898a140a0cfcf35010d010784021150000000128ce3c80', 'hex');
const key = Buffer.concat([parameters, Buffer.from([0, 0, 1, 0x65, 0xb8])]);
const delta = Buffer.from([0, 0, 1, 0x41, 0xe0]); // first_mb=0, P slice
const sample = (i: number, bytes = i ? delta : key) => ({ bytes, flags: bytes === key ? 1 : 0, time100ns: BigInt(i) * 333333n });

it('emits continuous fragments before a second keyframe with a bounded sample window', () => {
  const packets: MediaStreamPacket[] = [], mux = new CameraMuxer(320, 180, p => packets.push(p));
  for (let i = 0; i < 14; i++) mux.push(sample(i));
  expect(packets[0].kind).toBe('init');
  expect(packets.filter(p => p.kind === 'segment').length).toBeGreaterThanOrEqual(1);
  expect(packets.map(p => p.sequence)).toEqual(packets.map((_, i) => i));
  expect(packets[1].bytes.length).toBeLessThan(5000);
});
it('clock discontinuity discards dependent frames until a new IDR generation', () => {
  const packets: MediaStreamPacket[] = [], mux = new CameraMuxer(320, 180, p => packets.push(p));
  for (let i = 0; i < 10; i++) mux.push(sample(i));
  const before = packets.length;
  mux.push(sample(0, delta)); mux.push(sample(1, delta)); expect(packets).toHaveLength(before);
  mux.push(sample(2, key)); expect(packets.at(-1)).toMatchObject({ kind: 'init', generation: 1, sequence: 0 });
});
it('B slices are rejected rather than inventing presentation timestamps', () => {
  const mux = new CameraMuxer(320, 180, () => {}); mux.push(sample(0));
  expect(() => mux.push(sample(1, Buffer.from([0, 0, 1, 0x41, 0xa8])))).toThrow('Reordered');
});
it('does not start with dependent frames and rejects invalid dimensions', () => {
  const packets: MediaStreamPacket[] = [], mux = new CameraMuxer(320, 180, p => packets.push(p));
  mux.push(sample(0, delta)); expect(packets).toEqual([]);
  expect(() => new CameraMuxer(0, 180, () => {})).toThrow('dimensions');
});
