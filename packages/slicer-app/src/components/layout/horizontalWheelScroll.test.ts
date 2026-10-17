// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { scrollHorizontalListWithWheel } from './horizontalWheelScroll';

afterEach(() => { document.body.innerHTML = ''; });

function tabBar(parentScroll = false) {
  document.body.innerHTML = '<div data-slot="tabs"><div role="tablist"><button role="tab">Page</button></div></div>';
  const list = document.querySelector<HTMLElement>('[role="tablist"]')!;
  const scroller = parentScroll ? list.parentElement! : list;
  scroller.style.overflowX = 'auto';
  Object.defineProperties(scroller, { scrollWidth: { value: 500, configurable: true }, clientWidth: { value: 100 } });
  document.addEventListener('wheel', scrollHorizontalListWithWheel, { passive: false });
  const wheel = (options: WheelEventInit) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...options });
    list.querySelector('button')!.dispatchEvent(event);
    return event;
  };
  return { scroller, list, wheel };
}

describe('horizontal-only list wheel scrolling', () => {
  afterEach(() => document.removeEventListener('wheel', scrollHorizontalListWithWheel));
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

it('scrolls an explicit non-tab owner in a portal and leaves outer owners alone', () => {
  document.body.innerHTML = '<div data-horizontal-scroll><div data-horizontal-scroll><button><span>Nozzle</span></button></div></div>';
  const [outer, inner] = document.querySelectorAll<HTMLElement>('[data-horizontal-scroll]');
  for (const owner of [outer, inner]) {
    owner.style.overflowX = 'auto';
    Object.defineProperties(owner, {scrollWidth:{value:500, configurable:true},clientWidth:{value:100}});
  }
  document.addEventListener('wheel', scrollHorizontalListWithWheel, { passive:false });
  try {
    const send = (options:WheelEventInit) => {
      const event = new WheelEvent('wheel', {bubbles:true,cancelable:true,...options});
      inner.querySelector('span')!.dispatchEvent(event); return event;
    };
    expect(send({deltaY:1,deltaMode:WheelEvent.DOM_DELTA_PAGE}).defaultPrevented).toBe(true);
    expect(inner.scrollLeft).toBe(100);expect(outer.scrollLeft).toBe(0);
    send({deltaX:-12,deltaY:3});expect(inner.scrollLeft).toBe(88);
    expect(send({deltaY:0}).defaultPrevented).toBe(false);
    expect(send({deltaY:10,ctrlKey:true}).defaultPrevented).toBe(false);
    inner.addEventListener('wheel', event=>event.preventDefault(), {once:true});
    send({deltaY:10});expect(inner.scrollLeft).toBe(88);
    Object.defineProperty(inner,'scrollWidth',{value:100});
    expect(send({deltaY:10}).defaultPrevented).toBe(false);
    expect(outer.scrollLeft).toBe(0);
  } finally {document.removeEventListener('wheel',scrollHorizontalListWithWheel);}
});

it.each([false,true])('does not hijack unmarked or two-dimensional content (marked=%s)', marked => {
  const owner=document.createElement('div');owner.innerHTML='<button>Cell</button>';document.body.append(owner);
  if(marked)owner.setAttribute('data-horizontal-scroll','');
  owner.style.overflowX='auto';owner.style.overflowY='auto';
  Object.defineProperties(owner,{scrollWidth:{value:500},clientWidth:{value:100},scrollHeight:{value:500},clientHeight:{value:100}});
  const event=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:20});
  document.addEventListener('wheel',scrollHorizontalListWithWheel,{passive:false});
  try {owner.firstElementChild!.dispatchEvent(event);expect(event.defaultPrevented).toBe(false);expect(owner.scrollLeft).toBe(0);}
  finally {document.removeEventListener('wheel',scrollHorizontalListWithWheel);}
});
