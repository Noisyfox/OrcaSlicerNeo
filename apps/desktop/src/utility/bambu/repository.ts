import { withFileLock } from '../../main/fileLock';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomically } from '../../main/atomicFile';
import { BAMBU_REGIONS, type BambuRegion } from '../../shared/bambu';

export interface BambuLanRecord { deviceId: string; name: string; model: string; ip: string; accessCode: string; revision: string }
export interface BambuLocalState { version: 1; region: BambuRegion; clientId: string; lan: readonly BambuLanRecord[] }
function validate(value: unknown): BambuLocalState {
  if (!value || typeof value !== 'object') throw new Error('Invalid Bambu provider configuration');
  const state = value as BambuLocalState;
  if (state.version !== 1 || !BAMBU_REGIONS.includes(state.region) || typeof state.clientId !== 'string' || !state.clientId
    || !Array.isArray(state.lan) || state.lan.some(record => !record || ['deviceId', 'name', 'model', 'ip', 'accessCode', 'revision'].some(key => typeof record[key as keyof BambuLanRecord] !== 'string'))
    || new Set(state.lan.map(record => record.deviceId)).size !== state.lan.length) throw new Error('Invalid Bambu provider configuration');
  return { version: 1, region: state.region, clientId: state.clientId, lan: state.lan.map(record => ({ deviceId: record.deviceId, name: record.name, model: record.model, ip: record.ip, accessCode: record.accessCode, revision: record.revision })) };
}
/** Each instance keeps its own snapshot; writes merge against the latest shared document under a process lock. */
export class BambuRepository {
  private state: BambuLocalState | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}
  private async loadDisk(): Promise<BambuLocalState> {
    try { this.state = validate(JSON.parse(await readFile(join(this.directory, 'provider.json'), 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read Bambu provider configuration');
      this.state = { version: 1, region: 'Others', clientId: randomUUID(), lan: [] };
      try { await this.persist(this.state); } catch (error) { this.state = null; throw error; }
    }
    return this.state;
  }
  private persist(state: BambuLocalState) {
    return writeFileAtomically(join(this.directory, 'provider.json'), new TextEncoder().encode(JSON.stringify(state)), {
      writeFile: (path, bytes, options) => writeFile(path, bytes, { ...options, mode: 0o600 }),
      rename, unlink,
    });
  }
  read(): Promise<BambuLocalState> { return this.queue(async () => {
    if (!this.state) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await withFileLock(join(this.directory, 'provider.json'), () => this.loadDisk());
    }
    return structuredClone(this.state!);
  }); }
  update(change: (current: BambuLocalState) => BambuLocalState): Promise<void> {
    return this.queue(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await withFileLock(join(this.directory, 'provider.json'), async () => {
        const next = validate(change(structuredClone(await this.loadDisk())));
        await this.persist(next); this.state = next;
      });
    });
  }
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work); this.tail = result.catch(() => undefined); return result;
  }
}
