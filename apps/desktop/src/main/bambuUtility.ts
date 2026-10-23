import type { BambuHostInputs, BambuHostMethod, BambuHostResults } from '../shared/bambuHost';
import { join } from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';
import { isBambuChange, isBambuRead, isBambuReadResult, type BambuChange, type BambuHostConfig, type BambuRead, type BambuReadResults } from '../shared/bambu';

export interface BambuUtilityChild {
  on(event: 'message', listener: (message: unknown) => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
  postMessage(message: unknown): void;
}
/** Exactly one instance is created by app startup, shared by all trusted windows. */
export class BambuUtility {
  private readonly child: BambuUtilityChild;
  private readonly ready: Promise<void>;
  private readonly exited: Promise<void>;
  private sequence = 0;
  private closing: Promise<void> | null = null;
  private readonly listeners = new Set<(change: BambuChange) => void>();
  private readonly pending = new Map<number, { kind: BambuRead | null; resolve(value: unknown): void; reject(error: Error): void }>();
  constructor(modulePath: string, config: BambuHostConfig, fork: (path: string) => BambuUtilityChild = path => utilityProcess.fork(path, [], {
    serviceName: 'Orca Bambu Provider', stdio: 'ignore', allowLoadingUnsignedLibraries: true,
  }) as UtilityProcess) {
    this.child = fork(modulePath);
    let ready!: () => void;
    this.ready = new Promise(resolve => { ready = resolve; });
    this.exited = new Promise(resolve => { this.child.once('exit', () => resolve()); });
    this.child.on('message', message => {
      if (!message || typeof message !== 'object') return;
      const value = message as Record<string, unknown>;
      if (value.type === 'ready') ready();
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
    if (!isBambuRead(request) || this.closing) throw new Error('Bambu provider request unavailable');
    await this.ready;
    if (this.closing) throw new Error('Bambu provider is closing');
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
    if (this.closing) throw new Error('Bambu provider is closing');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: null, resolve: value => resolve(value as BambuHostResults[K]), reject });
      try { this.child.postMessage({ type: 'host', id, request: { method, input } }); }
      catch { this.pending.delete(id); reject(new Error('Bambu provider request unavailable')); }
    });
  }
  onChanged(listener: (change: BambuChange) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  close(): Promise<void> {
    if (!this.closing) this.closing = this.ready.then(async () => {
      this.listeners.clear();
      for (const request of this.pending.values()) request.reject(new Error('Bambu provider is closing'));
      this.pending.clear(); this.child.postMessage({ type: 'shutdown' }); await this.exited;
    });
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
