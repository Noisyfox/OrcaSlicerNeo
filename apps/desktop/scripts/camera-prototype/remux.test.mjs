import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTimes, avcConfiguration } from './remux.mjs';

test('100ns arrival ticks normalize without confusing them with microseconds', () => {
  assert.deepEqual(normalizeTimes([{ flags: 1, time100ns: '50000000' }, { flags: 0, time100ns: '50333333' }, { flags: 0, time100ns: '50666666' }]), [0, 0.0333333, 0.0666666]);
});
test('timestamp discontinuities and missing initial IDR fail before muxing', () => {
  const first = { flags: 1, time100ns: '1000' };
  for (const tick of ['999', '1000', '10001001']) assert.throws(() => normalizeTimes([first, { flags: 0, time100ns: tick }]), /generation/);
  assert.throws(() => normalizeTimes([{ flags: 0, time100ns: '0' }]), /IDR/);
});
test('new generation starts a fresh origin without requiring clock continuity', () => {
  assert.deepEqual(normalizeTimes([{ flags: 1, time100ns: '5' }, { flags: 0, time100ns: '100005' }]), [0, 0.01]);
});
test('unknown codec configuration is not silently treated as baseline no-reordering AVC', () => {
  assert.throws(() => avcConfiguration(Buffer.from([0, 0, 1, 0x65]), 320, 180), /SPS/);
  assert.throws(() => avcConfiguration(Buffer.from([0, 0, 1, 0x67, 100, 0, 31, 0, 0, 1, 0x68, 0]), 320, 180), /baseline/);
});
