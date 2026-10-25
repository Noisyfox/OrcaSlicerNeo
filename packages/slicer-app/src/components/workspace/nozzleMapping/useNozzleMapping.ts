import { useEffect, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import type { NozzleMappingSnapshot } from '@slicer/client';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useHistoryNavigationStore } from '@/stores/useHistoryNavigationStore';
import { waitForConfigurationMutations } from '../settings/configurationActions';
import { readProjectMutationReservation } from '../actions/historyMutation';

/** Read-only, revision-bound projection. Native configuration remains the owner. */
export function useNozzleMapping(enabled = true) {
  const { runtime } = usePlatform();
  const plateId = usePlateSessionStore(s => s.snapshot?.currentPlateId);
  const plateRevision = usePlateSessionStore(s => plateId ? s.snapshot?.inputRevisions?.[plateId] : undefined);
  const revision = useHistoryNavigationStore(s => s.status?.revision);
  const [loaded, setLoaded] = useState<{ snapshot: NozzleMappingSnapshot | null; error: string | null;
    plateId: string; plateRevision: number | undefined; revision: number | undefined } | null>(null);
  useEffect(() => {
    if (!enabled || !plateId) return;
    let active = true;
    void waitForConfigurationMutations().then(() => readProjectMutationReservation(() => runtime.getNozzleMapping(plateId))).then(result => {
      if (active) setLoaded({ plateId, plateRevision, revision,
        snapshot: result.ok ? result : null, error: result.ok ? null : result.error });
    }, error => {
      if (active) setLoaded({ plateId, plateRevision, revision, snapshot: null, error: String(error) });
    });
    return () => { active = false; };
  }, [enabled, runtime, plateId, plateRevision, revision]);
  const current = enabled && loaded?.plateId === plateId && loaded?.plateRevision === plateRevision && loaded?.revision === revision;
  return { snapshot: enabled && loaded && loaded.plateId === plateId ? loaded.snapshot : null,
    error: current ? loaded?.error ?? null : null, revision: current ? revision : undefined };
}
