import { zipSync } from 'fflate';
import { inspectRemotePrintBundle, REMOTE_PRINT_BUNDLE_MAX_BYTES } from '../../slicer-wasm/src/client';
import type { OrcaModule, RemotePrintMetadata } from '../../slicer-wasm/src/client';

/** Metadata-only resource set used by Orca's sliced-3MF reader. Thumbnails have
 * their own bounded image reader; neither G-code nor full archives belong here. */
export const REMOTE_PRINT_RESOURCES = [
  '_rels/.rels', '3D/3dmodel.model', 'Metadata/model_settings.config',
  'Metadata/slice_info.config', 'Metadata/project_settings.config', 'Metadata/filament_sequence.json',
] as const;
export type RemotePrintResource = typeof REMOTE_PRINT_RESOURCES[number];

export interface RemotePrintResourceBytes { name: RemotePrintResource; bytes: Uint8Array }

/** Run in a disposable Worker. Hosts own its admission, timeout and termination.
 * Loading never initializes a project or activates a profile package. */
export async function inspectRemotePrintResources(
  resources: readonly RemotePrintResourceBytes[], load: () => Promise<OrcaModule>,
): Promise<RemotePrintMetadata> {
  const entries: Record<string, Uint8Array> = {};
  let total = 0;
  for (const resource of resources) {
    if (!REMOTE_PRINT_RESOURCES.includes(resource.name) || Object.hasOwn(entries, resource.name) ||
        !(resource.bytes instanceof Uint8Array) || resource.bytes.byteLength > 8 * 1024 * 1024)
      throw new Error('Invalid inspection resource');
    total += resource.bytes.byteLength;
    if (total > REMOTE_PRINT_BUNDLE_MAX_BYTES - 4096) throw new Error('Inspection metadata exceeds its size limit');
    entries[resource.name] = resource.bytes;
  }
  for (const name of ['_rels/.rels', '3D/3dmodel.model', 'Metadata/slice_info.config'])
    if (!entries[name]?.byteLength) throw new Error('Missing sliced-3MF metadata');
  const bytes = zipSync(entries, { level: 0 });
  return inspectRemotePrintBundle(await load(), bytes);
}
