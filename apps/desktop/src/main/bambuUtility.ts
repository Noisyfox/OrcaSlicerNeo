import { isDownloadProgress } from '../shared/downloadExecution';
import type { DownloadProgress } from '@orca/platform-contract';
import type { BambuMediaRequest, BambuMediaAttachment } from '../shared/bambuMedia';
import type { MessagePortMain } from 'electron';
import { isBambuControlRequest, type BambuControlInputs, type BambuControlMethod, type BambuControlResults } from '../shared/bambuControl';
import type { BambuHostInputs, BambuHostMethod, BambuHostResults } from '../shared/bambuHost';
import { join } from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';
import { isBambuChange, isBambuRead, isBambuReadResult, type BambuChange, type BambuHostConfig, type BambuRead, type BambuReadResults } from '../shared/bambu';

export interface BambuUtilityChild {
  on(event: 'message', listener: (message: unknown) => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
  postMessage(message: unknown, ports?: MessagePortMain[]): void;
}
/** Exactly one instance is created by app startup, owned by this independent application instance. */
export class BambuUtility {
  private readonly child: BambuUtilityChild;
  private readonly ready: Promise<void>;
  private readonly exited: Promise<void>;
  private sequence = 0;
  private dead = false;
  private readonly downloadListeners = new Set<(id: string, progress: DownloadProgress) => void>();
  private closing: Promise<void> | null = null;
  private readonly listeners = new Set<(change: BambuChange) => void>();
  private readonly pending = new Map<number, { kind: BambuRead | null; resolve(value: unknown): void; reject(error: Error): void }>();
  constructor(modulePath: string, config: BambuHostConfig, fork: (path: string) => BambuUtilityChild = path => utilityProcess.fork(path, [], {
    serviceName: 'Orca Bambu Provider', stdio: 'ignore', allowLoadingUnsignedLibraries: true,
  }) as UtilityProcess) {
    this.child = fork(modulePath);
    let ready!: () => void, rejectReady!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => { ready = resolve; rejectReady = reject; });
    void this.ready.catch(() => undefined); // A startup exit may precede the first caller.
    this.exited = new Promise(resolve => { this.child.once('exit', () => {
      this.dead = true;
      const error = new Error('Bambu provider exited before completing the request.');
      rejectReady(error);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear(); this.listeners.clear(); this.downloadListeners.clear(); resolve();
    }); });
    this.child.on('message', message => {
      if (!message || typeof message !== 'object') return;
      const value = message as Record<string, unknown>;
      if (this.dead) return;
      if (value.type === 'ready') ready();
      else if (value.type === 'download-progress' && typeof value.id === 'string' && value.id.length <= 512 && isDownloadProgress(value.progress)) {
        for (const listener of this.downloadListeners) { try { listener(value.id, { ...value.progress }); } catch { /* Isolate observers. */ } }
      }
      else if (value.type === 'changed' && isBambuChange(value.change)) {
        for (const listener of this.listeners) { try { listener(value.change); } catch { /* A view cannot stop publication to other windows. */ } }
      } else if (value.type === 'reply' && typeof value.id === 'number') {
        const request = this.pending.get(value.id);
        if (!request) return;
        this.pending.delete(value.id);
        if ('error' in value || (request.kind !== null && !isBambuReadResult(request.kind, value.value))) request.reject(new Error('Bambu provider reply unavailable'));
        else request.resolve(value.value);
      }
    });
    this.child.postMessage({ type: 'init', config });
  }
  async read<K extends BambuRead>(request: K): Promise<BambuReadResults[K]> {
    if (!isBambuRead(request) || this.closing || this.dead) throw new Error('Bambu provider request unavailable');
    await this.ready;
    if (this.closing || this.dead) throw new Error('Bambu provider is closing');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: request, resolve: value => resolve(value as BambuReadResults[K]), reject });
      try { this.child.postMessage({ type: 'read', id, request }); }
      catch { this.pending.delete(id); reject(new Error('Bambu provider request unavailable')); }
    });
  }
  /** Private host operations: only the login controller and trusted IPC handlers call this. */
  async host<K extends BambuHostMethod>(method: K, input: BambuHostInputs[K]): Promise<BambuHostResults[K]> {
    await this.ready;
    if (this.closing || this.dead) throw new Error('Bambu provider is closing');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: null, resolve: value => resolve(value as BambuHostResults[K]), reject });
      try { this.child.postMessage({ type: 'host', id, request: { method, input } }); }
      catch { this.pending.delete(id); reject(new Error('Bambu provider request unavailable')); }
    });
  }
  async control<K extends BambuControlMethod>(method: K, input: BambuControlInputs[K]): Promise<BambuControlResults[K]> {
    if (!isBambuControlRequest({ method, input })) throw new Error('Bambu IPC request rejected');
    await this.ready;
    if (this.closing || this.dead) throw new Error('Bambu provider is closing');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: null, resolve: value => resolve(value as BambuControlResults[K]), reject });
      try { this.child.postMessage({ type: 'control', id, request: { method, input } }); }
      catch { this.pending.delete(id); reject(new Error('Bambu provider request unavailable')); }
    });
  }
  async media(owner: string, request: BambuMediaRequest): Promise<unknown> {
    await this.ready;
    if (this.closing || this.dead) throw new Error('Bambu provider is closing');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: null, resolve, reject });
      try { this.child.postMessage({ type: 'media', id, owner, request }); }
      catch { this.pending.delete(id); reject(new Error('Camera unavailable')); }
    });
  }
  async connectMedia(owner: string, request: BambuMediaAttachment, port: MessagePortMain) {
    await this.ready;
    if (this.closing || this.dead) { port.close(); return; }
    this.child.postMessage({ type: 'media-port', owner, request }, [port]);
  }
  closeMediaOwner(owner: string) { if (!this.dead && !this.closing) this.child.postMessage({ type: 'media-owner-close', owner }); }
  onDownloadProgress(listener: (id: string, progress: DownloadProgress) => void) { this.downloadListeners.add(listener); return () => { this.downloadListeners.delete(listener); }; }
  onChanged(listener: (change: BambuChange) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  close(): Promise<void> {
    if (!this.closing) this.closing = (async () => {
      await this.ready.catch(() => undefined);
      this.listeners.clear(); this.downloadListeners.clear();
      for (const request of this.pending.values()) request.reject(new Error('Bambu provider is closing'));
      this.pending.clear();
      if (!this.dead) this.child.postMessage({ type: 'shutdown' });
      await this.exited;
    })();
    return this.closing;
  }
}


/** Main-frame identity is supplied by the app; guests/login windows are not clients. */
export function createBambuIpc(read: <K extends BambuRead>(kind: K) => Promise<BambuReadResults[K]>, isAppFrame: (event: unknown) => boolean) {
  return async (event: unknown, request: unknown) => {
    if (!isAppFrame(event) || !isBambuRead(request)) throw new Error('Bambu IPC request rejected');
    return read(request);
  };
}

export function bambuPaths(options: { packaged: boolean; resourcesPath: string; projectRoot: string; directory: string; platform: NodeJS.Platform; arch: string; osVersion: string }): BambuHostConfig {
  const library = options.platform === 'win32' ? 'bambu_networking.dll' : `libbambu_networking.${options.platform === 'darwin' ? 'dylib' : 'so'}`;
  const native = join(options.projectRoot, 'packages/bambu-native');
  const bundled = join(options.resourcesPath, 'bambu');
  return {
    addonPath: options.packaged ? join(bundled, 'bambu.node') : join(native, 'build/Release/bambu.node'),
    pluginPath: options.packaged ? join(bundled, 'plugin', library) : join(native, 'out', `${options.platform}-${options.arch}`, 'plugin', library),
    certificateDirectory: options.packaged ? join(bundled, 'cert') : join(options.projectRoot, 'packages/slicer-wasm/cpp/resources/cert'),
    directory: options.directory,
    osType: options.platform === 'win32' ? options.arch === 'arm64' ? 'windows_arm' : 'windows' : options.platform === 'darwin' ? 'macos' : 'linux',
    osVersion: options.osVersion,
  };
}
