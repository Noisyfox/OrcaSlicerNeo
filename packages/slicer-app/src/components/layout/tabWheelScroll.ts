/** Support wheel scrolling for shared and custom tab lists, including portals. */
export function scrollTabListWithWheel(event: WheelEvent): void {
  if (event.defaultPrevented || event.ctrlKey) return;
  const target = event.target;
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const list = element?.closest<HTMLElement>('[role="tablist"]');
  if (!list || list.getAttribute('aria-orientation') === 'vertical') return;

  // The main-page tabs scroll their Tabs root; configuration tabs scroll
  // the list itself. Do not search unrelated page/panel scroll containers.
  const root = list.closest<HTMLElement>('[data-slot="tabs"]') ?? list;
  let container: HTMLElement | null = list;
  while (container) {
    const overflow = getComputedStyle(container).overflowX;
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
