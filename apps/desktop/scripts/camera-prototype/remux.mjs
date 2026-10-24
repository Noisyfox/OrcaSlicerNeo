// Prototype only. Its timing admission is limited to verified no-reordering input.
import { EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, NullTarget, Output } from 'mediabunny';
import { annexBNals } from './rtsp-fixture.mjs';

export function normalizeTimes(samples) {
  if (!samples.length || !(samples[0].flags & 1)) throw new Error('Timeline must start on an IDR');
  const origin = BigInt(samples[0].time100ns);
  return samples.map((sample, i) => {
    const time = BigInt(sample.time100ns);
    if (i) {
      const delta = time - BigInt(samples[i - 1].time100ns);
      if (delta <= 0n) throw new Error('Timestamp regression/duplicate requires a new generation');
      if (delta > 10_000_000n) throw new Error('Long timestamp gap requires a new generation');
    }
    return Number(time - origin) / 10_000_000;
  });
}

export function avcConfiguration(bytes, width, height) {
  const nals = annexBNals(bytes), sps = nals.find(n => (n[0] & 31) === 7), pps = nals.find(n => (n[0] & 31) === 8);
  if (!sps || !pps) throw new Error('Missing SPS/PPS at initial IDR');
  // The generated baseline fixture cannot contain B slices. Broader profiles
  // require a real PTS/reordering policy, not an assertion that DTS equals PTS.
  if (sps[1] !== 66) throw new Error('Probe admits baseline AVC fixtures only');
  const u16 = n => Buffer.from([n >> 8, n & 255]);
  return { codec: `avc1.${sps.subarray(1, 4).toString('hex')}`, codedWidth: width, codedHeight: height,
    description: Buffer.concat([Buffer.from([1, sps[1], sps[2], sps[3], 255, 225]), u16(sps.length), sps, Buffer.from([1]), u16(pps.length), pps]) };
}

function avcc(bytes) {
  return Buffer.concat(annexBNals(bytes).filter(n => ![7, 8, 9].includes(n[0] & 31)).map(nal => {
    const length = Buffer.alloc(4); length.writeUInt32BE(nal.length); return Buffer.concat([length, nal]);
  }));
}

export async function createRemuxer(config, onSegment) {
  let ftyp, moof, fragmentStart = 0, inputIndex = -1;
  const source = new EncodedVideoPacketSource('avc');
  const fragments = [];
  const output = new Output({ target: new NullTarget(), format: new Mp4OutputFormat({
    fastStart: 'fragmented', minimumFragmentDuration: 0.2,
    onFtyp: bytes => { ftyp = Buffer.from(bytes); },
    onMoov: bytes => onSegment(Buffer.concat([ftyp, bytes]), { kind: 'init', atMs: Date.now(), inputIndex }),
    onMoof: (bytes, _position, timestamp) => { moof = Buffer.from(bytes); fragmentStart = timestamp; },
    onMdat: bytes => {
      const meta = { kind: 'media', atMs: Date.now(), inputIndex, timestamp: fragmentStart };
      fragments.push(meta); onSegment(Buffer.concat([moof, bytes]), meta);
    },
  }) });
  output.addVideoTrack(source); await output.start();
  return {
    fragments,
    async add(sample, timestamp, duration, index) {
      inputIndex = index;
      await source.add(new EncodedPacket(avcc(sample.bytes), sample.flags & 1 ? 'key' : 'delta', timestamp, duration, index),
        index === 0 ? { decoderConfig: config } : undefined);
    },
    async finish() { source.close(); await output.finalize(); },
    async cancel() { await output.cancel(); },
  };
}
