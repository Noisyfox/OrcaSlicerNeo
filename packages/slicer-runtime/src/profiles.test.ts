import { describe, expect, it } from 'vitest';
import { installProfiles, resolveDeploymentBase, resolveProfileBaseUrl, type ProfileSource } from './profiles';

function zip(entries: Array<[string, string]>): Uint8Array {
  const chunks: Uint8Array[] = [];
      for (const [name, value] of entries) {
    const n = new TextEncoder().encode(name); const d = new TextEncoder().encode(value);
    const b = new Uint8Array(30 + n.length + d.length); const v = new DataView(b.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 10, true); v.setUint16(8, 0, true);
    v.setUint32(18, d.length, true); v.setUint32(22, d.length, true); v.setUint16(26, n.length, true); v.setUint16(28, 0, true);
    b.set(n, 30); b.set(d, 30 + n.length); chunks.push(b);
  }
  const out = new Uint8Array(chunks.reduce((n, x) => n + x.length, 0)); let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

function source(files: Record<string, Uint8Array>): ProfileSource {
  return { fetch: async (path) => { const value = files[path]; if (!value) throw new Error(`missing ${path}`); return value; } };
}
function manifest(packages: Array<{ id: string; kind: 'core' | 'vendor'; path: string }>) {
  return new TextEncoder().encode(JSON.stringify({ version: 1, packages }));
}

describe('profile installer', () => {
  it('resolves profiles from the configured deployment base', () => {
    expect(resolveProfileBaseUrl('/', 'https://host.test/assets/worker.js').href).toBe('https://host.test/profiles/');
    expect(resolveProfileBaseUrl('/orca/', 'https://host.test/orca/assets/worker.js').href).toBe('https://host.test/orca/profiles/');
    expect(resolveProfileBaseUrl('/preview/orca', 'https://host.test/preview/orca/assets/worker.js').href).toBe('https://host.test/preview/orca/profiles/');
    expect(resolveProfileBaseUrl('./', 'https://host.test/orca/assets/worker.js').href).toBe('https://host.test/orca/profiles/');
  });

  it('anchors host assets at the deployment root for built bundles and dev servers', () => {
    // Built bundle: the worker chunk lives in assets/, one level below the
    // root, so a relative base anchors above the chunk.
    expect(resolveDeploymentBase('./', 'https://host.test/orca/assets/worker.js').href).toBe('https://host.test/orca/');
    expect(resolveDeploymentBase('./', 'https://host.test/preview/orca/assets/worker.js').href).toBe('https://host.test/preview/orca/');
    // Dev server: the shared package worker chunk is served outside the app
    // root (/@fs/...); the absolute base reaches the public dir.
    expect(resolveDeploymentBase('/', 'http://localhost:5173/@fs/D:/projects/OrcaSlicerNeo/packages/slicer-runtime/src/slicer/slicer.worker.ts').href).toBe('http://localhost:5173/');
    expect(resolveDeploymentBase('/orca/', 'https://host.test/orca/assets/worker.js').href).toBe('https://host.test/orca/');
    // The host's wasm artifacts publish under wasm/<variant>/ in that root.
    expect(new URL('wasm/threaded/orca_slice.js', resolveDeploymentBase('/', 'http://localhost:5173/@fs/D:/projects/OrcaSlicerNeo/packages/slicer-runtime/src/slicer/slicer.worker.ts')).href)
      .toBe('http://localhost:5173/wasm/threaded/orca_slice.js');
    expect(new URL('wasm/serial/orca_slice.wasm', resolveDeploymentBase('./', 'https://host.test/orca/assets/worker.js')).href)
      .toBe('https://host.test/orca/wasm/serial/orca_slice.wasm');
  });

  it('mounts every compact package before init', async () => {
    const files = {
      'manifest.json': manifest([
        { id: 'core', kind: 'core', path: 'core.zip' },
        { id: 'vendor', kind: 'vendor', path: 'vendors/vendor.zip' },
      ]),
      'core.zip': zip([['common.json', '{}']]),
      'vendors/vendor.zip': zip([['Vendor/machine.json', '{}']]),
    };
    const mounted = new Map<string, Uint8Array>(); const dirs = new Set(['/']);
    await installProfiles({ FS: {
      mkdir: (path) => { if (dirs.has(path)) throw new Error('EEXIST'); dirs.add(path); },
      writeFile: (path, bytes) => { const parent = path.slice(0, path.lastIndexOf('/')) || '/'; if (!dirs.has(parent)) throw new Error(`missing parent ${parent}`); mounted.set(path, bytes); },
      readFile: () => new Uint8Array(),
    } }, source(files));
    expect([...mounted.keys()]).toEqual(['/system/common.json', '/system/vendor/Vendor/machine.json']);
    expect(dirs.has('/system/vendor/Vendor')).toBe(true);
  });

  it('reports package progress and keeps core info files at /info', async () => {
    const files = {
      'manifest.json': manifest([{ id: 'core', kind: 'core', path: 'core.zip' }]),
      'core.zip': zip([['machine.json', '{}'], ['info/nozzle_info.json', '{}']]),
    };
    const mounted = new Set<string>(); const progress: string[] = []; const dirs = new Set(['/']);
    await installProfiles({ FS: {
      mkdir: (path) => { if (dirs.has(path)) throw new Error('EEXIST'); dirs.add(path); },
      writeFile: (path) => { mounted.add(path); }, readFile: () => new Uint8Array(),
    } }, source(files), 'manifest.json', ({ package: pkg, index, total }) => progress.push(`${index}/${total}:${pkg.id}`));
    expect(progress).toEqual(['0/1:core']);
    expect([...mounted]).toEqual(['/system/machine.json', '/info/nozzle_info.json']);
  });

  it('blocks on core failure but skips a failed vendor', async () => {
    const base = { 'manifest.json': manifest([
      { id: 'core', kind: 'core', path: 'core.zip' }, { id: 'vendor', kind: 'vendor', path: 'bad.zip' },
    ]), 'core.zip': zip([['ok', '1']]) };
    await expect(installProfiles({ FS: { mkdir: () => {}, writeFile: () => {}, readFile: () => new Uint8Array() } }, source(base))).resolves.toBeUndefined();
    const broken = { 'manifest.json': manifest([{ id: 'core', kind: 'core', path: 'missing.zip' }]) };
    await expect(installProfiles({ FS: { mkdir: () => {}, writeFile: () => {}, readFile: () => new Uint8Array() } }, source(broken))).rejects.toThrow(/core profile package/);
  });

  it('rejects traversal paths (and treats a bad vendor as skippable)', async () => {
    const files = { 'manifest.json': manifest([{ id: 'core', kind: 'core', path: 'core.zip' }]), 'core.zip': zip([['../escape', 'x']]) };
    await expect(installProfiles({ FS: { mkdir: () => {}, writeFile: () => {}, readFile: () => new Uint8Array() } }, source(files))).rejects.toThrow(/unsafe profile path/);
  });

  it('accepts streamed package bytes from a browser-compatible source', async () => {
    const files = { 'manifest.json': manifest([{ id: 'core', kind: 'core', path: 'core.zip' }]), 'core.zip': zip([['ok', '1']]) };
    const streamed: ProfileSource = { fetch: async (path) => new ReadableStream({ start(controller) { controller.enqueue((files as Record<string, Uint8Array>)[path]); controller.close(); } }) };
    const mounted = new Set<string>();
    await installProfiles({ FS: { mkdir: () => {}, writeFile: (path) => mounted.add(path), readFile: () => new Uint8Array() } }, streamed);
    expect(mounted).toContain('/system/ok');
  });
});
