import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactElement } from 'react';
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
  const popup = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const gesture = useRef<{ pointerId: number; target: HTMLElement; startX: number; startY: number; left: number; top: number } | null>(null);
  // Use the popup's top edge so positioning does not offset a zero-width
  // reference to accommodate its arrow padding.
  const anchor = useMemo(() => position ? { getBoundingClientRect: () => new DOMRect(position.x, position.y, popup.current?.getBoundingClientRect().width ?? 0, 0) } : undefined, [position]);
  const endDrag = useCallback(() => {
    const drag = gesture.current;
    gesture.current = null;
    if (drag?.target.hasPointerCapture(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
  }, []);
  useEffect(() => endDrag, [endDrag]);
  const startDrag = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || gesture.current || !popup.current) return;
    const rect = popup.current.getBoundingClientRect();
    gesture.current = { pointerId: event.pointerId, target: event.currentTarget, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const drag = gesture.current;
    if (!drag || drag.pointerId !== event.pointerId || !popup.current) return;
    const rect = popup.current.getBoundingClientRect();
    const viewport = popup.current.ownerDocument.defaultView!;
    setPosition({ x: Math.max(8, Math.min(viewport.innerWidth - rect.width - 8, drag.left + event.clientX - drag.startX)),
      y: Math.max(8, Math.min(viewport.innerHeight - rect.height - 8, drag.top + event.clientY - drag.startY)) });
    event.preventDefault();
  };
  return <PopoverContent ref={popup} align="start" sideOffset={position ? 0 : 6}
    anchor={anchor} positionMethod={position ? 'fixed' : undefined}
    collisionAvoidance={position ? { side: 'shift', align: 'shift' } : undefined}
    onContextMenu={event => event.stopPropagation()}
    onKeyDown={event => {
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement && ['text', 'number'].includes(event.target.type)) {
        event.preventDefault();
        if (valid && !props.disabled) { onConfirm(formatColorValue(draft, props.enableAlpha, props.enableGradient)); onOpenChange(false); }
      }
    }}
    className="max-h-[min(90vh,var(--available-height))] w-auto max-w-[calc(100vw-24px)] gap-2 p-3">
    <div data-testid="color-picker-titlebar" className="-mx-3 -mt-3 shrink-0 cursor-grab touch-none select-none rounded-t-lg bg-panel-header px-3 py-2 active:cursor-grabbing"
      onPointerDown={startDrag} onPointerMove={moveDrag}
      onPointerUp={event => { if (gesture.current?.pointerId === event.pointerId) endDrag(); }}
      onPointerCancel={event => { if (gesture.current?.pointerId === event.pointerId) endDrag(); }}
      onLostPointerCapture={event => { if (gesture.current?.pointerId === event.pointerId) gesture.current = null; }}>
      <PopoverTitle>{title}</PopoverTitle>
    </div>
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
