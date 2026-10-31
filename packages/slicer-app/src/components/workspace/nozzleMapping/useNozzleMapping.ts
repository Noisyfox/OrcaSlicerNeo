import { useEffect, useRef, useSyncExternalStore } from 'react';
import { usePlatform, type PlatformCapabilities } from '@orca/platform-contract';
import type { NozzleMappingSnapshot } from '@slicer/client';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useHistoryNavigationStore } from '@/stores/useHistoryNavigationStore';
import { waitForConfigurationMutations } from '../settings/configurationActions';
import { readProjectMutationReservation } from '../actions/historyMutation';
import { useDeviceSelectionStore } from '@/stores/useDeviceSelectionStore';
import { deviceMaterialPublicationVersion, synchronizeDeviceMaterials, useDeviceMaterialSession } from './deviceMaterials';

type Runtime = PlatformCapabilities['runtime'];
type Key = { plateId: string; plateRevision: number | undefined; revision: number | undefined; deviceRevision: number };
type Loaded = { key: Key; snapshot: NozzleMappingSnapshot | null; error: string | null };
const sameKey = (a: Key | undefined, b: Key) => a?.plateId === b.plateId && a.plateRevision === b.plateRevision && a.revision === b.revision && a.deviceRevision === b.deviceRevision;

/** One bounded, read-only projection per live Plate/runtime. Native receipts
 * remain authoritative; a new key never grants editability to an old value. */
function createProjection(runtime: Runtime) {
  const entries = new Map<string, Loaded>();
  const requests = new Map<string, { key: Key }>();
  const listeners = new Set<() => void>();
  let version = 0;
  const emit = () => { ++version; for (const listener of listeners) listener(); };
  return {
    entries,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getVersion: () => version,
    retain: (plateIds: readonly string[]) => {
      const live = new Set(plateIds);
      for (const id of entries.keys()) if (!live.has(id)) entries.delete(id);
      for (const id of requests.keys()) if (!live.has(id)) requests.delete(id);
    },
    publish: (snapshot: NozzleMappingSnapshot, revision: number) => {
      requests.delete(snapshot.plateId); // A late read cannot replace this receipt.
      entries.set(snapshot.plateId, { key: { plateId: snapshot.plateId, plateRevision: snapshot.revision, revision, deviceRevision: deviceMaterialPublicationVersion(runtime) }, snapshot, error: null });
      emit();
    },
    read: (key: Key) => {
      const cached = entries.get(key.plateId);
      if (cached?.snapshot && sameKey(cached.key, key) || sameKey(requests.get(key.plateId)?.key, key)) return;
      const request = { key }; requests.set(key.plateId, request);
      const complete = (snapshot: NozzleMappingSnapshot | null, error: string | null) => {
        if (requests.get(key.plateId) !== request) return;
        requests.delete(key.plateId); entries.set(key.plateId, { key, snapshot, error }); emit();
      };
      void waitForConfigurationMutations().then(() => synchronizeDeviceMaterials(runtime)).then(() => readProjectMutationReservation(() =>
        requests.get(key.plateId) === request ? runtime.getNozzleMapping(key.plateId) : Promise.resolve(null),
      )).then(result => {
        if (result) complete(result.ok ? result : null, result.ok ? null : result.error);
      }, error => complete(null, String(error)));
    },
  };
}
const projections = new WeakMap<Runtime, ReturnType<typeof createProjection>>();
function projectionFor(runtime: Runtime) {
  let projection = projections.get(runtime);
  if (!projection) { projection = createProjection(runtime); projections.set(runtime, projection); }
  return projection;
}

/** Publish in the same batch as history/Plate stamps, before dependent effects. */
export function publishNozzleMappingSnapshot(runtime: Runtime, snapshot: NozzleMappingSnapshot, revision: number) {
  projectionFor(runtime).publish(snapshot, revision);
}

export function useNozzleMapping(enabled = true) {
  const { runtime } = usePlatform();
  useDeviceMaterialSession(runtime);
  const deviceRevision = useDeviceSelectionStore(s => s.groupingVersion);
  const plates = usePlateSessionStore(s => s.snapshot);
  const plateId = plates?.currentPlateId;
  const plateRevision = plateId ? plates?.inputRevisions?.[plateId] : undefined;
  const revision = useHistoryNavigationStore(s => s.status?.revision);
  const projection = projectionFor(runtime);
  useSyncExternalStore(projection.subscribe, projection.getVersion, projection.getVersion);
  const previous = useRef<NozzleMappingSnapshot | null>(null);
  const previousRuntime = useRef(runtime);
  if (previousRuntime.current !== runtime) { previous.current = null; previousRuntime.current = runtime; }
  useEffect(() => {
    projection.retain(plates?.plates.map(p => p.plateId) ?? []);
    if (enabled && plateId) projection.read({ plateId, plateRevision, revision, deviceRevision });
  }, [projection, enabled, plateId, plateRevision, revision, deviceRevision, plates]);
  const loaded = plateId ? projection.entries.get(plateId) : undefined;
  const current = enabled && plateId && loaded && sameKey(loaded.key, { plateId, plateRevision, revision, deviceRevision }) &&
    (!loaded.snapshot || loaded.snapshot.revision === plateRevision);
  if (!enabled || !plateId) previous.current = null;
  else if (loaded) previous.current = loaded.snapshot;
  return { snapshot: previous.current, error: current ? loaded.error : null, revision: current ? revision : undefined };
}
