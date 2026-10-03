import { useLayoutEffect, type ReactNode } from 'react';
import { useArrangementStore } from '@/stores/useArrangementStore';

/** Cover portal controls and keyboard/drop routes as well as native form controls.
 * Canvas pointer/wheel events remain available to OrbitControls; its editing
 * raycasts are separately disabled by Viewport for the same operation. */
export function ArrangementEditBoundary({ children }: { children: ReactNode }) {
  const active = useArrangementStore(state => state.active);
  useLayoutEffect(() => {
    const guard = (event: Event) => {
      if (!useArrangementStore.getState().active) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-arrangement-allowed]')) return;
      if (target?.closest('canvas') && (event.type.startsWith('pointer') || event.type === 'wheel')) return;
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
    };
    const events = ['pointerdown', 'click', 'dblclick', 'contextmenu', 'keydown', 'beforeinput', 'input', 'change', 'dragover', 'drop', 'cut', 'paste'];
    for (const name of events) window.addEventListener(name, guard, true);
    return () => { for (const name of events) window.removeEventListener(name, guard, true); };
  }, []);
  return <fieldset disabled={active} className="contents" data-testid="arrangement-edit-boundary">{children}</fieldset>;
}
