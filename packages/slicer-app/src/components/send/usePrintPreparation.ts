import { useEffect, useRef, useState } from 'react';
import type * as D from '@orca/printer-control/domain';
import type { SliceResultReceipt } from '@slicer/client';
import type { PlatformCapabilities } from '@orca/platform-contract';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { projectFilenameBase, useProjectStore } from '@/stores/useProjectStore';

export function usePrintPreparation(platform: PlatformCapabilities, printer: D.SavedPrinter, route: D.PrinterRoute, receipt: SliceResultReceipt | undefined, onStarted: () => void) {
  const [requirements, setRequirements] = useState<D.PrintRequirements | null>(null);
  const [prepared, setPrepared] = useState<D.PrintPreparation | null>(null);
  const [options, setOptions] = useState<D.PrintOptions>({});
  const [bindings, setBindings] = useState<readonly D.PrintMaterialBinding[]>([]);
  const [allowAbnormal, setAllowAbnormal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [operation, setOperation] = useState<D.PrintSubmissionState | null>(null);
  const [confirmation, setConfirmation] = useState<D.PrintPreparation | null>(null);
  const [recordingAction, setRecordingAction] = useState<D.PrintSubmissionRequest['recordingSpaceAction']>();
  const live = useRef(true), initialized = useRef(false), sourceReceipt = useRef(receipt);
  const refreshVersion = useRef(0), saveChain = useRef(Promise.resolve()), saveVersion = useRef(0);
  const watchAbort = useRef(new AbortController()), started = useRef(onStarted); started.current = onStarted;
  const request = useRef<D.PrintPreparationRequest | null>(null);
  const target = { printerId: printer.identity.id, routeId: route.id, expectedConfigurationRevision: route.configurationRevision };
  if (requirements) request.current = { target, requirements, bindings, options, allowAbnormalStorage: allowAbnormal, suggest: !initialized.current };
  const active = exporting || !!operation && !['failed', 'cancelled', 'unknown', 'started'].includes(operation.phase);
  const activeRef = useRef(active); activeRef.current = active;
  const canPrint = !!prepared && !prepared.issues.some(i => i.severity === 'block') && !error && !saveError && !saving && !active && operation?.phase !== 'unknown';

  useEffect(() => {
    live.current = true; watchAbort.current = new AbortController();
    void (async () => {
      const config = await platform.printers.configuration.load();
      if (!sourceReceipt.current) {
        const session = await platform.runtime.getPlateSessionSnapshot();
        if (!session.ok) throw new Error('No current plate');
        sourceReceipt.current = useSlicerStore.getState().plateResults[session.currentPlateId]?.receipt;
      }
      if (!sourceReceipt.current) throw new Error('No current slice');
      const manifest = await platform.runtime.describePrintPlate(sourceReceipt.current);
      if (!manifest.ok) throw new Error(manifest.error);
      if (!live.current) return;
      setOptions(config.printPreferences?.[printer.identity.id] ?? {});
      setAllowAbnormal(config.allowAbnormalStorage ?? false);
      setRequirements({ ...manifest.manifest, contentId: JSON.stringify(sourceReceipt.current) });
    })().catch(() => { if (live.current) setError('The current slice or printer preferences are unavailable. Close this dialog and try again.'); });
    return () => { live.current = false; watchAbort.current.abort(); refreshVersion.current++; };
  }, [platform, printer.identity.id]);

  async function refresh() {
    if (!request.current || activeRef.current) return;
    const version = ++refreshVersion.current;
    try {
      const next = await platform.printers.service.submissions.prepare(request.current);
      if (!live.current || version !== refreshVersion.current || activeRef.current) return;
      if (!next.ok) { setError(next.error.message); return; }
      setPrepared(next.value); setError(null);
      if (!initialized.current && !next.value.issues.some(i => i.id === 'offline')) {
        initialized.current = true; setBindings(next.value.bindings);
      }
    } catch { if (live.current && version === refreshVersion.current) setError('Printer status is unavailable. Waiting for automatic recovery.'); }
  }
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => { void refresh(); }, [requirements, options, bindings, allowAbnormal, route.configurationRevision, active]);
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      for await (const _event of platform.printers.service.observations.watch({ target: { printerId: target.printerId, routeId: target.routeId }, topics: ['status', 'materials', 'descriptor', 'firmware'] }, { signal: abort.signal })) {
        if (abort.signal.aborted) return;
        void refreshRef.current();
      }
    })().catch(() => { if (!abort.signal.aborted) setError('Printer monitoring is unavailable. Waiting for automatic recovery.'); });
    // Validation reads cached agent state; it does not poll or reconnect the printer.
    const timer = setInterval(() => { void refreshRef.current(); }, 2000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [platform, target.printerId, target.routeId, route.configurationRevision]);

  function persist(patch: Partial<D.PrintPreferences> | null, abnormal?: boolean) {
    const version = ++saveVersion.current; setSaving(true); setSaveError(false);
    saveChain.current = saveChain.current.catch(() => undefined).then(async () => {
      const config = await platform.printers.configuration.load();
      await platform.printers.configuration.save(patch ? { ...config, printPreferences: { ...config.printPreferences, [printer.identity.id]: { ...config.printPreferences?.[printer.identity.id], ...patch } } } : { ...config, allowAbnormalStorage: abnormal });
      if (live.current && version === saveVersion.current) setSaveError(false);
    }).catch(() => { if (live.current) setSaveError(true); }).finally(() => { if (live.current && version === saveVersion.current) setSaving(false); });
  }
  function changeOption(key: keyof D.PrintOptions, value: string | boolean) {
    setOptions(previous => ({ ...previous, [key]: value })); setConfirmation(null); setRecordingAction(undefined);
    if (key !== 'externalChangeAssist') persist({ [key]: value });
  }
  function changeBinding(materialKey: string, pathId: string) {
    setBindings(previous => [...previous.filter(b => b.materialKey !== materialKey), ...(pathId ? [{ materialKey, pathId: pathId as D.Id<'path'> }] : [])]);
    setConfirmation(null); setRecordingAction(undefined);
  }
  async function send(confirmed = false) {
    if (!canPrint || activeRef.current || !request.current || !sourceReceipt.current) return;
    setExporting(true); activeRef.current = true; setError(null);
    let submission: D.PrintSubmissionRef | null = null;
    try {
      await saveChain.current;
      if (!live.current) return;
      const checked = await platform.printers.service.submissions.prepare({ ...request.current, suggest: false, checkRecording: true });
      if (!live.current) return;
      if (!checked.ok) throw new Error(checked.error.message);
      setPrepared(checked.value);
      if (checked.value.issues.some(i => i.severity === 'block')) { setConfirmation(null); return; }
      const warnings = checked.value.issues.filter(i => i.severity === 'warning');
      const acknowledged = confirmed ? confirmation?.issues.filter(i => i.severity === 'warning').map(i => i.id) ?? [] : [];
      if (warnings.some(i => !acknowledged.includes(i.id)) || checked.value.recordingSpace?.status === 'insufficient' && !recordingAction) {
        setConfirmation(checked.value); return;
      }
      const exported = await platform.runtime.exportPrintPlate({ receipt: sourceReceipt.current, filenameBase: projectFilenameBase(useProjectStore.getState()), materialCatalogIds: checked.value.materialCatalogIds });
      if (!live.current) return;
      if (!exported.ok) throw new Error(exported.error);
      if (JSON.stringify(exported.manifest) !== JSON.stringify((({ contentId: _id, ...manifest }) => manifest)(request.current.requirements))) throw new Error('Slice changed');
      const { suggest: _suggest, ...input } = request.current;
      const submitted = await platform.printers.service.submissions.submit({ ...input, requestId: crypto.randomUUID() as D.Id<'request'>, acknowledgedIssues: acknowledged, recordingSpaceAction: recordingAction },
        ([['print', exported.bytes], ['configuration', exported.configBytes]] as const).map(([role, bytes]) => ({ role, fileName: exported.fileName, sizeBytes: bytes.byteLength, chunks: (async function* () { yield bytes; })() })));
      if (!submitted.ok) throw new Error(submitted.error.message);
      submission = submitted.value;
      setConfirmation(null);
      for await (const state of platform.printers.service.submissions.watch(submitted.value, { signal: watchAbort.current.signal })) {
        if (!live.current) return;
        setOperation(state);
        if (state.phase === 'started') { started.current(); return; }
      }
    } catch {
      if (live.current) {
        if (submission) setOperation({ ref: submission, requestId: '' as D.Id<'request'>, phase: 'unknown', route: prepared?.route ?? null, progress: null, canCancel: false, message: 'The print outcome could not be checked. Inspect the printer before sending another job.' });
        else setError('Print preparation or sending failed. Check the current printer status before retrying.');
      }
    } finally { if (live.current) { setExporting(false); activeRef.current = false; } }
  }
  async function cancel() {
    if (!operation?.canCancel) return;
    const result = await platform.printers.service.submissions.cancel(operation.ref);
    if (live.current) { if (result.ok) setOperation(result.value); else setError(result.error.message); }
  }
  return { requirements, prepared, bindings, options, error, saveError, allowAbnormal, active, canPrint, operation, confirmation, recordingAction,
    changeOption, changeBinding, send, cancel, setRecordingAction,
    changeAbnormal: (value: boolean) => { setAllowAbnormal(value); persist(null, value); setConfirmation(null); },
    dismissConfirmation: () => { setConfirmation(null); setRecordingAction(undefined); },
  };
}
