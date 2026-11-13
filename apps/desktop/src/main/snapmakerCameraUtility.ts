import { utilityProcess, type MessagePortMain } from 'electron';
import type { PrinterConfigurationDocument } from '@orca/platform-contract';
import type { BambuUtilityChild } from './bambuUtility';
import type { CameraRequest } from '../shared/snapmakerCamera';
import type { BambuMediaAttachment } from '../shared/bambuMedia';
import type { CameraGrant } from '../utility/snapmaker/runtime';
interface CameraChild extends BambuUtilityChild { kill?(): boolean }

/** Independent protocol/IO host. A failed child retires every pending call. */
export class SnapmakerCameraUtility {
  private readonly child: CameraChild;
  private readonly ready: Promise<void>;
  private readonly exited: Promise<void>;
  private dead = false;
  private closing?: Promise<void>;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  constructor(path: string, private readonly changed: () => void, fork = (modulePath: string): CameraChild => utilityProcess.fork(modulePath, [], { serviceName: 'Orca Snapmaker Camera', stdio: 'ignore' })) {
    this.child = fork(path);
    let ready!: () => void, rejectReady!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => { ready = resolve; rejectReady = reject; });
    void this.ready.catch(() => undefined);
    const startup = setTimeout(() => { rejectReady(new Error('Camera host startup timed out.')); this.child.kill?.(); }, 5000);
    this.exited = new Promise(resolve => this.child.once('exit', () => {
      clearTimeout(startup); this.dead = true; const error = new Error('Camera host exited.'); rejectReady(error);
      for (const call of this.pending.values()) call.reject(error);
      this.pending.clear(); this.changed(); resolve();
    }));
    this.child.on('message', message => {
      const data = message as Record<string, unknown> | null;
      if (!data || this.dead) return;
      if (data.type === 'ready') { clearTimeout(startup); ready(); }
      if (data.type === 'changed') this.changed();
      if (data.type === 'reply' && typeof data.id === 'number') { this.pending.get(data.id)?.resolve(data.value); this.pending.delete(data.id); }
    });
  }
  async call(owner: string, request: CameraRequest, grant?: CameraGrant, current = () => true): Promise<unknown> {
    await this.ready;
    if (!current()) return { ok: false, error: { code: 'cancelled', message: 'Camera viewing stopped.' } };
    if (this.dead || this.closing) throw new Error('Camera host unavailable.');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.child.postMessage({ type: 'call', id, owner, request, grant }); }
      catch { this.pending.delete(id); reject(new Error('Camera host unavailable.')); }
    });
  }
  configuration(document: PrinterConfigurationDocument): void { if (!this.dead && !this.closing) this.child.postMessage({ type: 'configuration', document }); }
  async connect(owner: string, request: BambuMediaAttachment, port: MessagePortMain, current = () => true): Promise<void> {
    await this.ready;
    if (this.dead || this.closing || !current()) { port.close(); return; }
    this.child.postMessage({ type: 'port', owner, request }, [port]);
  }
  closeOwner(owner: string): void { if (!this.dead && !this.closing) this.child.postMessage({ type: 'owner-close', owner }); }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>(resolve => { timer = setTimeout(() => { this.child.kill?.(); this.dead = true; resolve(); }, 7000); });
      try {
        await this.ready.catch(() => undefined);
        for (const call of this.pending.values()) call.reject(new Error('Camera host is closing.'));
        this.pending.clear();
        if (!this.dead) this.child.postMessage({ type: 'shutdown' });
        await Promise.race([this.exited, deadline]);
      } finally { clearTimeout(timer); }
    })();
  }
}
