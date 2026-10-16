import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, normalize } from 'node:path';
import type { RecentProject } from '../../../../packages/platform-contract/src/contracts';
import { writeFileAtomically } from './atomicFile';

const MAX_RECENT_PROJECTS = 18;

/** Orca AppConfig format: newest first under zero-padded, one-based keys. */
export function decodeRecentProjects(document: Record<string, unknown>): string[] {
  const section = document.recent_projects;
  if (!section || typeof section !== 'object' || Array.isArray(section)) return [];
  const paths = Object.entries(section).filter(([key, value]) =>
    /^\d{3}$/.test(key) && key !== '000' && typeof value === 'string' && isAbsolute(value),
  ).sort(([a], [b]) => a.localeCompare(b)).map(([, path]) => normalize(path as string));
  return [...new Set(paths)].slice(0, MAX_RECENT_PROJECTS);
}

/** All mutations are serialized, atomic, and published only after persistence. */
export class RecentProjectsRepository {
  private tail: Promise<unknown> = Promise.resolve();
  private document: Record<string, unknown> | null = null;
  private ids = new Map<string, string>();
  constructor(private readonly configPath: string | null, private readonly onPathsChanged: (paths: readonly string[]) => void = () => {}) {}

  private async load(): Promise<Record<string, unknown>> {
    if (this.document) return this.document;
    if (!this.configPath) return this.document = {};
    try {
      const value: unknown = JSON.parse(await readFile(this.configPath, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid recent project configuration');
      return this.document = value as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.document = {};
      throw error;
    }
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private idFor(path: string): string {
    for (const [id, candidate] of this.ids) if (candidate === path) return id;
    const id = randomUUID(); this.ids.set(id, path); return id;
  }

  async list(): Promise<RecentProject[]> {
    return this.enqueue(async () => {
      const paths = decodeRecentProjects(await this.load());
      this.onPathsChanged(paths);
      return Promise.all(paths.map(async (path) => {
        let modifiedAt: number | null = null;
        try { const file = await stat(path); if (file.isFile()) modifiedAt = file.mtimeMs; } catch { /* Missing or inaccessible. */ }
        return { id: this.idFor(path), displayName: basename(path), modifiedAt, missing: modifiedAt === null };
      }));
    });
  }

  async resolve(id: unknown): Promise<string> {
    await this.tail;
    const path = typeof id === 'string' ? this.ids.get(id) : undefined;
    if (!path || !decodeRecentProjects(await this.load()).includes(path)) throw new Error('Unknown recent project');
    return path;
  }

  private mutate(update: (paths: string[]) => string[]): Promise<void> {
    return this.enqueue(async () => {
      const document = await this.load();
      const paths = update(decodeRecentProjects(document));
      const next = { ...document, recent_projects: Object.fromEntries(paths.map((path, i) => [String(i + 1).padStart(3, '0'), path])) };
      if (this.configPath) {
        await mkdir(dirname(this.configPath), { recursive: true });
        await writeFileAtomically(this.configPath, Buffer.from(JSON.stringify(next, null, 2), 'utf8'));
      }
      this.document = next;
      this.onPathsChanged(paths);
      for (const [id, path] of this.ids) if (!paths.includes(path)) this.ids.delete(id);
    });
  }

  async record(path: string): Promise<void> {
    if (!isAbsolute(path)) throw new Error('Expected an absolute project path');
    const file = await stat(path);
    if (!file.isFile()) throw new Error('Project is not a file');
    const normalized = normalize(path);
    return this.mutate(paths => [normalized, ...paths.filter(item => item !== normalized)].slice(0, MAX_RECENT_PROJECTS));
  }
  async remove(id: unknown): Promise<void> {
    const path = await this.resolve(id);
    return this.mutate(paths => paths.filter(item => item !== path));
  }
  clear(): Promise<void> { return this.mutate(() => []); }
}
