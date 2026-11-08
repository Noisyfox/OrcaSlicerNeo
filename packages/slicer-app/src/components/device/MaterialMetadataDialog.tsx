import { useEffect, useRef, useState } from 'react';
import type * as D from '@orca/printer-control/domain';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { UserColorPickerPopover } from '@/components/color/UserColorPickerPopover';
import { colorSwatchStyle } from '@/components/ui/color-swatch';
import { materialColorConfiguration, materialColorPickerSeed, materialColorSwatch } from './material-color';
/** Direct metadata editors use the provider's writable fields, without requiring a slicer preset. */
export function MaterialMetadataDialog({ service, target, slot, material, fields, onClose }: { service: D.PrinterService; target: D.TargetRequest; slot: D.MaterialSlot; material?: D.MaterialMetadata; fields: readonly (keyof D.MaterialMetadata)[]; onClose(): void }) {
  const [manufacturer, setManufacturer] = useState(material?.manufacturer ?? ''), [type, setType] = useState(material?.materialType ?? '');
  const [color, setColor] = useState<D.MaterialColorConfiguration | null>(null), [colorOpen, setColorOpen] = useState(false);
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null);
  const busy = useRef(false), observer = useRef<AbortController | null>(null);
  useEffect(() => () => observer.current?.abort(), []);
  const shown = color ?? material?.color ?? null, picker = materialColorPickerSeed(shown ?? { kind: 'solid', rgba: '#FFFFFFFF' }, null);
  async function save() {
    if (busy.current) return;
    const patch: Partial<D.MaterialMetadata> = {};
    if (fields.includes('manufacturer') && manufacturer !== (material?.manufacturer ?? '')) patch.manufacturer = manufacturer;
    if (fields.includes('materialType') && type !== (material?.materialType ?? '')) patch.materialType = type;
    if (fields.includes('color') && color?.kind === 'solid') patch.color = color;
    if (!Object.keys(patch).length) { onClose(); return; }
    busy.current = true; setPending(true); setError(null); const abort = new AbortController(); observer.current = abort;
    try {
      const submission = await service.controls.submit({ target, requestId: crypto.randomUUID() as D.Id<'request'>, command: { type: 'materials.writeMetadata', params: { slotId: slot.id, patch: patch as D.MaterialMetadataPatch } } });
      if (abort.signal.aborted) return;
      if (submission.kind === 'rejected') { setError(submission.error.message); return; }
      if (submission.kind !== 'recorded') { setError('The write outcome is unknown. Your edits have been retained.'); return; }
      for await (const operation of service.operations.watch(submission.operation, { signal: abort.signal })) {
        if (abort.signal.aborted) return;
        if (operation.phase.kind === 'acknowledged' || operation.phase.kind === 'completed') { onClose(); return; }
        if (operation.phase.kind === 'failed') { setError(operation.phase.error.message); return; }
        if (operation.phase.kind === 'outcome-unknown') { setError(operation.phase.reason); return; }
      }
      if (!abort.signal.aborted) setError('The write outcome is unknown. Your edits have been retained.');
    } catch { if (!abort.signal.aborted) setError('Unable to write material information. Your edits have been retained.'); }
    finally { busy.current = false; if (!abort.signal.aborted) setPending(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose(); }} disablePointerDismissal={pending}>
    <DialogContent className="max-w-md">
      <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void save(); }}>
        <DialogHeader><DialogTitle>Material information</DialogTitle><DialogDescription>{slot.name}</DialogDescription></DialogHeader>
        <FieldGroup className="gap-3">
          {fields.includes('manufacturer') && <Field data-disabled={pending}>
            <FieldLabel htmlFor="material-brand">Brand</FieldLabel>
            <Input id="material-brand" value={manufacturer} disabled={pending} onChange={e => setManufacturer(e.target.value)} />
          </Field>}
          {fields.includes('materialType') && <Field data-disabled={pending}>
            <FieldLabel htmlFor="material-type">Material type</FieldLabel>
            <Input id="material-type" value={type} disabled={pending} placeholder="PLA, PETG, PLA-Silk…" onChange={e => setType(e.target.value)} />
          </Field>}
          {fields.includes('color') && <Field data-disabled={pending}>
            <FieldLabel htmlFor="material-color">Color</FieldLabel>
            <UserColorPickerPopover open={colorOpen} onOpenChange={setColorOpen} value={picker.value} enableAlpha enableGradient={false} disabled={pending} onConfirm={value => setColor(materialColorConfiguration(value))}
              trigger={<Button id="material-color" type="button" variant="input" aria-label="Change material color">{shown && <span className="size-4 rounded-sm border" style={colorSwatchStyle(materialColorSwatch(shown))} />}{shown?.kind === 'solid' ? shown.rgba : 'Choose color'}</Button>} />
          </Field>}
        </FieldGroup>
        {error && <FieldError>{error}</FieldError>}
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save material information'}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
