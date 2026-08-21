import { unzipSync } from 'fflate';
import type { OrcaModule } from '@slicer/client';

export interface ProfilePackage { id: string; kind: 'core' | 'vendor'; path: string; }
export interface ProfileManifest { version: 1; packages: ProfilePackage[]; }
export interface ProfileSource { fetch(relativePath: string): Promise<Uint8Array | ReadableStream<Uint8Array>>; }

export interface ProfileInstallProgress {
  package: ProfilePackage;
  index: number;
  total: number;
}

async function bytes(response: Response): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`profile fetch ${response.status}: ${response.url}`);
  const data = new Uint8Array(await response.arrayBuffer());
  console.info('[profiles] fetch-complete', JSON.stringify({ url: response.url, bytes: data.byteLength }));
  return data;
}

// fflate handles both stored and deflated entries; the packaging build
// (packages/profile-resources) writes store-only archives.
function unzip(data: Uint8Array): Array<{ path: string; data: Uint8Array }> {
  const files = unzipSync(data);
  return Object.entries(files)
    .filter(([path]) => !path.endsWith('/'))
    .map(([path, content]) => ({ path, data: content }));
}

async function readBytes(value: Uint8Array | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(await new Response(value).arrayBuffer());
}

export async function installProfiles(
  module: Pick<OrcaModule, 'FS'>,
  source: ProfileSource,
  manifestPath = 'manifest.json',
  onProgress?: (progress: ProfileInstallProgress) => void,
) {
  const startedAt = Date.now();
  console.info('[profiles] install-start', JSON.stringify({ manifest: manifestPath }));
  const manifest = JSON.parse(new TextDecoder().decode(await readBytes(await source.fetch(manifestPath)))) as ProfileManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.packages)) throw new Error('unsupported profile manifest');
  try { module.FS.mkdir?.('/system'); } catch { /* preload may already have mounted it */ }
  const total = manifest.packages.length;
  for (const [index, pkg] of manifest.packages.entries()) {
    if (!pkg || (pkg.kind !== 'core' && pkg.kind !== 'vendor') || typeof pkg.id !== 'string' || typeof pkg.path !== 'string') {
      throw new Error('invalid profile package manifest entry');
    }
    // Package paths are deployment-relative and IDs become MEMFS directory
    // names. Reject traversal before either is fetched or mounted.
    safeEntryPath(pkg.path);
    safeEntryPath(pkg.id);
    onProgress?.({ package: pkg, index, total });
    console.info('[profiles] package', JSON.stringify({ package: pkg.id, kind: pkg.kind, index: index + 1, total }));
    try {
      const entries = unzip(await readBytes(await source.fetch(pkg.path)));
      // Preserve the virtual tree expected by libslic3r's PresetBundle.
      for (const entry of entries) {
        const relative = safeEntryPath(entry.path);
        // Vendor archives contain paths relative to their upstream vendor
        // directory; restore that directory in MEMFS. Core files remain at
        // `/system`, while OrcaFilamentLibrary and printer vendors land at
        // the exact tree consumed by PresetBundle.
        const mounted = pkg.kind === 'vendor' ? `${safeEntryPath(pkg.id)}/${relative}` : relative;
        // Non-profile runtime data is occasionally carried in the core pack.
        // Keep it at the path consumed by libslic3r instead of nesting it
        // below /system (the packaged profile tree remains under /system).
        const fullPath = mounted.startsWith('info/') ? `/${mounted}` : `/system/${mounted}`;
        mkdirParents(module.FS, fullPath.slice(0, fullPath.lastIndexOf('/')));
        module.FS.writeFile(fullPath, entry.data);
      }
      console.info('[profiles] package-installed', JSON.stringify({ package: pkg.id, kind: pkg.kind, index: index + 1, total, entries: entries.length, elapsedMs: Date.now() - startedAt }));
    } catch (error) {
      if (pkg.kind === 'core') {
        console.error('[profiles] core failure', JSON.stringify({ package: pkg.id, index: index + 1, total }), error);
        throw new Error(`core profile package ${pkg.id} failed: ${String(error)}`);
      }
      console.warn('[profiles] vendor skipped', JSON.stringify({ package: pkg.id, index: index + 1, total }), error);
    }
  }
  console.info('[profiles] install-complete', JSON.stringify({ packages: total, elapsedMs: Date.now() - startedAt }));
}

export function createFetchProfileSource(base: string | URL): ProfileSource {
  const root = new URL(base.toString());
  return { fetch: async (path) => bytes(await fetch(new URL(path, root))) };
}

/** Resolve the deployment root the host publishes static assets from (wasm/,
 *  profiles/). Built bundles emit the worker chunk under assets/, so a
 *  relative base ('.'/'./') anchors one level above the chunk; absolute bases
 *  (dev servers, configured roots) resolve directly. */
export function resolveDeploymentBase(baseUrl: string, moduleUrl: string | URL): URL {
  const deploymentBase = baseUrl === './' || baseUrl === '.'
    ? new URL('../', new URL(String(moduleUrl))).href
    : (baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  // Keep the module URL indirect so Vite does not attempt to statically
  // prebundle `new URL('./', import.meta.url)`; this is resolved at runtime
  // for site-root and subpath deployments alike.
  const Url = globalThis.URL;
  const moduleBase = new Url(String(moduleUrl));
  return new Url(deploymentBase, moduleBase);
}

/** Resolve bundled profile assets against the host's configured deployment base. */
export function resolveProfileBaseUrl(baseUrl: string, moduleUrl: string | URL): URL {
  return new URL('profiles/', resolveDeploymentBase(baseUrl, moduleUrl));
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
