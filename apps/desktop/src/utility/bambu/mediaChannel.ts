import type { MediaStreamPacket } from '@orca/printer-control/domain';
import type { BambuMediaMessage } from '../../shared/bambuMedia';
export interface CameraPort {
  postMessage(message: BambuMediaMessage): void;
  on(event: 'message', callback: (event: { data: unknown }) => void): unknown;
  on(event: 'close', callback: () => void): unknown;
  start(): void;
  close(): void;
}
/** One in-flight packet; a pull is sent only after the consumer releases the preceding one. */
export class CameraChannel {
  private port?: CameraPort;
  private pending: MediaStreamPacket[] = [];
  private bytes = 0;
  private credit = false;
  private stopped = false;
  private generation = -1;
  private sequence = 0;
  constructor(private readonly failed: () => void) {}
  push(packet: MediaStreamPacket) {
    if (this.stopped) return;
    if (packet.kind === 'init') { this.pending = []; this.bytes = 0; }
    if (packet.kind === 'jpeg' && this.pending.at(-1)?.kind === 'jpeg') this.bytes -= this.pending.pop()!.bytes.length;
    if (this.pending.length >= 64 || this.bytes + packet.bytes.length > 8 * 1024 * 1024) { this.failed(); return; }
    this.pending.push(packet); this.bytes += packet.bytes.length; this.flush();
  }
  attach(port: CameraPort) {
    if (this.port || this.stopped) throw new Error('Camera consumer already attached');
    this.port = port;
    port.on('message', ({ data }) => {
      if (data !== 'pull' || this.credit) { this.failed(); return; }
      this.credit = true; this.flush();
    });
    port.on('close', () => { if (!this.stopped) this.failed(); }); port.start();
  }
  private flush() {
    if (!this.port || !this.credit || !this.pending.length || this.stopped) return;
    const packet = this.pending.shift()!; this.bytes -= packet.bytes.length; this.credit = false;
    if (packet.generation !== this.generation) { this.generation = packet.generation; this.sequence = 0; }
    try { this.port.postMessage({ type: 'packet', packet: { ...packet, sequence: this.sequence++ } }); } catch { this.failed(); }
  }
  close(error?: import('@orca/printer-control/domain').PrinterError) {
    if (this.stopped) return; this.stopped = true; this.pending = []; this.bytes = 0;
    try { this.port?.postMessage(error ? { type: 'error', error } : { type: 'closed' }); } catch { /* Document has gone. */ }
    this.port?.close();
  }
}
