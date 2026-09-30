import type { HistoryObservabilitySnapshot } from '../history/historyDiagnostics';
import type { ProjectLoadReceipt } from '../projectActions';

declare const __ORCA_E2E__: boolean;

export interface OrcaE2eHooks extends Record<string, unknown> {
  gizmoAxis?: () => string | null;
  gizmoAxisLineWorldPosition?: () => [number, number, number] | null;
  selectionBoxWorldSegments?: () => {
    min: [number, number, number];
    max: [number, number, number];
    segmentCount: number;
  } | null;
  gpuStreamingStatus?: () => 'ready' | 'context-lost' | 'disposed' | 'unavailable';
  gpuStreamingDiagnostic?: () => { reason: string; message: string } | null;
  gpuStreamingColorSamples?: () => readonly (readonly [number, number, number])[];
  previewEvidence?: () => Promise<{
    extrusionTools: readonly number[];
    toolChanges: readonly number[];
    palette: readonly { tool: number; color: readonly number[] }[];
    renderedColors: readonly (readonly [number, number, number])[];
  } | null>;
  primeTowerStates?: () => unknown[];
  primeTowerSelection?: () => string | null;
  primeTowerMoveCommands?: () => number;
  primeTowerCommitBusy?: () => boolean;
  primeTowerProxyIds?: () => string[];
  historyDiagnostics?: () => HistoryObservabilitySnapshot;
  modelMeshResponse?: () => unknown;
  previewFirstCommitPaintMaterialsByVolume?: Record<string, unknown[]>;
  projectLoadEvidence?: () => {
    receipt: ProjectLoadReceipt | null;
    session: { projectName: string; hasContent: boolean; scope: string; hasLocation: boolean };
  };
  takeNativePerformanceProfile?: () => Promise<unknown>;
  takeRealProjectProfileSnapshot?: () => Promise<unknown>;
  realProjectProfileActiveSliceCount?: () => Promise<unknown>;
  realProjectProfileLastRestoreSliceActive?: () => boolean | null;
  realProjectProfileMutationPendingCount?: () => number;
}

declare global {
  interface Window {
    __orcaE2e?: OrcaE2eHooks;
  }
}

type OwnerRegistration = { unregister: () => void };

let registrationsByWindow: WeakMap<Window, Map<string, OwnerRegistration>> | undefined;

function ownerRegistrationsFor(target: Window): Map<string, OwnerRegistration> {
  registrationsByWindow ??= new WeakMap();
  let registrations = registrationsByWindow.get(target);
  if (!registrations) {
    registrations = new Map();
    registrationsByWindow.set(target, registrations);
  }
  return registrations;
}

export function registerOrcaE2eOwner<THooks extends OrcaE2eHooks>(owner: string, hooks: THooks): () => void {
  if (!__ORCA_E2E__) return () => {};

  const target = window;
  ownerRegistrationsFor(target).get(owner)?.unregister();
  const registrations = ownerRegistrationsFor(target);
  const api = target.__orcaE2e ?? (target.__orcaE2e = {});

  const entries = Object.entries(hooks);
  for (const [key, value] of entries) api[key] = value;

  let active = true;
  const unregister = () => {
    if (!active) return;
    active = false;

    for (const [key, value] of entries) {
      if (api[key] === value) delete api[key];
    }

    if (target.__orcaE2e === api && Object.keys(api).length === 0) delete target.__orcaE2e;
    if (registrations.get(owner)?.unregister === unregister) registrations.delete(owner);
    if (registrations.size === 0) registrationsByWindow?.delete(target);
  };

  registrations.set(owner, { unregister });
  return unregister;
}

/**
 * Child passive effects may run before a parent scene's reset effect. Queue
 * publication until the current passive-effect flush has completed.
 */
export function registerOrcaE2eOwnerAfterPassiveEffects<THooks extends OrcaE2eHooks>(
  owner: string,
  hooks: THooks,
): () => void {
  let cancelled = false;
  let unregister: (() => void) | undefined;
  queueMicrotask(() => {
    if (cancelled) return;
    unregister = registerOrcaE2eOwner(owner, hooks);
  });
  return () => {
    cancelled = true;
    unregister?.();
  };
}
