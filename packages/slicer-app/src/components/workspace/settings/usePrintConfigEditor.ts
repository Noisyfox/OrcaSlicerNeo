import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConfigEditorSnapshot, NativeScopedConfigMutationRequest } from '@slicer/client';
import type { PlatformCapabilities } from '@orca/platform-contract';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useHistoryRestoreStore } from '@/stores/useHistoryRestoreStore';
import { commitPrintConfigurationMutation, readPrintConfigEditor } from './configurationActions';

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
