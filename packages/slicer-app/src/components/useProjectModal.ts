import { useLayoutEffect } from 'react';
import { useProjectDialogStore } from '@/stores/useProjectDialogStore';
/** Covers keyboard/drop routes and focus as well as the visible pointer backdrop. */
export function useProjectModal(open: boolean, selector: string, { pauseDeviceObservation = false }: { pauseDeviceObservation?: boolean } = {}) {
  useLayoutEffect(() => {
    if (!open) return;
    useProjectDialogStore.setState({ open: true, deviceObservationPaused: pauseDeviceObservation });
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = document.querySelector<HTMLElement>(selector);
    const focusable = () => [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? [])];
    focusable()[0]?.focus();
    const guard = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      const inside = !!target?.closest(`${selector},[data-slot="select-content"],[data-print-dialog-popover]`);
      if (event instanceof KeyboardEvent && event.key === 'Tab' && inside && !target?.closest('[data-slot="select-content"],[data-print-dialog-popover]')) {
        const nodes = focusable(), first = nodes[0], last = nodes.at(-1);
        if (event.shiftKey && target === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && target === last) { event.preventDefault(); first?.focus(); }
      }
      if (!inside || ['drop', 'dragover'].includes(event.type)) { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); }
    };
    for (const type of ['keydown', 'drop', 'dragover']) window.addEventListener(type, guard, true);
    return () => {
      useProjectDialogStore.setState({ open: false, deviceObservationPaused: false });
      for (const type of ['keydown', 'drop', 'dragover']) window.removeEventListener(type, guard, true);
      previous?.focus();
    };
  }, [open, selector, pauseDeviceObservation]);
}
