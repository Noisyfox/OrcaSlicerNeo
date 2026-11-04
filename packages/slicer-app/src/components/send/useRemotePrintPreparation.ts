import { useEffect, useMemo, useRef, useState } from 'react';
import type * as D from '@orca/printer-control/domain';
import type { PlatformCapabilities } from '@orca/platform-contract';
import type { PrintPreparationViewState } from './PrintPreparationPanel';

/** Device-file source owner: no project store, slice receipt or export operation. */
export function useRemotePrintPreparation(platform: PlatformCapabilities, printer: D.SavedPrinter, inspection: D.RemotePrintInspection,
  selected: D.RemotePrintTarget, name: string, onSent: () => void): PrintPreparationViewState {
  const { service, configuration } = platform.printers;
  const [prepared, setPrepared] = useState<D.PrintPreparation | null>(null), [bindings, setBindings] = useState<readonly D.PrintMaterialBinding[]>([]);
  const [options, setOptions] = useState<D.PrintOptions>({}), [allowAbnormal, setAllowAbnormal] = useState(false);
  const [error, setError] = useState<string | null>(null), [saveError, setSaveError] = useState(false);
  const [refreshing, setRefreshing] = useState(true), [loaded, setLoaded] = useState(false), [revision, setRevision] = useState(0);
  const [active, setActive] = useState(false), [operation, setOperation] = useState<PrintPreparationViewState['operation']>(null);
  const [confirmation, setConfirmation] = useState<D.PrintPreparation | null>(null);
  const [recordingAction, setRecordingAction] = useState<D.PrintSubmissionRequest['recordingSpaceAction']>();
  const [jobName, setJobName] = useState(name);
  const live = useRef(true), sending = useRef(false), initialized = useRef(false), lifetime = useRef(new AbortController());
  const saving = useRef(Promise.resolve()), sent = useRef(onSent); sent.current = onSent;
  const file = inspection.ref.file;
  const target = useMemo(() => ({ printerId: file.printerId, routeId: file.routeId }), [file.printerId, file.routeId]);
  const request = useMemo<D.RemotePrintPreparationRequest>(() => ({ inspection: inspection.ref, targetId: selected.id,
    bindings, options, suggest: !initialized.current, allowAbnormalStorage: allowAbnormal }), [inspection, selected.id, bindings, options, allowAbnormal]);

  async function refresh() {
    if (sending.current) return;
    setRefreshing(true);
    try {
      const result = await service.observations.read({ target, topics: ['status', 'materials', 'descriptor', 'firmware'], source: 'device' }, { signal: lifetime.current.signal });
      if (!live.current) return;
      if (!result.ok) setError(result.error.message);
      else { setError(null); setRevision(v => v + 1); }
    } catch { if (live.current) setError('Printer status is unavailable. Refresh to try again.'); }
    finally { if (live.current) setRefreshing(false); }
  }
  useEffect(() => {
    live.current = true; lifetime.current = new AbortController();
    void (async () => {
      const config = await configuration.load(); if (!live.current) return;
      setOptions(config.printPreferences?.[printer.identity.id] ?? {}); setAllowAbnormal(config.allowAbnormalStorage ?? false);
      await refresh(); if (live.current) setLoaded(true);
    })().catch(() => { if (live.current) { setError('Printer preferences are unavailable. Reopen this dialog.'); setRefreshing(false); } });
    return () => { live.current = false; lifetime.current.abort(); };
  }, [configuration, printer.identity.id, service, target]);
  useEffect(() => {
    if (!loaded || sending.current) return;
    const abort = new AbortController();
    void service.remotePrints.prepare(request, { signal: abort.signal }).then(result => {
      if (abort.signal.aborted || !live.current || sending.current) return;
      if (!result.ok) { setError(result.error.message); return; }
      setPrepared(result.value); setError(null);
      if (!initialized.current && !result.value.issues.some(i => i.id === 'offline')) {
        initialized.current = true; setBindings(result.value.bindings);
      }
    }).catch(() => { if (!abort.signal.aborted && live.current) setError('Device file preparation is unavailable. Refresh to try again.'); });
    return () => abort.abort();
  }, [service, request, loaded, revision, active]);
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      for await (const _ of service.observations.watch({ target, topics: ['status', 'materials', 'descriptor', 'firmware'] }, { signal: abort.signal })) {
        if (abort.signal.aborted) return; setRevision(v => v + 1);
      }
    })().catch(() => { /* Explicit refresh remains available after an observation gap. */ });
    // Agent preparation uses cached telemetry. No file polling or metadata reload.
    const timer = setInterval(() => { if (!sending.current) setRevision(v => v + 1); }, 2000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [service, target]);

  function changeOption(key: keyof D.PrintOptions, value: string | boolean) {
    setOptions(p => ({ ...p, [key]: value })); setConfirmation(null); setRecordingAction(undefined);
    if (key === 'externalChangeAssist') return;
    setSaveError(false);
    saving.current = saving.current.then(async () => {
      const config = await configuration.load();
      await configuration.save({ ...config, printPreferences: { ...config.printPreferences,
        [printer.identity.id]: { ...config.printPreferences?.[printer.identity.id], [key]: value } } });
    }).catch(() => { if (live.current) setSaveError(true); });
  }
  function changeBinding(materialKey: string, pathId: string) {
    setBindings(p => [...p.filter(b => b.materialKey !== materialKey), ...(pathId ? [{ materialKey, pathId: pathId as D.Id<'path'> }] : [])]);
    setConfirmation(null); setRecordingAction(undefined);
  }
  const canPrint = !!prepared && !!selected.requirements && selected.availability.kind === 'available' &&
    !prepared.issues.some(i => i.severity === 'block') && !error && !active && operation?.phase !== 'unknown';
  async function send(confirmed = false) {
    if (!canPrint || sending.current) return;
    sending.current = true; setActive(true); setError(null);
    let dispatched = false;
    const unknown = () => setOperation({ phase: 'unknown', message: 'Print start is unconfirmed. Check the printer before sending another request.', progress: null, canCancel: false });
    try {
      const checked = await service.remotePrints.prepare({ ...request, suggest: false, checkRecording: true }, { signal: lifetime.current.signal });
      if (!live.current) return;
      if (!checked.ok) { setError(checked.error.message); return; }
      setPrepared(checked.value);
      if (checked.value.issues.some(i => i.severity === 'block')) { setConfirmation(null); return; }
      const acknowledged = confirmed ? confirmation?.issues.filter(i => i.severity === 'warning').map(i => i.id) ?? [] : [];
      if (checked.value.issues.some(i => i.severity === 'warning' && !acknowledged.includes(i.id)) || checked.value.recordingSpace?.status === 'insufficient' && recordingAction !== 'disable-timelapse') {
        setConfirmation(checked.value); return;
      }
      setOperation({ phase: 'sending', message: 'Sending device-file print request…', progress: null, canCancel: false });
      setConfirmation(null);
      dispatched = true;
      const result = await service.controls.submit({ target: { ...target, expectedConfigurationRevision: file.configurationRevision },
        requestId: crypto.randomUUID() as D.Id<'request'>, command: { type: 'jobs.start', params: { source: file,
          inspection: { id: inspection.ref.id, targetId: selected.id }, bindings,
          options: recordingAction === 'disable-timelapse' ? { ...options, timelapse: false } : options,
          acknowledgedIssues: acknowledged, allowAbnormalStorage: allowAbnormal } } });
      if (!live.current) return;
      if (result.kind === 'rejected') { setOperation(null); setError(result.error.message); return; }
      if (result.kind === 'outcome-unknown') { unknown(); return; }
      setConfirmation(null);
      for await (const next of service.operations.watch(result.operation, { signal: lifetime.current.signal })) {
        if (!live.current) return;
        if (next.phase.kind === 'submitted' || next.phase.kind === 'accepted' || next.phase.kind === 'completed') { sent.current(); return; }
        if (next.phase.kind === 'failed') { setOperation({ phase: 'failed', message: next.phase.error.message, progress: null, canCancel: false }); return; }
        if (next.phase.kind === 'outcome-unknown') { unknown(); return; }
      }
      if (live.current) unknown();
    } catch { if (live.current) { if (dispatched) unknown(); else setError('Device file preparation failed. Refresh before trying again.'); } }
    finally { sending.current = false; if (live.current) setActive(false); }
  }
  return { requirements: selected.requirements, prepared, bindings, options, error, saveError, refreshing, active, canPrint, operation, confirmation,
    recordingAction, jobName, setJobName, refresh, changeOption, changeBinding, send, cancel: async () => {}, setRecordingAction,
    dismissConfirmation: () => { setConfirmation(null); setRecordingAction(undefined); } };
}
