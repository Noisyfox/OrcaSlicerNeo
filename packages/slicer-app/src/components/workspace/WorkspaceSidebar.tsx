import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
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
  const deviceContentRef = useRef<HTMLDivElement>(null);
  const [deviceBounds, setDeviceBounds] = useState<{ maximum: number; minimum: number } | null>(null);

  useLayoutEffect(() => {
    const group = groupRef.current;
    const panel = devicePanelRef.current;
    const content = deviceContentRef.current;
    if (!group || !panel || !content) return;
    const measure = () => {
      const groupHeight = group.getBoundingClientRect().height;
      if (groupHeight <= 0) return;
      // ResizablePanel applies its card classes to an inner element.
      const style = getComputedStyle(panel.firstElementChild ?? panel);
      const maximum = Math.ceil(content.getBoundingClientRect().height +
        parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth));
      const minimum = Math.min(maximum, groupHeight * 0.15);
      setDeviceBounds((previous) => previous?.maximum === maximum && previous.minimum === minimum
        ? previous : { maximum, minimum });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    // ResizeObserver runs before paint. Commit the constraints in the same
    // frame so expanded content cannot flash a scrollbar at the old height.
    const observer = new ResizeObserver(() => flushSync(measure));
    observer.observe(content);
    observer.observe(group);
    return () => observer.disconnect();
  }, []);

  return <SettingsPanel sceneInteraction={sceneInteraction} onEditPrinter={onEditPrinter} platesContent={configurationExtras}
    renderLayout={({ printer, settings }) => (
      <ResizablePanelGroup elementRef={groupRef} orientation="vertical" id="workspace-sidebar-panels" className="min-h-0">
        <ResizablePanel elementRef={devicePanelRef} id="device-material-panel" defaultSize="35%"
          minSize={deviceBounds?.minimum ?? '15%'} maxSize={deviceBounds?.maximum}
          className="overflow-hidden rounded-md border bg-card">
          <div className="h-full overflow-y-auto" data-testid="sidebar-device-panel">
            <div ref={deviceContentRef} className="flow-root">
              {printer}
              {printerExtras}
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle id="sidebar-panel-resizer" aria-label="Resize device and settings panels" data-testid="sidebar-panel-resizer" className="h-1.5! w-full! shrink-0 bg-transparent after:hidden" />
        <ResizablePanel id="configuration-panel" defaultSize="65%" minSize="20%" className="overflow-hidden rounded-md border bg-card">
          <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="sidebar-settings-panel">
            {settings}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    )}
  />;
}
