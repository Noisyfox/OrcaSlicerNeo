import { useEffect, useId, useRef, useState } from 'react';
import { colorValueKey, usePlatform } from '@orca/platform-contract';
import type * as D from '@orca/printer-control/domain';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { UserColorPickerPopover } from '@/components/color/UserColorPickerPopover';
import { colorSwatchStyle } from '@/components/ui/color-swatch';
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxTrigger, ComboboxValue } from '@/components/ui/combobox';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { materialColorConfiguration, materialColorPickerSeed, materialColorSwatch } from './material-color';

interface Props {
  service: D.PrinterService;
  target: D.TargetRequest;
  printer: D.PrinterIdentity;
  slot: D.MaterialSlot;
  slotLabel: string;
  material: D.MaterialMetadata | undefined;
  configuration: D.MaterialConfigurationTarget;
  capabilityRevision: string;
  disabled: boolean;
  onClose(): void;
  onSubmitted(result: Exclude<D.Submission, { kind: 'rejected' }>): void;
}
type Params = D.PrinterCommandSpecs['materials.configure']['params'];
const matches = (preset: D.MaterialPresetConfiguration, material: D.MaterialMetadata | undefined) => preset.catalogRefs.some(ref =>
  material?.catalogRefs.some(current => current.namespace === ref.namespace && current.value === ref.value));

/** Its keyed lifetime owns one physical slot's draft, never a project preset mutation. */
export function MaterialInformationDialog({ service, target, printer, slot, slotLabel, material, configuration, capabilityRevision, disabled, onClose, onSubmitted }: Props) {
  const platform = usePlatform(), selectId = useId();
  const [search, setSearch] = useState('');
  const [presets, setPresets] = useState<readonly D.MaterialPresetConfiguration[]>([]), [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true), [catalogueError, setCatalogueError] = useState<string | null>(null);
  const [color, setColor] = useState<D.MaterialColorConfiguration | null>(null);
  const [colorOpen, setColorOpen] = useState(false), [reset, setReset] = useState(false);
  const [review, setReview] = useState<{ params: Params; warnings: readonly D.CommandWarning[] } | null>(null);
  const [message, setMessage] = useState<string | null>(null), [submitting, setSubmitting] = useState(false);
  const sending = useRef(false), alive = useRef(true), revision = useRef(capabilityRevision); revision.current = capabilityRevision;
  const writable = configuration.informationWritable && configuration.actions.length > 0;
  const preset = presets.find(preset => preset.key === selected);
  const range = writable && preset ? preset.nozzleTemperatureRangeC : material?.nozzleTemperatureRangeC;
  const displayedColor = color ?? material?.color ?? { kind: 'solid' as const, rgba: '#FFFFFFFF' };
  const picker = materialColorPickerSeed(displayedColor, configuration.maxGradientColors);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void platform.runtime.getDeviceMaterialCatalogue({ identity: { manufacturer: printer.manufacturer, model: printer.model, externalRefs: printer.externalRefs },
      ...configuration.catalogue }).then(result => {
      if (cancelled) return;
      if (!result.ok) { setCatalogueError(result.error); return; }
      setPresets(result.presets); setSelected(result.presets.find(preset => matches(preset, material))?.key ?? '');
    }).catch(() => { if (!cancelled) setCatalogueError('The device material catalogue could not be loaded. Reopen this dialog to try again.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; alive.current = false; };
  }, []);
  useEffect(() => { setReview(null); setReset(false); }, [capabilityRevision, disabled, configuration.informationWritable, configuration.restriction]);
  const available = !disabled && configuration.actions.length > 0;
  async function apply(params: Params) {
    if (sending.current || !available || !configuration.actions.includes(params.intent)) return;
    sending.current = true; setSubmitting(true); setMessage(null);
    const expectedRevision = revision.current;
    try {
      const command = { type: 'materials.configure', params } as const;
      const assessment = await service.controls.evaluate({ printerId: target.printerId, routeId: target.routeId }, command);
      if (!alive.current) return;
      if (!assessment.ok) { setMessage(assessment.error.message); return; }
      if (assessment.value.availability.kind !== 'available') {
        const availability = assessment.value.availability;
        setMessage(availability.kind === 'blocked' ? availability.reasons.map(reason => reason.message).join('\n') : availability.reason); return;
      }
      const warnings = assessment.value.warnings;
      if (warnings.some(warning => !params.acknowledgedWarningIds.includes(warning.id))) { setReview({ params, warnings }); return; }
      if (revision.current !== expectedRevision) { setReview(null); setMessage('Printer capabilities changed. Review the current information before applying.'); return; }
      const request: D.CommandRequest = { target, requestId: crypto.randomUUID() as D.Id<'request'>, command, guard: { capabilityRevision: expectedRevision } };
      let result: D.Submission;
      try { result = await service.controls.submit(request); }
      catch { result = { kind: 'outcome-unknown', lookup: { ...target, requestId: request.requestId } }; }
      if (result.kind === 'rejected') { if (alive.current) { setReview(null); setMessage(result.error.message); } return; }
      onSubmitted(result);
      if (alive.current) onClose();
    } catch { if (alive.current) setMessage('Material information could not be validated. Check the connection and try again.'); }
    finally { sending.current = false; if (alive.current) setSubmitting(false); }
  }
  function confirm() {
    if (configuration.informationWritable && (!preset?.nozzleTemperatureRangeC || loading)) { setMessage('Select a compatible material with a temperature range.'); return; }
    void apply({ slotId: slot.id, intent: 'confirm', preset: configuration.informationWritable ? preset ?? null : null,
      color: configuration.informationWritable ? color : null, acknowledgedWarningIds: [] });
  }
  return <Dialog open onOpenChange={open => { if (!open && !sending.current) onClose(); }} disablePointerDismissal={submitting}>
    <DialogContent className="flex max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg flex-col">
      <DialogHeader className="shrink-0"><DialogTitle>Material information</DialogTitle>
        <DialogDescription>{printer.displayName} · {slotLabel}</DialogDescription></DialogHeader>
      <div className="min-h-0 space-y-4 overflow-y-auto">
        {!configuration.informationWritable && <p className="text-sm">RFID material information is read-only. Confirm applies the automatic calibration parameters or association; Reset resets calibration only. These actions cannot clear RFID material information.</p>}
        {configuration.restriction && <p role="status" className="text-sm">{configuration.restriction}</p>}
        <FieldGroup className="gap-3">
          <Field orientation="horizontal" className="gap-3">
            <FieldLabel className="w-40 shrink-0 flex-none" htmlFor={selectId}>Material</FieldLabel>
            <Combobox items={presets} value={preset ?? null} itemToStringLabel={item => item.label} itemToStringValue={item => item.key}
              inputValue={search} onInputValueChange={setSearch} onOpenChange={open => { if (!open) setSearch(''); }}
              disabled={!writable || loading || submitting || !!review} onValueChange={item => { if (item) { setSelected(item.key); setMessage(null); setReview(null); } }}>
              <ComboboxTrigger id={selectId} variant="sidebar" className="min-w-0 flex-1" aria-label="Material preset" title={preset?.key} render={<Button variant="ghost" size="sm" />}>
                <span className="min-w-0 flex-1 truncate text-left"><ComboboxValue placeholder={loading ? 'Loading materials…' : material?.materialType ? `${material.manufacturer ?? ''} ${material.materialType} (reported)`.trim() : 'Select material'} /></span>
              </ComboboxTrigger>
              <ComboboxContent>
                <ComboboxInput aria-label="Search materials" placeholder="Search materials…" showTrigger={false} searchValue={search} onClearSearch={() => setSearch('')} />
                <ComboboxList>{item => <ComboboxItem key={item.key} value={item} title={item.key}>{item.label}</ComboboxItem>}</ComboboxList>
                <ComboboxEmpty>No matching materials</ComboboxEmpty>
              </ComboboxContent>
            </Combobox>
          </Field>
          {catalogueError && <p role="alert" className="text-sm text-destructive">{catalogueError}</p>}
          <Field orientation="horizontal" className="justify-between gap-3">
            <FieldLabel htmlFor={`${selectId}-color`}>Color</FieldLabel>
            <UserColorPickerPopover open={colorOpen} onOpenChange={setColorOpen} value={picker.value} enableAlpha enableGradient={configuration.maxGradientColors !== null}
              maxGradientColors={configuration.maxGradientColors ?? undefined} notice={picker.notice}
              disabled={!writable || submitting || !!review} onConfirm={value => {
                if (colorValueKey(value) !== colorValueKey(picker.value)) { setColor(materialColorConfiguration(value)); setMessage(null); }
              }}
              trigger={<Button id={`${selectId}-color`} variant="input" size="sm" className="font-normal" aria-label="Change material color"><span className="size-4 rounded-sm border" style={colorSwatchStyle(materialColorSwatch(displayedColor))} />{displayedColor.kind === 'solid' ? displayedColor.rgba : `${displayedColor.rgba.length} colors`}</Button>} />
          </Field>
          <Field orientation="horizontal" className="justify-between gap-3">
            <FieldLabel htmlFor={`${selectId}-temperature`}>Nozzle temperature range</FieldLabel>
            <output id={`${selectId}-temperature`} className="text-sm" aria-label="Nozzle temperature range">{range ? `${range.min}–${range.max} °C` : 'Not reported'}</output>
          </Field>
        </FieldGroup>
        {message && <p role="alert" className="whitespace-pre-line text-sm text-destructive">{message}</p>}
        {reset && !review && <div className="space-y-3 rounded border p-3 text-sm" role="group" aria-label="Reset confirmation">
          <p>{configuration.informationWritable ? 'Clear this slot’s material information and reset its automatic calibration parameters or association?' : 'Reset this slot’s automatic calibration parameters or association? RFID material information will remain read-only.'}</p>
          <div className="flex justify-end gap-2"><Button variant="settings" disabled={submitting} onClick={() => setReset(false)}>Keep information</Button><Button variant="destructive" disabled={!available || submitting} onClick={() => void apply({ slotId: slot.id, intent: 'reset', acknowledgedWarningIds: [] })}>Confirm reset</Button></div>
        </div>}
        {review && <div className="space-y-3 rounded border p-3 text-sm" role="group" aria-label="Material warnings">
          {review.warnings.map(warning => <div key={warning.id}><p className="whitespace-pre-line">{warning.message}</p>{warning.helpUrl && <Button size="sm" variant="link" onClick={() => { void platform.externalLinks.openHttps(warning.helpUrl!); }}>Learn more</Button>}</div>)}
          <div className="flex justify-end gap-2"><Button variant="settings" disabled={submitting} onClick={() => setReview(null)}>Back</Button><Button disabled={!available || submitting} onClick={() => void apply({ ...review.params, acknowledgedWarningIds: review.warnings.map(warning => warning.id) })}>Continue</Button></div>
        </div>}
      </div>
      <DialogFooter className="shrink-0"><Button variant="settings" disabled={submitting} onClick={onClose}>Cancel</Button>
        <Button variant="settings" disabled={!available || submitting || !configuration.actions.includes('reset') || !!review} onClick={() => { setReset(true); setMessage(null); }}>Reset</Button>
        <Button disabled={!available || submitting || !configuration.actions.includes('confirm') || !!review || configuration.informationWritable && (loading || !preset?.nozzleTemperatureRangeC)} onClick={confirm}>{submitting ? 'Submitting…' : 'Confirm'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
