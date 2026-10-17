/** Shared wheel behavior for horizontal-only lists, including portal content. */
export function scrollHorizontalListWithWheel(event: WheelEvent): void {
  if (event.defaultPrevented || event.ctrlKey) return;
  const target = event.target;
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const list = element?.closest<HTMLElement>('[data-horizontal-scroll], [role="tablist"]');
  if (!list || list.getAttribute('aria-orientation') === 'vertical') return;

  // Explicit owners scroll themselves. Semantic tab lists may scroll their
  // shared Tabs root. Never search unrelated page/panel scroll containers.
  const root = list.hasAttribute('data-horizontal-scroll') ? list
    : list.closest<HTMLElement>('[data-slot="tabs"]') ?? list;
  let container: HTMLElement | null = list;
  while (container) {
    const style = getComputedStyle(container);
    // Even an opted-in list must not hijack an actual vertical/2D scroller.
    if (container.scrollHeight > container.clientHeight && (style.overflowY === 'auto' || style.overflowY === 'scroll')) return;
    const overflow = style.overflowX;
    if (container.scrollWidth > container.clientWidth && (overflow === 'auto' || overflow === 'scroll')) {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? container.clientWidth : 1;
      event.preventDefault();
      container.scrollLeft += delta * unit;
      return;
    }
    if (container === root) return;
    container = container.parentElement;
  }
}
