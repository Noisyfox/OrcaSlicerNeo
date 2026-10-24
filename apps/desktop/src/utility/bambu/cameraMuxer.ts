/** Continuous AVC fragments may start between IDRs, but only within the same decoder generation. */
import { createFile, DataStream } from 'mp4box';
import type { NativeCameraSample } from '@orca/bambu-native';
import type { MediaStreamPacket } from '@orca/printer-control/domain';

export function cameraNals(bytes: Uint8Array): Uint8Array[] {
  const starts: { start: number; data: number }[] = [];
  for (let i = 0; i + 2 < bytes.length; i++) if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
    starts.push({ start: i > 0 && bytes[i - 1] === 0 ? i - 1 : i, data: i + 3 }); i += 2;
  }
  return starts.map((item, i) => bytes.slice(item.data, starts[i + 1]?.start ?? bytes.length));
}
const concat = (parts: readonly Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; } return result;
};
const length = (n: number, size: number) => { const bytes = new Uint8Array(size); for (let i = 0; i < size; i++) bytes[size - i - 1] = n >>> (8 * i); return bytes; };
function sliceType(nal: Uint8Array): number {
  // RBSP removes emulation-prevention bytes before reading first_mb_in_slice/slice_type.
  const data: number[] = [];
  for (let i = 1; i < nal.length; i++) { if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue; data.push(nal[i]); }
  let bit = 0;
  const read = () => { if (bit >= data.length * 8) throw new Error('Invalid AVC slice'); return (data[bit >> 3] >> (7 - (bit++ & 7))) & 1; };
  const ue = () => { let zeros = 0; while (!read()) if (++zeros > 24) throw new Error('Invalid AVC slice'); let value = 1; for (let i = 0; i < zeros; i++) value = value * 2 + read(); return value - 1; };
  ue(); return ue() % 5;
}

export class CameraMuxer {
  private sps?: Uint8Array;
  private pps?: Uint8Array;
  private config?: Uint8Array<ArrayBuffer>;
  private pending?: { sample: NativeCameraSample; time: number; data: Uint8Array<ArrayBuffer> };
  private origin = 0n;
  private last = -1n;
  private sequence = 0;
  private generation = -1;
  private moofSequence = 0;
  private chunk: { data: Uint8Array<ArrayBuffer>; time: number; duration: number; key: boolean }[] = [];
  private chunkBytes = 0;
  private lastDuration = 0;
  mimeType = '';
  constructor(private readonly width: number, private readonly height: number, private readonly emit: (packet: MediaStreamPacket) => void) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 8192 || height > 8192) throw new Error('Unsupported camera dimensions');
  }
  private builder() {
    const file = createFile();
    const id = file.addTrack({ id: 1, type: 'avc1', timescale: 1_000_000, width: this.width, height: this.height,
      avcDecoderConfigRecord: this.config!.buffer, brands: ['iso6', 'isom', 'avc1'] });
    // The typed low-level builder normally makes its first sample time zero. Each
    // bounded chunk here is part of an existing generation, so retain absolute DTS.
    file.getTrackById(id).first_dts = 0; file.nextMoofNumber = this.moofSequence;
    return { file, id };
  }
  private flush() {
    if (!this.chunk.length) return;
    const { file, id } = this.builder();
    for (const sample of this.chunk) file.addSample(id, sample.data, { dts: sample.time, cts: sample.time, duration: sample.duration, is_sync: sample.key });
    const stream = new DataStream();
    for (const box of file.boxes) if (box.type === 'moof' || box.type === 'mdat') box.write(stream);
    this.moofSequence = file.nextMoofNumber;
    this.emit({ kind: 'segment', generation: this.generation, sequence: this.sequence++, bytes: new Uint8Array(stream.buffer) });
    this.chunk = []; this.chunkBytes = 0;
  }
  /** Finite fixture/file drain only; a stopped live view discards its pending tail. */
  finish() {
    if (this.pending && this.lastDuration > 0) {
      this.chunk.push({ data: this.pending.data, time: this.pending.time, duration: this.lastDuration, key: !!(this.pending.sample.flags & 1) });
      this.pending = undefined;
    }
    this.flush();
  }

  push(sample: NativeCameraSample) {
    if (sample.bytes.length > 4 * 1024 * 1024) throw new Error('Oversized AVC frame');
    const nals = cameraNals(sample.bytes);
    const nextSps = nals.find(n => (n[0] & 31) === 7), nextPps = nals.find(n => (n[0] & 31) === 8);
    const same = (a: Uint8Array | undefined, b: Uint8Array | undefined) => !b || !!a && a.length === b.length && a.every((v, i) => v === b[i]);
    const changed = !same(this.sps, nextSps) || !same(this.pps, nextPps);
    if (nextSps) this.sps = nextSps; if (nextPps) this.pps = nextPps;
    const slices = nals.filter(n => [1, 5].includes(n[0] & 31));
    if (!slices.length || slices.some(n => sliceType(n) === 1) || nals.some(n => [2, 3, 4, 20, 21].includes(n[0] & 31))) throw new Error('Reordered or unsupported AVC stream');
    const key = slices.some(n => (n[0] & 31) === 5);
    const gap = this.last >= 0n && (sample.time100ns <= this.last || sample.time100ns - this.last > 10_000_000n);
    if (changed || gap) { this.pending = undefined; this.chunk = []; this.chunkBytes = 0; this.config = undefined; }
    this.last = sample.time100ns;
    if (!this.config) {
      if (!key) return; // Resynchronize only at IDR after a clock/configuration discontinuity.
      if (!this.sps || this.sps.length < 4 || !this.pps || this.sps.length > 65535 || this.pps.length > 65535) throw new Error('Missing AVC parameter sets');
      this.config = concat([new Uint8Array([1, this.sps[1], this.sps[2], this.sps[3], 255, 225]), length(this.sps.length, 2), this.sps, new Uint8Array([1]), length(this.pps.length, 2), this.pps]);
      this.mimeType = `video/mp4; codecs="avc1.${[...this.sps.slice(1, 4)].map(n => n.toString(16).padStart(2, '0')).join('')}"`;
      this.generation++; this.sequence = 0; this.moofSequence = 0; this.origin = sample.time100ns;
      const { file } = this.builder();
      this.emit({ kind: 'init', generation: this.generation, sequence: this.sequence++, mimeType: this.mimeType, bytes: new Uint8Array(file.getBuffer().buffer) });
    }
    const time = Number((sample.time100ns - this.origin) / 10n);
    if (!Number.isSafeInteger(time) || time < 0) throw new Error('Invalid AVC timeline');
    if (this.pending) {
      const previous = this.pending, duration = time - previous.time;
      this.lastDuration = duration;
      if (duration <= 0) throw new Error('Invalid AVC sample duration');
      this.chunk.push({ data: previous.data, time: previous.time, duration, key: !!(previous.sample.flags & 1) });
      this.chunkBytes += previous.data.length;
      if (this.chunkBytes > 8 * 1024 * 1024) throw new Error('AVC mux buffer exceeded');
      if (time - this.chunk[0].time >= 200_000 || this.chunk.length >= 32) this.flush();
    }
    const data = concat(nals.filter(n => ![7, 8, 9].includes(n[0] & 31)).flatMap(n => [length(n.length, 4), n]));
    this.pending = { sample: { ...sample, flags: key ? 1 : 0 }, data, time };
  }
}
