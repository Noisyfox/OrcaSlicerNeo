import { unzipSync } from 'fflate';
import type { OrcaModule } from '@slicer/client';
import { installProfileArchive, safeProfilePath } from '@slicer/client';

export interface ProfilePackage { id: string; kind: 'core' | 'vendor'; path: string; }
export interface ProfileManifest { version: 1; packages: ProfilePackage[]; }
export interface ProfileSource { fetch(relativePath: string): Promise<Uint8Array | ReadableStream<Uint8Array>>; }

export interface HotendPrinter { vendor_id: string; model: string; }

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
// (packages/profile-resources) writes deflated archives.
function unzip(data: Uint8Array): Array<{ path: string; data: Uint8Array }> {
  const files = unzipSync(data);
  return Object.entries(files)
    .filter(([path]) => !path.endsWith('/'))
    .map(([path, content]) => ({ path, data: content }));
}

function archiveEntry(data: Uint8Array, path: string): Uint8Array | null {
  const files = unzipSync(data, { filter: (file) => file.name === path });
  return files[path] ?? null;
}

function archiveEntries(data: Uint8Array, predicate: (path: string) => boolean): Array<{ path: string; data: Uint8Array }> {
  const files = unzipSync(data, { filter: (file) => predicate(file.name) });
  return Object.entries(files).map(([path, content]) => ({ path, data: content }));
}

function manifestPackage(manifest: ProfileManifest, kind: ProfilePackage['kind'], id?: string): ProfilePackage | null {
  return manifest.packages.find((pkg) => pkg.kind === kind && (id === undefined || pkg.id === id)) ?? null;
}

async function readProfileManifest(source: ProfileSource): Promise<ProfileManifest> {
  const value = JSON.parse(new TextDecoder().decode(await readBytes(await source.fetch('manifest.json')))) as ProfileManifest;
  if (value.version !== 1 || !Array.isArray(value.packages)) throw new Error('unsupported profile manifest');
  return value;
}

/**
 * Reads Orca's selected printer hotend directly from the profile archives.
 * Machine JSON is used as the authoritative vendor/model -> hotend_model
 * mapping; only machine JSON entries and the selected STL are extracted.
 */
export async function readHotendProfileAsset(
  source: ProfileSource,
  printer: HotendPrinter | null,
): Promise<Uint8Array | null> {
  const manifest = await readProfileManifest(source);
  const core = manifestPackage(manifest, 'core');

  if (printer) {
    const vendor = manifestPackage(manifest, 'vendor', printer.vendor_id);
    if (vendor) {
      try {
        const archive = await readBytes(await source.fetch(vendor.path));
        const machineEntries = archiveEntries(archive, (path) => path.startsWith(`${vendor.id}/machine/`) && path.toLowerCase().endsWith('.json'));
        for (const machine of machineEntries) {
          try {
            const value = JSON.parse(new TextDecoder().decode(machine.data)) as { name?: unknown; hotend_model?: unknown };
            if (value.name !== printer.model || typeof value.hotend_model !== 'string' || !value.hotend_model) continue;
            const entry = value.hotend_model.replaceAll('\\', '/');
            if (!entry || entry.startsWith('/') || entry.split('/').some((part) => !part || part === '.' || part === '..')) continue;
            const selected = archiveEntry(archive, `${vendor.id}/${entry}`);
            if (selected) return selected;
          } catch {
            // An optional malformed machine profile does not prevent fallback.
          }
        }
      } catch {
        // Optional vendor package failures use the core fallback below.
      }
    }
  }

  if (!core) return null;
  try {
    return archiveEntry(await readBytes(await source.fetch(core.path)), 'hotend.stl');
  } catch {
    return null;
  }
}

async function readBytes(value: Uint8Array | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(await new Response(value).arrayBuffer());
}

export async function installProfiles(
  module: { FS: Pick<OrcaModule['FS'], 'mkdir' | 'writeFile' | 'readFile'> },
  source: ProfileSource,
  manifestPath = 'manifest.json',
  onProgress?: (progress: ProfileInstallProgress) => void,
) {
  const startedAt = Date.now();
  console.info('[profiles] install-start', JSON.stringify({ manifest: manifestPath }));
  const manifest = JSON.parse(new TextDecoder().decode(await readBytes(await source.fetch(manifestPath)))) as ProfileManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.packages)) throw new Error('unsupported profile manifest');
  const total = manifest.packages.length;
  for (const [index, pkg] of manifest.packages.entries()) {
    if (!pkg || (pkg.kind !== 'core' && pkg.kind !== 'vendor') || typeof pkg.id !== 'string' || typeof pkg.path !== 'string') {
      throw new Error('invalid profile package manifest entry');
    }
    // Reject unsafe manifest paths and IDs before fetching any archive.
    safeProfilePath(pkg.path);
    safeProfilePath(pkg.id);
    onProgress?.({ package: pkg, index, total });
    console.info('[profiles] package', JSON.stringify({ package: pkg.id, kind: pkg.kind, index: index + 1, total }));
    try {
      const entries = unzip(await readBytes(await source.fetch(pkg.path)));
      installProfileArchive(module, pkg.kind, entries);
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
