// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { scrollTabListWithWheel } from './tabWheelScroll';

afterEach(() => { document.body.innerHTML = ''; });

function tabBar(parentScroll = false) {
  document.body.innerHTML = '<div data-slot="tabs"><div role="tablist"><button role="tab">Page</button></div></div>';
  const list = document.querySelector<HTMLElement>('[role="tablist"]')!;
  const scroller = parentScroll ? list.parentElement! : list;
  scroller.style.overflowX = 'auto';
  Object.defineProperties(scroller, { scrollWidth: { value: 500, configurable: true }, clientWidth: { value: 100 } });
  document.addEventListener('wheel', scrollTabListWithWheel, { passive: false });
  const wheel = (options: WheelEventInit) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...options });
    list.querySelector('button')!.dispatchEvent(event);
    return event;
  };
  return { scroller, list, wheel };
}

describe('horizontal tab wheel scrolling', () => {
  afterEach(() => document.removeEventListener('wheel', scrollTabListWithWheel));
  it.each([false, true])('scrolls the overflowing %s tab container from a nested label', (parentScroll) => {
    const { scroller, wheel } = tabBar(parentScroll);
    expect(wheel({ deltaY: 30 }).defaultPrevented).toBe(true);
    expect(scroller.scrollLeft).toBe(30);
    wheel({ deltaX: -10 });
    expect(scroller.scrollLeft).toBe(20);
    wheel({ deltaY: 2, deltaMode: WheelEvent.DOM_DELTA_LINE });
    expect(scroller.scrollLeft).toBe(52);
  });
  it('preserves normal scrolling and zoom when no horizontal tab scroll is needed', () => {
    const { scroller, list, wheel } = tabBar();
    expect(wheel({ deltaY: 10, ctrlKey: true }).defaultPrevented).toBe(false);
    list.setAttribute('aria-orientation', 'vertical');
    expect(wheel({ deltaY: 10 }).defaultPrevented).toBe(false);
    list.removeAttribute('aria-orientation');
    Object.defineProperty(scroller, 'scrollWidth', { value: 100 });
    expect(wheel({ deltaY: 10 }).defaultPrevented).toBe(false);
    expect(scroller.scrollLeft).toBe(0);
  });
});
