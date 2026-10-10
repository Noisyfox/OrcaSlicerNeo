import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import type { SceneInteractionController } from './viewport/SceneInteractionController';
import { SettingsPanel } from './settings/SettingsPanel';

/** Separate device/material and configuration scrolling without splitting preset state. */
export function WorkspaceSidebar({ sceneInteraction, onEditPrinter, printerExtras, configurationExtras }: {
  sceneInteraction: SceneInteractionController | null;
  onEditPrinter?: (canonicalName: string) => void;
  printerExtras?: ReactNode;
  configurationExtras?: ReactNode;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const devicePanelRef = useRef<HTMLDivElement>(null);
  const devicePanelHandle = useRef<PanelImperativeHandle>(null);
  const deviceViewportRef = useRef<HTMLDivElement>(null);
  const deviceContentRef = useRef<HTMLDivElement>(null);
  const expandToMaximum = useRef(false);
  const minimumHeight = useRef<number | null>(null);
  const [deviceBounds, setDeviceBounds] = useState<{ maximum: number; minimum: number } | null>(null);

  useLayoutEffect(() => {
    const group = groupRef.current;
    const panel = devicePanelRef.current;
    const viewport = deviceViewportRef.current;
    const content = deviceContentRef.current;
    if (!group || !panel || !viewport || !content) return;
    let previousContentHeight: number | null = null;
    let contentPreviouslyFitted = false;
    const measure = () => {
      const groupHeight = group.getBoundingClientRect().height;
      if (groupHeight <= 0) return;
      // ResizablePanel applies its card classes to an inner element.
      const style = getComputedStyle(panel.firstElementChild ?? panel);
      const contentHeight = Math.ceil(content.getBoundingClientRect().height);
      // Use the last measured layout, before a preset transition changed the
      // DOM. Checking scrollHeight here would already see the taller content.
      if (previousContentHeight !== null && contentHeight > previousContentHeight && contentPreviouslyFitted) {
        expandToMaximum.current = true;
      }
      previousContentHeight = contentHeight;
      contentPreviouslyFitted = contentHeight <= viewport.clientHeight;
      const maximum = Math.ceil(contentHeight +
        parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth));
      // Changing minSize on every group resize re-registers the panels and
      // reapplies their percentage layout before pixel preservation can run.
      // Keep the initial pixel minimum stable; short content can still cap it.
      const minimumBaseline = minimumHeight.current ?? (minimumHeight.current = groupHeight * 0.15);
      const minimum = Math.min(maximum, minimumBaseline);
      setDeviceBounds((previous) => previous?.maximum === maximum && previous.minimum === minimum
        ? previous : { maximum, minimum });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    // ResizeObserver runs before paint. Commit the constraints in the same
    // frame so expanded content cannot flash a scrollbar at the old height.
    const observer = new ResizeObserver(() => flushSync(measure));
    observer.observe(content);
    observer.observe(viewport);
    observer.observe(group);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!deviceBounds) return;
    const expanding = expandToMaximum.current;
    expandToMaximum.current = false;
    // Apply content-driven changes to the current split: shrink on collapse,
    // and grow on expansion when the previous content fitted without scrolling.
    const resizePanel = () => {
      const panel = devicePanelHandle.current;
      if (panel && (expanding || panel.getSize().inPixels > deviceBounds.maximum)) {
        panel.resize(deviceBounds.maximum);
      }
    };
    resizePanel();
    // The group re-registers panels when constraints change. Reapply after
    // that update so an expansion is not clamped to the previous maximum.
    const frame = requestAnimationFrame(() => flushSync(resizePanel));
    return () => cancelAnimationFrame(frame);
  }, [deviceBounds]);

  return <SettingsPanel sceneInteraction={sceneInteraction} onEditPrinter={onEditPrinter} platesContent={configurationExtras}
    renderLayout={({ printer, settings }) => (
      <ResizablePanelGroup elementRef={groupRef} orientation="vertical" id="workspace-sidebar-panels" className="min-h-0">
        <ResizablePanel elementRef={devicePanelRef} panelRef={devicePanelHandle} id="device-material-panel" defaultSize="35%"
          groupResizeBehavior="preserve-pixel-size"
          minSize={deviceBounds?.minimum ?? '15%'} maxSize={deviceBounds?.maximum}
          className="overflow-hidden rounded-md border bg-card">
          <div ref={deviceViewportRef} className="h-full overflow-y-auto" data-testid="sidebar-device-panel">
            <div ref={deviceContentRef} className="flow-root" onClickCapture={(event) => {
              const target = event.target instanceof Element ? event.target : null;
              const toggle = target?.closest('.sidebar-section-header button[aria-expanded]');
              const viewport = deviceViewportRef.current;
              if (!toggle || !viewport) return;
              // Capture the combined Printer + Material scroll state before
              // the child's toggle changes either section's content height.
              expandToMaximum.current = toggle.getAttribute('aria-expanded') === 'false'
                && viewport.scrollHeight <= viewport.clientHeight;
            }}>
              {printer}
              {printerExtras}
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle id="sidebar-panel-resizer" aria-label="Resize device and settings panels" data-testid="sidebar-panel-resizer" className="h-1.5! w-full! shrink-0 bg-transparent after:hidden" />
        <ResizablePanel id="configuration-panel" defaultSize="65%" minSize="20%" groupResizeBehavior="preserve-relative-size" className="overflow-hidden rounded-md border bg-card">
          <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="sidebar-settings-panel">
            {settings}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    )}
  />;
}
