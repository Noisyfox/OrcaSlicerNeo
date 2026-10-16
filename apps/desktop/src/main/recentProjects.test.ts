import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeRecentProjects, RecentProjectsRepository } from './recentProjects';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'neo-recents-')); directories.push(dir);
  const config = join(dir, 'OrcaSlicerNeo.conf');
  const files = Array.from({ length: 20 }, (_, i) => join(dir, `project-${i}.3mf`));
  await Promise.all(files.map(path => writeFile(path, 'project')));
  return { config, files, repo: new RecentProjectsRepository(config) };
}

describe('Orca recent project configuration', () => {
  it('serializes concurrent updates, deduplicates, caps at 18 and restores Orca keys', async () => {
    const { config, files, repo } = await fixture();
    await writeFile(config, JSON.stringify({ unrelated: { keep: true } }));
    await Promise.all(files.map(file => repo.record(file)));
    await repo.record(files[5]);
    const document = JSON.parse(await readFile(config, 'utf8'));
    expect(document.unrelated).toEqual({ keep: true });
    expect(Object.keys(document.recent_projects)).toEqual(Array.from({ length: 18 }, (_, i) => String(i + 1).padStart(3, '0')));
    expect(document.recent_projects['001']).toBe(files[5]);
    expect(decodeRecentProjects(document)).toHaveLength(18);
    const reloaded = await new RecentProjectsRepository(config).list();
    expect(reloaded[0]).toMatchObject({ displayName: 'project-5.3mf', missing: false });
    expect(JSON.stringify(reloaded)).not.toContain(files[5]);
  });
  it('resolves only listed ids, retains missing files, removes entries without deleting files', async () => {
    const { repo, config, files } = await fixture();
    await repo.record(files[0]); await repo.record(files[1]);
    const [one, zero] = await repo.list();
    await expect(repo.resolve(files[0])).rejects.toThrow('Unknown recent project');
    expect(await repo.resolve(zero.id)).toBe(files[0]);
    await unlink(files[1]);
    expect((await repo.list())[0]).toMatchObject({ id: one.id, missing: true, modifiedAt: null });
    await repo.remove(zero.id);
    expect(await readFile(files[0], 'utf8')).toBe('project');
    await expect(repo.resolve(zero.id)).rejects.toThrow();
    await repo.clear();
    expect(await repo.list()).toEqual([]);
    expect(JSON.parse(await readFile(config, 'utf8')).recent_projects).toEqual({});
  });
  it('preserves malformed configuration and keeps prior history on write failure', async () => {
    const { config, repo, files } = await fixture();
    await repo.record(files[0]);
    await unlink(config); await writeFile(config, '{invalid');
    const broken = new RecentProjectsRepository(config);
    await expect(broken.record(files[1])).rejects.toThrow();
    expect(await readFile(config, 'utf8')).toBe('{invalid');
    await unlink(config);
    // A directory in place of the destination makes atomic replacement fail.
    const { mkdir } = await import('node:fs/promises'); await mkdir(config);
    await expect(repo.record(files[1])).rejects.toThrow();
    expect((await repo.list()).map(item => item.displayName)).toEqual(['project-0.3mf']);
  });
});
