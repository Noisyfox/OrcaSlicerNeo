import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConfigEditorSnapshot, NativeScopedConfigMutationRequest, ScopedConfigEditorSnapshot, ScopedConfigEditorTarget } from '@slicer/client';
import type { PlatformCapabilities } from '@orca/platform-contract';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useHistoryRestoreStore } from '@/stores/useHistoryRestoreStore';
import { commitPrintConfigurationMutation, readPrintConfigEditor, commitScopedEditorMutation, readScopedConfigEditor } from './configurationActions';

export function useScopedConfigEditor(platform: PlatformCapabilities, targets: readonly ScopedConfigEditorTarget[], enabled: boolean) {
  const base = useSettingsStore(state => state.baseValues);
  const revision = useSettingsStore(state => state.nativeScopedConfigRevision);
  const entry = useSettingsStore(state => state.printEditorEntry);
  const metadata = useSettingsStore(state => state.metadata);
  const printer = useSettingsStore(state => state.selectedPrinter);
  const print = useSettingsStore(state => state.selectedPrint);
  const historyRevision = useHistoryRestoreStore(state => state.revision);
  const historyPhase = useHistoryRestoreStore(state => state.phase);
  const identity = JSON.stringify(targets);
  const stamp = { identity, base, revision, entry, metadata, printer, print, historyRevision, enabled, historyPhase };
  const latest = useRef(stamp); latest.current = stamp;
  const [loaded, setLoaded] = useState<{ snapshot: ScopedConfigEditorSnapshot; stamp: typeof stamp } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  useEffect(() => {
    if (!enabled || !targets.length || !metadata || historyPhase !== 'idle') return;
    let current = true;
    const isCurrent = () => current && Object.entries(stamp).every(([key, value]) => latest.current[key as keyof typeof stamp] === value) &&
      useSettingsStore.getState().nativeScopedConfigRevision === revision && useSettingsStore.getState().baseValues === base &&
      useSettingsStore.getState().printEditorEntry === entry && useHistoryRestoreStore.getState().revision === historyRevision &&
      useHistoryRestoreStore.getState().phase === 'idle';
    setRefreshing(true); setError(null);
    void readScopedConfigEditor(platform, targets).then(result => {
      if (!isCurrent()) return;
      if (!result.ok) throw new Error(result.error);
      setLoaded({ snapshot: result, stamp });
    }).catch(reason => { if (isCurrent()) setError(String(reason)); })
      .finally(() => { if (current) setRefreshing(false); });
    return () => { current = false; };
  }, [base, enabled, entry, historyPhase, historyRevision, identity, metadata, platform, print, printer, revision]);
  const snapshot = loaded && Object.entries(stamp).every(([key, value]) =>
    key === 'enabled' || key === 'historyPhase' || loaded.stamp[key as keyof typeof stamp] === value) ? loaded.snapshot : null;
  const mutate = useCallback(async (request: NativeScopedConfigMutationRequest, capturedTargets: readonly ScopedConfigEditorTarget[]) => {
    if (pendingRef.current || refreshing || !snapshot || error || historyPhase !== 'idle') throw new Error('Scoped configuration is not ready for another edit.');
    pendingRef.current = true; setPending(true);
    const capturedIdentity = identity, capturedEntry = entry, capturedHistory = historyRevision;
    try {
      const next = await commitScopedEditorMutation(platform, request, capturedTargets);
      const view = latest.current;
      const settings = useSettingsStore.getState();
      if (view.identity === capturedIdentity && settings.printEditorEntry === capturedEntry &&
          useHistoryRestoreStore.getState().revision === capturedHistory && settings.selectedPrinter === printer &&
          settings.selectedPrint === print && settings.baseValues === base && settings.metadata === metadata &&
          settings.nativeScopedConfigRevision === next.revision)
        setLoaded({ snapshot: next, stamp: { ...view, base, metadata, revision: next.revision } });
      return next;
    } finally { pendingRef.current = false; setPending(false); }
  }, [base, entry, error, historyPhase, historyRevision, identity, metadata, platform, print, printer, refreshing, snapshot]);
  // Same-owner refreshes retain their controls and local text. This projection
  // is display-only: mutations still require the fully current snapshot above.
  const displaySnapshot = loaded && loaded.stamp.identity === identity && loaded.stamp.entry === entry &&
    loaded.stamp.printer === printer && loaded.stamp.print === print && loaded.stamp.metadata === metadata ? loaded.snapshot : null;
  return { snapshot, displaySnapshot, selection: loaded?.stamp.entry === entry ? loaded.snapshot.editorSelection : null, identity, entry, error, pending,
    refreshing: refreshing || !snapshot || historyPhase !== 'idle', mutate };
}

export function usePrintConfigEditor(platform: PlatformCapabilities, enabled: boolean) {
  const base = useSettingsStore(state=>state.baseValues);
  const revision = useSettingsStore(state=>state.nativeScopedConfigRevision);
  const entry = useSettingsStore(state=>state.printEditorEntry);
  const printer = useSettingsStore(state=>state.selectedPrinter);
  const print = useSettingsStore(state=>state.selectedPrint);
  const metadata = useSettingsStore(state=>state.metadata);
  const historyRevision = useHistoryRestoreStore(state=>state.revision);
  const historyPhase = useHistoryRestoreStore(state=>state.phase);
  const [snapshot,setSnapshot] = useState<ConfigEditorSnapshot|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [refreshing,setRefreshing] = useState(false);
  const [pending,setPending] = useState(false);
  const [loadedEntry,setLoadedEntry]=useState(entry);
  const pendingRef=useRef(false);
  useEffect(()=>{
    if(!enabled || !metadata || historyPhase!=='idle') return;
    let current=true;
    const isCurrent=()=>current && useSettingsStore.getState().baseValues===base &&
      useSettingsStore.getState().nativeScopedConfigRevision===revision && useSettingsStore.getState().metadata===metadata &&
      useSettingsStore.getState().printEditorEntry===entry && useSettingsStore.getState().selectedPrinter===printer &&
      useSettingsStore.getState().selectedPrint===print && useHistoryRestoreStore.getState().revision===historyRevision &&
      useHistoryRestoreStore.getState().phase==='idle';
    if(!pendingRef.current) setRefreshing(true);
    void readPrintConfigEditor(platform).then(result=>{
      if(!isCurrent()) return;
      if(!result.ok) throw new Error(result.error);
      setSnapshot(result);setLoadedEntry(entry);setError(null);
    }).catch(reason=>{if(isCurrent())setError(String(reason));}).finally(()=>{if(current)setRefreshing(false);});
    return ()=>{current=false;};
  },[base,enabled,entry,historyPhase,historyRevision,metadata,platform,print,printer,revision]);
  const mutate=useCallback(async(request:NativeScopedConfigMutationRequest)=>{
    if(pendingRef.current || refreshing || !snapshot || error) throw new Error('Print configuration is not ready for another edit.');
    pendingRef.current=true;setPending(true);
    const capturedEntry=entry,capturedHistory=historyRevision;
    try {
      const next=await commitPrintConfigurationMutation(platform,request);
      if(useSettingsStore.getState().printEditorEntry===capturedEntry && useHistoryRestoreStore.getState().revision===capturedHistory) setSnapshot(next);
      return next;
    } finally {pendingRef.current=false;setPending(false);}
  },[entry,error,historyRevision,platform,refreshing,snapshot]);
  return {snapshot,entry,error,pending,refreshing:refreshing || loadedEntry!==entry || historyPhase!=='idle',mutate};
}
