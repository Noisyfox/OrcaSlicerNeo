import type { OrcaModule } from '@slicer/client';

export interface ProfilePackage { id: string; kind: 'core' | 'vendor'; path: string; }
export interface ProfileManifest { version: 1; packages: ProfilePackage[]; }
export interface ProfileSource { fetch(relativePath: string): Promise<Uint8Array>; }

async function bytes(response: Response): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`profile fetch ${response.status}: ${response.url}`);
  return new Uint8Array(await response.arrayBuffer());
}

// Minimal browser/Worker ZIP reader. Stored entries are supported everywhere;
// deflated entries use the standard CompressionStream available in Chromium.
async function unzip(data: Uint8Array): Promise<Array<{ path: string; data: Uint8Array }>> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: Array<{ path: string; data: Uint8Array }> = [];
  let p = 0;
  while (p + 4 <= data.byteLength) {
    const sig = view.getUint32(p, true); p += 4;
    if (sig !== 0x04034b50) break;
    const method = view.getUint16(p + 4, true);
    const compressed = view.getUint32(p + 18, true);
    const nameLength = view.getUint16(p + 22, true);
    const extraLength = view.getUint16(p + 24, true);
    const name = new TextDecoder().decode(data.subarray(p + 26, p + 26 + nameLength));
    const start = p + 26 + nameLength + extraLength;
    const payload = data.subarray(start, start + compressed);
    let content = payload;
    if (method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('deflate ZIP unsupported');
      const stream = new Blob([payload.slice().buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      content = new Uint8Array(await new Response(stream).arrayBuffer());
    } else if (method !== 0) throw new Error(`unsupported ZIP method ${method}`);
    if (!name.endsWith('/')) out.push({ path: name, data: content });
    p = start + compressed;
  }
  return out;
}

export async function installProfiles(module: Pick<OrcaModule, 'FS'>, source: ProfileSource, manifestPath = 'manifest.json') {
  const manifest = JSON.parse(new TextDecoder().decode(await source.fetch(manifestPath))) as ProfileManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.packages)) throw new Error('unsupported profile manifest');
  try { module.FS.mkdir?.('/system'); } catch { /* preload may already have mounted it */ }
  for (const pkg of manifest.packages) {
    try {
      const entries = await unzip(await source.fetch(pkg.path));
      // Preserve the virtual tree expected by libslic3r's PresetBundle.
      for (const entry of entries) {
        const relative = safeEntryPath(entry.path);
        const fullPath = `/system/${relative}`;
        mkdirParents(module.FS, fullPath.slice(0, fullPath.lastIndexOf('/')));
        module.FS.writeFile(fullPath, entry.data);
      }
    } catch (error) {
      if (pkg.kind === 'core') throw new Error(`core profile package ${pkg.id} failed: ${String(error)}`);
      console.error(`vendor profile package ${pkg.id} skipped`, error);
    }
  }
}

export function createFetchProfileSource(base: string | URL): ProfileSource {
  const root = new URL(base.toString());
  return { fetch: async (path) => bytes(await fetch(new URL(path, root))) };
}

/** Resolve bundled profile assets against the host's configured deployment base. */
export function resolveProfileBaseUrl(baseUrl: string, moduleUrl: string | URL): URL {
  const deploymentBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL('profiles/', new URL(deploymentBase, moduleUrl));
}

function safeEntryPath(entry: string): string {
  const normalized = entry.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw new Error(`unsafe profile path: ${entry}`);
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '..' || part === '.')) throw new Error(`unsafe profile path: ${entry}`);
  return parts.join('/');
}

function mkdirParents(fs: Pick<OrcaModule['FS'], 'mkdir'>, path: string): void {
  if (!fs.mkdir) return;
  const parts = path.split('/');
  let current = '';
  for (const part of parts) {
    if (!part) continue;
    current += `/${part}`;
    try { fs.mkdir(current); } catch { /* EEXIST */ }
  }
}
