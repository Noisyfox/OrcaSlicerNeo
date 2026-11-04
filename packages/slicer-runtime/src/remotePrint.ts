import { zipSync } from 'fflate';
import { inspectRemotePrintBundle } from '../../slicer-wasm/src/client';
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
  const entries = Object.fromEntries(resources.map(resource => [resource.name, resource.bytes]));
  const bytes = zipSync(entries, { level: 0 });
  return inspectRemotePrintBundle(await load(), bytes);
}
