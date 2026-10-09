import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { createProfileInstaller, readHotendProfileAsset, resolveDeploymentBase, resolveProfileBaseUrl, type ProfileSource } from './profiles';

const installAll = (module: Parameters<typeof createProfileInstaller>[0], source: ProfileSource,
  progress?: Parameters<typeof createProfileInstaller>[2]) =>
  createProfileInstaller(module, source, progress).installCatalogue();

function zip(entries: Array<[string, string]>): Uint8Array {
  return zipSync(Object.fromEntries(entries.map(([name, value]) => [name, new TextEncoder().encode(value)])));
}

function source(files: Record<string, Uint8Array>): ProfileSource {
  return { fetch: async (path) => { const value = files[path]; if (!value) throw new Error(`missing ${path}`); return value; } };
}
function manifest(packages: Array<{ id: string; kind: 'core' | 'vendor'; path: string }>) {
  return new TextEncoder().encode(JSON.stringify({ version: 1, packages }));
}

describe('runtime profile installation session', () => {
  const packages = ['core', 'OrcaFilamentLibrary', 'Alpha', 'Beta'].map(id => ({ id,
    kind: id === 'core' ? 'core' as const : 'vendor' as const, path: `${id}.zip` }));
  function fixture() {
    const files: Record<string, Uint8Array> = { 'manifest.json': manifest(packages),
      ...Object.fromEntries(packages.map(pkg => [pkg.path, zip([[`${pkg.id}.json`, '{}']])])) };
    const fetch = vi.fn(source(files).fetch), write = vi.fn();
    const progress = vi.fn();
    const installer = createProfileInstaller({ FS: { mkdir: () => {}, writeFile: write, readFile: () => new Uint8Array() } }, { fetch }, progress);
    return { files, fetch, write, progress, installer };
  }
  it.each([null, { models: [], filaments: ['PLA @Beta'] },
    { models: [{ vendor: 'Unknown', model: 'Retired', nozzle_diameter: ['0.4'] }], filaments: [] }])(
    'installs only the permanent packages for empty, filament-only or unknown selections (%j)', async activation => {
      const f = fixture(); await f.installer.installStartup(activation);
      expect(f.fetch.mock.calls.map(([path]) => path)).toEqual(['manifest.json', 'core.zip', 'OrcaFilamentLibrary.zip']);
      expect(f.write.mock.calls.map(([path]) => path)).toEqual(['/system/core.json', '/profiles/OrcaFilamentLibrary.json']);
      expect(f.progress.mock.calls.map(([value]) => [value.index, value.total])).toEqual([[0, 2], [1, 2]]);
    });
  it('installs explicit printer vendors once, fills remaining on open and never rewrites successful packages', async () => {
    const f = fixture(); const activation = { models: [{ vendor: 'Alpha', model: 'printer', nozzle_diameter: ['0.4'] }], filaments: ['PLA @Beta'] };
    await Promise.all([f.installer.installStartup(activation), f.installer.installStartup(activation)]);
    expect(f.fetch.mock.calls.map(([path]) => path)).toEqual(['manifest.json', 'core.zip', 'OrcaFilamentLibrary.zip', 'Alpha.zip']);
    expect(f.progress.mock.calls.map(([value]) => value.total)).toEqual([3, 3, 3]);
    const initialWrites = f.write.mock.calls.length;
    await f.installer.installCatalogue(); await f.installer.installCatalogue();
    expect(f.fetch.mock.calls.map(([path]) => path)).toEqual(['manifest.json', 'core.zip', 'OrcaFilamentLibrary.zip', 'Alpha.zip', 'Beta.zip']);
    expect(f.write).toHaveBeenCalledTimes(initialWrites + 1);
    expect(f.progress.mock.calls.at(-1)![0]).toMatchObject({ index: 0, total: 1, package: packages[3] });
  });
  it('retries skipped vendor failures at the next catalogue open, preserving successful writes', async () => {
    const f = fixture(); delete f.files['Beta.zip'];
    await f.installer.installCatalogue(); const successfulWrites = f.write.mock.calls.length;
    f.files['Beta.zip'] = zip([['Beta.json', '{}']]);
    await f.installer.installCatalogue(); await f.installer.installCatalogue();
    expect(f.fetch.mock.calls.filter(([path]) => path === 'Beta.zip')).toHaveLength(2);
    expect(f.fetch.mock.calls.filter(([path]) => path === 'Alpha.zip')).toHaveLength(1);
    expect(f.write).toHaveBeenCalledTimes(successfulWrites + 1);
  });
  it('core failure rejects; a subsequent attempt can retry without a rejected session memo', async () => {
    const f = fixture(); const core = f.files['core.zip']; delete f.files['core.zip'];
    await expect(f.installer.installStartup(null)).rejects.toThrow('core profile package');
    expect(f.write).not.toHaveBeenCalled(); f.files['core.zip'] = core;
    await f.installer.installStartup(null);
    expect(f.fetch.mock.calls.map(([path]) => path)).toEqual(['manifest.json', 'core.zip', 'core.zip', 'OrcaFilamentLibrary.zip']);
  });
  it.each(['../bad.zip', 'https://evil.test/bad.zip', 'vendors/%2e%2e/%2e%2e/bad.zip'])('validates unsafe later manifest path %s before fetching/writing and retries corrected metadata', async path => {
    const f = fixture(); f.files['manifest.json'] = manifest([...packages, { id: 'bad', kind: 'vendor', path }]);
    await expect(f.installer.installStartup(null)).rejects.toThrow(/unsafe profile/);
    expect(f.fetch.mock.calls.map(([path]) => path)).toEqual(['manifest.json']); expect(f.write).not.toHaveBeenCalled();
    f.files['manifest.json'] = manifest(packages); await f.installer.installStartup(null);
    expect(f.fetch.mock.calls.map(([path]) => path)).toEqual(['manifest.json', 'manifest.json', 'core.zip', 'OrcaFilamentLibrary.zip']);
  });
});

describe('profile installer', () => {
  it('selects the printer hotend from the vendor archive and only falls back to core', async () => {
    const files = {
      'manifest.json': manifest([
        { id: 'core', kind: 'core', path: 'core.zip' },
        { id: 'Vendor', kind: 'vendor', path: 'vendors/Vendor.zip' },
      ]),
      'core.zip': zip([['hotend.stl', 'core-hotend'], ['unused.stl', 'not-loaded']]),
      'vendors/Vendor.zip': zip([
        ['Vendor/machine/Printer.json', JSON.stringify({ name: 'Printer', hotend_model: 'vendor-hotend.stl' })],
        ['Vendor/vendor-hotend.stl', 'vendor-hotend'],
        ['Vendor/unused.stl', 'not-loaded'],
      ]),
    };
    const requested: string[] = [];
    const tracked: ProfileSource = { fetch: async (path) => { requested.push(path); return files[path as keyof typeof files]; } };
    await expect(readHotendProfileAsset(tracked, { vendor_id: 'Vendor', model: 'Printer' }))
      .resolves.toEqual(new TextEncoder().encode('vendor-hotend'));
    expect(requested).toEqual(['manifest.json', 'vendors/Vendor.zip']);
    await expect(readHotendProfileAsset(tracked, { vendor_id: 'Other', model: 'Printer' }))
      .resolves.toEqual(new TextEncoder().encode('core-hotend'));
    expect(requested).toEqual(['manifest.json', 'vendors/Vendor.zip', 'manifest.json', 'core.zip']);
  });

  it('uses core hotend when a selected machine has no usable vendor model', async () => {
    const files = {
      'manifest.json': manifest([
        { id: 'core', kind: 'core', path: 'core.zip' },
        { id: 'Vendor', kind: 'vendor', path: 'vendors/Vendor.zip' },
      ]),
      'core.zip': zip([['hotend.stl', 'core-hotend']]),
      'vendors/Vendor.zip': zip([['Vendor/machine/Printer.json', JSON.stringify({ name: 'Printer', hotend_model: '' })]]),
    };
    await expect(readHotendProfileAsset(source(files), { vendor_id: 'Vendor', model: 'Printer' }))
      .resolves.toEqual(new TextEncoder().encode('core-hotend'));
  });

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
        { id: 'Vendor', kind: 'vendor', path: 'vendors/Vendor.zip' },
      ]),
      'core.zip': zip([['common.json', '{}']]),
      'vendors/Vendor.zip': zip([['Vendor/machine/Printer.json', '{}'], ['Vendor.json', '{"name":"Vendor"}']]),
    };
    const mounted = new Map<string, Uint8Array>(); const dirs = new Set(['/']);
    await installAll({ FS: {
      mkdir: (path) => { if (dirs.has(path)) throw new Error('EEXIST'); dirs.add(path); },
      writeFile: (path, bytes) => { const parent = path.slice(0, path.lastIndexOf('/')) || '/'; if (!dirs.has(parent)) throw new Error(`missing parent ${parent}`); mounted.set(path, bytes); },
      readFile: () => new Uint8Array(),
    } }, source(files));
    expect([...mounted.keys()]).toEqual(['/system/common.json', '/profiles/Vendor/machine/Printer.json', '/profiles/Vendor.json']);
    expect(dirs.has('/profiles/Vendor/machine')).toBe(true);
  });

  it('reports package progress and mounts core entries under /system', async () => {
    const files = {
      'manifest.json': manifest([{ id: 'core', kind: 'core', path: 'core.zip' }]),
      'core.zip': zip([['blacklist.json', '{}'], ['hotend.stl', 'core-hotend']]),
    };
    const mounted = new Set<string>(); const progress: string[] = []; const dirs = new Set(['/']);
    await installAll({ FS: {
      mkdir: (path) => { if (dirs.has(path)) throw new Error('EEXIST'); dirs.add(path); },
      writeFile: (path) => { mounted.add(path); }, readFile: () => new Uint8Array(),
    } }, source(files), ({ package: pkg, index, total }) => progress.push(`${index}/${total}:${pkg.id}`));
    expect(progress).toEqual(['0/1:core']);
    expect([...mounted]).toEqual(['/system/blacklist.json', '/system/hotend.stl']);
  });

  it('blocks on core failure but skips a failed vendor', async () => {
    const base = { 'manifest.json': manifest([
      { id: 'core', kind: 'core', path: 'core.zip' }, { id: 'vendor', kind: 'vendor', path: 'bad.zip' },
    ]), 'core.zip': zip([['ok', '1']]) };
    await expect(installAll({ FS: { mkdir: () => {}, writeFile: () => {}, readFile: () => new Uint8Array() } }, source(base))).resolves.toBeUndefined();
    const broken = { 'manifest.json': manifest([{ id: 'core', kind: 'core', path: 'missing.zip' }]) };
    await expect(installAll({ FS: { mkdir: () => {}, writeFile: () => {}, readFile: () => new Uint8Array() } }, source(broken))).rejects.toThrow(/core profile package/);
  });

  it('rejects traversal paths (and treats a bad vendor as skippable)', async () => {
    const files = { 'manifest.json': manifest([{ id: 'core', kind: 'core', path: 'core.zip' }]), 'core.zip': zip([['../escape', 'x']]) };
    await expect(installAll({ FS: { mkdir: () => {}, writeFile: () => {}, readFile: () => new Uint8Array() } }, source(files))).rejects.toThrow(/unsafe profile path/);
  });

  it('accepts streamed package bytes from a browser-compatible source', async () => {
    const files = { 'manifest.json': manifest([{ id: 'core', kind: 'core', path: 'core.zip' }]), 'core.zip': zip([['ok', '1']]) };
    const streamed: ProfileSource = { fetch: async (path) => new ReadableStream({ start(controller) { controller.enqueue((files as Record<string, Uint8Array>)[path]); controller.close(); } }) };
    const mounted = new Set<string>();
    await installAll({ FS: { mkdir: () => {}, writeFile: (path) => mounted.add(path), readFile: () => new Uint8Array() } }, streamed);
    expect(mounted).toContain('/system/ok');
  });
});
