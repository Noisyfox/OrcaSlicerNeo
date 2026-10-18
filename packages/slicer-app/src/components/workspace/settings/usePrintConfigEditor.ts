import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ConfigEditorSnapshot, NativeScopedConfigMutationRequest, ScopedConfigEditorSnapshot, ScopedConfigEditorTarget } from '@slicer/client';
import type { PlatformCapabilities } from '@orca/platform-contract';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useHistoryRestoreStore } from '@/stores/useHistoryRestoreStore';
import { commitPrintConfigurationMutation, readConfigurationEditor, commitScopedEditorMutation } from './configurationActions';
import { EditorSnapshotController } from './editorSnapshotController';

function editorContext(runtime: PlatformCapabilities['runtime'], targets: readonly ScopedConfigEditorTarget[] | null, enabled: boolean) {
  const settings = useSettingsStore.getState();
  const history = useHistoryRestoreStore.getState();
  return { runtime, targets, enabled, identity: targets === null ? 'project' : JSON.stringify(targets),
    base: settings.baseValues, refreshRequired: settings.nativeScopedConfigRefreshRequired, revision: settings.nativeScopedConfigRevision, entry: settings.printEditorEntry,
    metadata: settings.metadata, printer: settings.selectedPrinter, print: settings.selectedPrint,
    historyRevision: history.revision, historyPhase: history.phase };
}
type EditorContext = ReturnType<typeof editorContext>;
const contextKeys = ['runtime', 'identity', 'base', 'revision', 'entry', 'metadata', 'printer', 'print', 'historyRevision', 'refreshRequired'] as const;
const sameContext = (left: EditorContext, right: EditorContext) => contextKeys.every(key => left[key] === right[key]);
const sameOwner = (left: EditorContext, right: EditorContext) =>
  left.runtime === right.runtime && left.identity === right.identity && left.entry === right.entry &&
  left.metadata === right.metadata && left.printer === right.printer && left.historyRevision === right.historyRevision;
const readable = (context: EditorContext) => context.enabled && !context.refreshRequired && context.metadata !== null && context.revision !== null &&
  context.historyPhase === 'idle' && (context.targets === null || context.targets.length > 0);

function useEditorSession<Snapshot extends { ok: true; revision: number }>(platform: PlatformCapabilities,
  targets: readonly ScopedConfigEditorTarget[] | null, enabled: boolean,
  read: (context: EditorContext) => Promise<Snapshot | { ok: false; error: string }>) {
  const base = useSettingsStore(state => state.baseValues);
  const revision = useSettingsStore(state => state.nativeScopedConfigRevision);
  const entry = useSettingsStore(state => state.printEditorEntry);
  const refreshRequired = useSettingsStore(state => state.nativeScopedConfigRefreshRequired);
  const metadata = useSettingsStore(state => state.metadata);
  const printer = useSettingsStore(state => state.selectedPrinter);
  const print = useSettingsStore(state => state.selectedPrint);
  const historyRevision = useHistoryRestoreStore(state => state.revision);
  const historyPhase = useHistoryRestoreStore(state => state.phase);
  const identity = targets === null ? 'project' : JSON.stringify(targets);
  const committed = useRef({ targets, enabled });
  const controller = useMemo(() => new EditorSnapshotController<EditorContext, Snapshot>({
    context: () => editorContext(platform.runtime, committed.current.targets, committed.current.enabled),
    same: sameContext, sameOwner, readable, revision: context => context.revision,
    schedule: readConfigurationEditor, read,
  }), [platform.runtime]);
  const state = useSyncExternalStore(controller.subscribe, controller.get, controller.get);
  useLayoutEffect(() => {
    committed.current = { targets, enabled };
    void controller.refresh();
  }, [controller, identity, enabled, base, revision, entry, metadata, printer, print, historyRevision, historyPhase, refreshRequired]);
  useEffect(() => { controller.start(); return () => controller.stop(); }, [controller]);
  const context = editorContext(platform.runtime, targets, enabled);
  const current = readable(context) && state.loaded !== null && sameContext(state.loaded.context, context);
  return { controller, state, context, current };
}

export function useScopedConfigEditor(platform: PlatformCapabilities, targets: readonly ScopedConfigEditorTarget[], enabled: boolean) {
  const { controller, state, context, current } = useEditorSession<ScopedConfigEditorSnapshot>(platform, targets, enabled,
    context => context.runtime.getScopedConfigEditor({ version: 1, targets: context.targets! }));
  const mutate = useCallback((request: NativeScopedConfigMutationRequest, capturedTargets: readonly ScopedConfigEditorTarget[]) =>
    controller.mutate(publish => commitScopedEditorMutation(platform, request, capturedTargets, publish)), [controller, platform]);
  const loaded = state.loaded;
  // Display-only retention cannot authorize a mutation. The controller checks
  // the complete context and uses the final receipt's current revision.
  const displaySnapshot = loaded && loaded.context.identity === context.identity && loaded.context.entry === context.entry &&
    loaded.context.printer === context.printer && loaded.context.print === context.print && loaded.context.metadata === context.metadata
    ? loaded.snapshot : null;
  return { snapshot: current ? loaded!.snapshot : null, displaySnapshot,
    selection: loaded?.context.entry === context.entry ? loaded.snapshot.editorSelection : null,
    identity: context.identity, entry: context.entry, error: state.error, pending: state.pending,
    refreshing: state.refreshing || !current || context.historyPhase !== 'idle', mutate };
}

export function usePrintConfigEditor(platform: PlatformCapabilities, enabled: boolean) {
  const { controller, state, context, current } = useEditorSession<ConfigEditorSnapshot>(platform, null, enabled,
    context => context.runtime.getPrintConfigEditor());
  const mutate = useCallback((request: NativeScopedConfigMutationRequest) =>
    controller.mutate(publish => commitPrintConfigurationMutation(platform, request, publish)), [controller, platform]);
  return { snapshot: state.loaded?.snapshot ?? null, entry: context.entry, error: state.error, pending: state.pending,
    refreshing: state.refreshing || !current || context.historyPhase !== 'idle', mutate };
}
