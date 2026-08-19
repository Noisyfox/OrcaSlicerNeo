import { describe, expect, it } from 'vitest';
import { installProfiles, resolveModuleAssetUrl, resolveProfileBaseUrl, type ProfileSource } from './profiles';

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
  });

  it('resolves worker assets beside the module on a deployment subpath', () => {
    expect(resolveModuleAssetUrl('../wasm/orca_slice.js', 'https://host.test/orca/assets/worker.js'))
      .toBe('https://host.test/orca/wasm/orca_slice.js');
    expect(resolveModuleAssetUrl('../wasm/orca_slice.wasm', 'https://host.test/preview/orca/assets/worker.js'))
      .toBe('https://host.test/preview/orca/wasm/orca_slice.wasm');
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
    expect([...mounted.keys()]).toEqual(['/system/common.json', '/system/Vendor/machine.json']);
    expect(dirs.has('/system/Vendor')).toBe(true);
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
});
