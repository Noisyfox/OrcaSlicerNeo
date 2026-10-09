import { createNodeProfileSource } from './profile-source.mjs';

function safe(path) {
  const normalized = path.replaceAll('\\\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)
      || normalized.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`unsafe profile path: ${path}`);
  }
  return normalized.split('/').filter(Boolean).join('/');
}

async function unzip(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const entries = []; let offset = 0;
  while (offset + 30 <= data.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const compressed = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(data.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extraLength;
    const payload = data.subarray(start, start + compressed);
    let content = payload;
    if (method === 8) {
      const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      content = new Uint8Array(await new Response(stream).arrayBuffer());
    } else if (method !== 0) throw new Error(`unsupported ZIP method ${method}`);
    if (!name.endsWith('/')) entries.push({ path: safe(name), data: content });
    offset = start + compressed;
  }
  return entries;
}

/** Installs the checked-in package artifacts into an Emscripten MEMFS. */
export async function installProfilePackages(Module, source, manifestPath = 'manifest.json') {
  const manifest = JSON.parse(new TextDecoder().decode(await source.fetch(manifestPath)));
  if (manifest.version !== 1 || !Array.isArray(manifest.packages)) throw new Error('unsupported profile manifest');
  try { Module.FS.mkdir?.('/system'); } catch {}
  try { Module.FS.mkdir?.('/profiles'); } catch {}
  for (const pkg of manifest.packages) {
    if (!pkg || (pkg.kind !== 'core' && pkg.kind !== 'vendor')) throw new Error('invalid profile package');
    try {
      const entries = await unzip(await source.fetch(safe(pkg.path)));
      for (const entry of entries) {
        const relative = entry.path;
        const full = `${pkg.kind === 'core' ? '/system' : '/profiles'}/${relative}`;
        const parts = full.split('/').slice(0, -1); let current = '';
        for (const part of parts) { if (!part) continue; current += `/${part}`; try { Module.FS.mkdir?.(current); } catch {} }
        Module.FS.writeFile(full, entry.data);
      }
    } catch (error) {
      if (pkg.kind === 'core') throw new Error(`core profile package ${pkg.id} failed: ${String(error)}`);
      console.error(`vendor profile package ${pkg.id} skipped`, error);
    }
  }
}

export { createNodeProfileSource };

/** Test-only explicit activation for fixtures installed by this harness.
 * Production startup never derives activation from source/current preset names.
 */
export function fixtureProfileActivation(Module) {
  const models = [], filaments = [], seen = new Set();
  for (const root of ['/profiles', '/system']) {
    let entries;
    try { entries = Module.FS.readdir(root); } catch { continue; }
    for (const filename of entries.filter(name => name.endsWith('.json'))) {
      const vendor = filename.slice(0, -5);
      let manifest;
      try { manifest = JSON.parse(new TextDecoder().decode(Module.FS.readFile(`${root}/${filename}`))); } catch { continue; }
      if (!Array.isArray(manifest.machine_model_list) && !Array.isArray(manifest.filament_list)) continue;
      if (seen.has(vendor)) continue; seen.add(vendor);
      if (root === '/profiles') {
        for (const suffix of ['.json', '']) {
          try { Module.FS.unlink(`/system/${vendor}${suffix}`); } catch {}
          Module.FS.symlink(`${root}/${vendor}${suffix}`, `/system/${vendor}${suffix}`);
        }
      }
      for (const model of manifest.machine_model_list ?? []) {
        const data = JSON.parse(new TextDecoder().decode(Module.FS.readFile(`${root}/${vendor}/${model.sub_path}`)));
        models.push({ vendor, model: model.name, nozzle_diameter: data.nozzle_diameter.split(';').filter(Boolean) });
      }
      for (const filament of manifest.filament_list ?? []) filaments.push(filament.name);
    }
  }
  return { models, filaments: [...new Set(filaments)] };
}
export function fixtureProfileOptions(Module) {
  return JSON.stringify({ log_level: 'error', profile_activation: fixtureProfileActivation(Module) });
}
