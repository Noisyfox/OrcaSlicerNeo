// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { useProjectDialogStore } from '@/stores/useProjectDialogStore';
import { useProjectModal } from './useProjectModal';

it('retains locks for remaining modals and lets the topmost modal own keyboard input', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  function Fixture({ underlying, confirmation }: { underlying: boolean; confirmation: boolean }) {
    useProjectModal(underlying, '#underlying-modal', { pauseDeviceObservation: true });
    useProjectModal(confirmation, '#confirmation-modal');
    return <><div id="underlying-modal"><button>Underlying</button></div><div id="confirmation-modal"><button>Confirm</button></div></>;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = (underlying: boolean, confirmation: boolean) => act(async () => root.render(<Fixture underlying={underlying} confirmation={confirmation} />));
  try {
    await render(true, true);
    expect(useProjectDialogStore.getState()).toEqual({ open: true, deviceObservationPaused: true });
    const key = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    document.querySelector('#confirmation-modal button')!.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    await render(true, false);
    expect(useProjectDialogStore.getState()).toEqual({ open: true, deviceObservationPaused: true });
    await render(true, true);
    await render(false, true);
    expect(useProjectDialogStore.getState()).toEqual({ open: true, deviceObservationPaused: false });
    await render(false, false);
    expect(useProjectDialogStore.getState()).toEqual({ open: false, deviceObservationPaused: false });
  } finally { await act(async () => root.unmount()); container.remove(); }
});
