import { useState, type ReactElement } from 'react';
import type { ColorValue } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ColorPicker, type ColorPickerProps } from '@/components/ui/color-picker';
import { formatColorValue } from './color-picker-model';

export interface ColorPickerDialogProps extends Omit<ColorPickerProps, 'onChange' | 'onValidityChange' | 'className'> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (value: ColorValue) => void;
  title?: string;
  trigger?: ReactElement;
}

/** Mounted only while open: reopening always starts from the authoritative value. */
function DraftEditor({ value, onConfirm, onOpenChange, title = 'Choose color', ...props }: Omit<ColorPickerDialogProps, 'open' | 'trigger'>) {
  const [draft, setDraft] = useState(() => formatColorValue(value, props.enableAlpha, props.enableGradient));
  const [valid, setValid] = useState(true);
  return <DialogContent className="max-h-[90vh] w-[550px] max-w-[calc(100vw-24px)] gap-3 overflow-y-auto">
    <DialogHeader><DialogTitle>{title}</DialogTitle>
      <DialogDescription>Adjust a color or choose a saved favorite.</DialogDescription></DialogHeader>
    <ColorPicker {...props} value={draft} onChange={setDraft} onValidityChange={setValid} />
    <DialogFooter>
      <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
      <Button disabled={props.disabled || !valid} onClick={() => { onConfirm(formatColorValue(draft, props.enableAlpha, props.enableGradient)); onOpenChange(false); }}>Confirm</Button>
    </DialogFooter>
  </DialogContent>;
}

export function ColorPickerDialog({ open, onOpenChange, trigger, ...props }: ColorPickerDialogProps) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    {trigger && <DialogTrigger render={trigger} disabled={props.disabled} />}
    {open && <DraftEditor {...props} onOpenChange={onOpenChange} />}
  </Dialog>;
}
