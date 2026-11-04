import { createFile, type Sample } from 'mp4box';

export class StoredVideoError extends Error {}
const reject = () => new StoredVideoError('This file cannot be played progressively. Download it to use a system player.');
const MAX_HEADER = 8 * 1024 * 1024, MAX_SAMPLES = 200_000;
export interface VideoIndex { mimeType: string; durationSeconds: number; width: number; height: number }
export interface VideoFragment { bytes: Uint8Array; start: number; end: number; key: boolean }

/** Reject oversized sample-table declarations before the parser allocates sample arrays. */
function validateTables(bytes: Buffer, depth = 0) {
  if (depth > 8) throw reject();
  for (let at = 0; at < bytes.length;) {
    if (at + 8 > bytes.length) throw reject();
    const size = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8);
    if (size < 8 || at + size > bytes.length) throw reject();
    const body = bytes.subarray(at + 8, at + size);
    if (['trak', 'mdia', 'minf', 'stbl'].includes(type)) validateTables(body, depth + 1);
    if (type === 'stsz' || type === 'stz2') {
      if (body.length < 12 || body.readUInt32BE(8) > MAX_SAMPLES) throw reject();
    }
    if (type === 'stsd' && (body.length < 8 || body.readUInt32BE(4) !== 1)) throw reject();
    if (['stts', 'ctts', 'stsc', 'stco', 'co64', 'stss'].includes(type)) {
      if (body.length < 8 || body.readUInt32BE(4) > MAX_SAMPLES) throw reject();
      if (type === 'stts' || type === 'ctts') {
        let count = 0;
        for (let i = 0; i < body.readUInt32BE(4); i++) {
          if (8 + i * 8 + 8 > body.length || (count += body.readUInt32BE(8 + i * 8)) > MAX_SAMPLES) throw reject();
        }
      }
    }
    if (['mvex', 'sinf', 'encv'].includes(type)) throw reject();
    at += size;
  }
}

/** Fast-start, single AVC video track. No tail-moov/full-download fallback or invented timestamps. */
export class ProgressiveMp4 {
  private file = createFile(false);
  private header = Buffer.alloc(0);
  private offset = 0;
  private ready = false;
  private initialized = false;
  private samples: Sample[] = [];
  private emitted = 0;
  private timescale = 1;
  private fragments: VideoFragment[] = [];
  private fragmentBytes = 0;
  private initialization?: Uint8Array;
  private envelopeHeader = Buffer.alloc(0);
  private envelopeRemaining = 0;
  private sawMoov = false;
  index?: VideoIndex;
  constructor() {
    this.file.onError = () => { throw reject(); };
    this.file.onReady = info => {
      const track = info.videoTracks[0];
      if (info.isFragmented || !info.isProgressive || info.tracks.length !== 1 || !track?.video ||
        !/^avc1\.[\da-f]{6}$/i.test(track.codec) || track.video.width <= 0 || track.video.height <= 0 ||
        track.video.width > 8192 || track.video.height > 8192 || track.nb_samples > MAX_SAMPLES || track.timescale <= 0) throw reject();
      this.samples = this.file.getTrackSamplesInfo(track.id);
      let time = 0;
      if (!this.samples.length || !this.samples[0].is_sync) throw reject();
      for (const sample of this.samples) {
        if (sample.dts !== time || sample.cts !== sample.dts || sample.duration <= 0 || sample.size <= 0 ||
          sample.size > 4 * 1024 * 1024 || !('type' in sample.description) || sample.description.type !== 'avc1' || sample.description_index !== 0) throw reject();
        time += sample.duration;
        if (!Number.isSafeInteger(time)) throw reject();
      }
      this.timescale = track.timescale;
      this.index = { mimeType: `video/mp4; codecs="${track.codec}"`, durationSeconds: time / track.timescale,
        width: track.video.width, height: track.video.height };
      this.file.setSegmentOptions(track.id, undefined, { nbSamples: 1, nbSamplesPerFragment: 1, rapAlignement: false });
      this.initialization = new Uint8Array(this.file.initializeSegmentation().buffer);
      this.initialized = true; this.file.start();
    };
    this.file.onSegment = (id, _user, bytes, next) => {
      if (next !== this.emitted + 1 || bytes.byteLength > 4 * 1024 * 1024 + 4096) throw reject();
      this.fragmentBytes += bytes.byteLength;
      if (this.fragments.length >= 4096 || this.fragmentBytes > 8 * 1024 * 1024) throw reject();
      const sample = this.samples[this.emitted++];
      this.fragments.push({ bytes: new Uint8Array(bytes), start: sample.dts / this.timescale,
        end: (sample.dts + sample.duration) / this.timescale, key: sample.is_sync });
      this.file.releaseUsedSamples(id, next);
    };
  }
  push(bytes: Uint8Array): { init?: Uint8Array; fragments: VideoFragment[] } {
    if (bytes.length > 256 * 1024) throw new StoredVideoError('The media input chunk is too large.');
    // Bound every top-level non-media box, including boxes after moov. Otherwise
    // an unknown trailing box could accumulate the entire file inside a parser.
    for (let at = 0; at < bytes.length;) {
      if (this.envelopeRemaining) { const n = Math.min(this.envelopeRemaining, bytes.length - at); at += n; this.envelopeRemaining -= n; continue; }
      const count = Math.min(8 - this.envelopeHeader.length, bytes.length - at);
      this.envelopeHeader = Buffer.concat([this.envelopeHeader, bytes.subarray(at, at + count)]); at += count;
      if (this.envelopeHeader.length < 8) continue;
      const size = this.envelopeHeader.readUInt32BE(0), type = this.envelopeHeader.toString('ascii', 4);
      if (size < 8 || !['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide'].includes(type) || type !== 'mdat' && size > MAX_HEADER ||
        type === 'mdat' && !this.sawMoov || type === 'moov' && this.sawMoov) throw reject();
      if (type === 'moov') this.sawMoov = true;
      this.envelopeRemaining = size - 8; this.envelopeHeader = Buffer.alloc(0);
    }
    if (!this.ready) {
      this.header = Buffer.concat([this.header, bytes]);
      if (this.header.length > MAX_HEADER + 256 * 1024) throw reject();
      for (let at = 0; at + 8 <= this.header.length;) {
        const size = this.header.readUInt32BE(at), type = this.header.toString('ascii', at + 4, at + 8);
        if (at === 0 && type !== 'ftyp' || type === 'mdat' || size < 8 || size > MAX_HEADER) throw reject();
        if (at + size > this.header.length) break;
        if (type === 'moov') { validateTables(this.header.subarray(at + 8, at + size)); this.ready = true; break; }
        at += size;
      }
      if (!this.ready) return { fragments: [] };
      bytes = this.header; this.header = Buffer.alloc(0);
    }
    const buffer = Object.assign(Uint8Array.from(bytes).buffer, { fileStart: this.offset });
    this.offset += bytes.length;
    this.file.appendBuffer(buffer);
    const result = { init: this.initialization, fragments: this.fragments };
    this.initialization = undefined; this.fragments = []; this.fragmentBytes = 0; return result;
  }
  finish() {
    // Never flush a partial sample into a success; length/MD5 is also checked by the provider iterator.
    if (!this.initialized || this.emitted !== this.samples.length || this.envelopeRemaining || this.envelopeHeader.length) throw reject();
  }
  close() { this.file.stop(); this.file = createFile(false); this.samples = []; this.fragments = []; this.header = Buffer.alloc(0); }
}
