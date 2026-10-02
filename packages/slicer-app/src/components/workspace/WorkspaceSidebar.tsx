import type { ReactNode } from 'react';
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
  return <SettingsPanel sceneInteraction={sceneInteraction} onEditPrinter={onEditPrinter}
    renderLayout={({ printer, settings }) => (
      <ResizablePanelGroup orientation="vertical" id="workspace-sidebar-panels" className="min-h-0">
        <ResizablePanel id="device-material-panel" defaultSize="35%" minSize="15%" className="overflow-hidden rounded-md border bg-card">
          <div className="h-full overflow-y-auto" data-testid="sidebar-device-panel">
            {printer}
            {printerExtras}
          </div>
        </ResizablePanel>
        <ResizableHandle id="sidebar-panel-resizer" aria-label="Resize device and settings panels" data-testid="sidebar-panel-resizer" className="h-1.5! w-full! shrink-0 bg-transparent after:hidden" />
        <ResizablePanel id="configuration-panel" defaultSize="65%" minSize="20%" className="overflow-hidden rounded-md border bg-card">
          <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="sidebar-settings-panel">
            {configurationExtras && <div className="shrink-0">{configurationExtras}</div>}
            {settings}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    )}
  />;
}
