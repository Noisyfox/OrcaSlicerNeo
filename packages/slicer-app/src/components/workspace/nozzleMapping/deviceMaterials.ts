import { useEffect } from 'react';
import type { PlatformCapabilities } from '@orca/platform-contract';
import { useDeviceSelectionStore } from '@/stores/useDeviceSelectionStore';

type Runtime = PlatformCapabilities['runtime'];
type Publication = { key: string; promise: Promise<void>; version: number; failed: boolean };
const publications = new WeakMap<Runtime, Publication>();
const appliedVersions = new WeakMap<Runtime, number>();

/** Publish observations in order, without device I/O or a project mutation. All
 * mapping reads/edits and Slice admission await the latest publication. */
export async function synchronizeDeviceMaterials(runtime: Runtime): Promise<void> {
  const state = useDeviceSelectionStore.getState();
  const context = state.groupingContext, version = state.groupingVersion;
  const key = JSON.stringify(context);
  let publication = publications.get(runtime);
  if (!publication && !context) { appliedVersions.set(runtime, version); return; }
  if (!publication || publication.failed || publication.key !== key || publication.version !== version) {
    const predecessor = publication?.promise ?? Promise.resolve();
    const next: Publication = { key, version, promise: Promise.resolve(), failed: false };
    next.promise = predecessor.catch(() => undefined).then(async () => {
      const result = await runtime.setDeviceMaterialContext(context);
      if (!result.ok) throw new Error(result.error);
      appliedVersions.set(runtime, version);
    }).catch(error => { next.failed = true; throw error; });
    publications.set(runtime, next); publication = next;
  }
  await publication.promise;
  if (useDeviceSelectionStore.getState().groupingVersion !== version) await synchronizeDeviceMaterials(runtime);
}

export const deviceMaterialPublicationVersion = (runtime: Runtime) => appliedVersions.get(runtime) ?? 0;

export function useDeviceMaterialSession(runtime: Runtime) {
  const version = useDeviceSelectionStore(s => s.groupingVersion);
  useEffect(() => { void synchronizeDeviceMaterials(runtime).catch(() => undefined); }, [runtime, version]);
}
