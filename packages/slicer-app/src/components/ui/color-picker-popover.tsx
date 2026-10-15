import { useState, type ReactElement } from 'react';
import type { ColorValue } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { ColorPicker, type ColorPickerProps } from '@/components/ui/color-picker';
import { formatColorValue } from './color-picker-model';

export interface ColorPickerPopoverProps extends Omit<ColorPickerProps, 'onChange' | 'onValidityChange' | 'className'> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (value: ColorValue) => void;
  title?: string;
  trigger: ReactElement;
}

/** Mounted only while open: reopening always starts from the authoritative value. */
function DraftEditor({ value, onConfirm, onOpenChange, title = 'Choose color', ...props }: Omit<ColorPickerPopoverProps, 'open' | 'trigger'>) {
  const [draft, setDraft] = useState(() => formatColorValue(value, props.enableAlpha, props.enableGradient));
  const [valid, setValid] = useState(true);
  return <PopoverContent align="start" sideOffset={6}
    onContextMenu={event => event.stopPropagation()}
    onKeyDown={event => {
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement && ['text', 'number'].includes(event.target.type)) {
        event.preventDefault();
        if (valid && !props.disabled) { onConfirm(formatColorValue(draft, props.enableAlpha, props.enableGradient)); onOpenChange(false); }
      }
    }}
    className="max-h-[min(90vh,var(--available-height))] w-auto max-w-[calc(100vw-24px)] gap-2 p-3">
    <PopoverTitle className="sr-only">{title}</PopoverTitle>
    <ColorPicker {...props} className="min-h-0 flex-1" value={draft} onChange={setDraft} onValidityChange={setValid} actions={<>
      <Button variant="settings" onClick={() => onOpenChange(false)}>Cancel</Button>
      <Button disabled={props.disabled || !valid} onClick={() => { onConfirm(formatColorValue(draft, props.enableAlpha, props.enableGradient)); onOpenChange(false); }}>Confirm</Button>
    </>} />
  </PopoverContent>;
}

export function ColorPickerPopover({ open, onOpenChange, trigger, ...props }: ColorPickerPopoverProps) {
  return <Popover open={open} onOpenChange={onOpenChange}>
    <PopoverTrigger render={trigger} disabled={props.disabled} />
    {open && <DraftEditor {...props} onOpenChange={onOpenChange} />}
  </Popover>;
}
