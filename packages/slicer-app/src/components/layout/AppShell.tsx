import { type ReactNode } from 'react';
import type { AppTab } from './appTabs';
import { isWorkspaceTab } from './appTabs';

export interface AppPagePanelProps {
  active: boolean;
  id: string;
  labelledBy: string;
  children: ReactNode;
}

/**
 * Keep top-level pages mounted while making the inactive page inaccessible
 * and layout-neutral. Stateful pages (the WebGL scene and printer console)
 * therefore survive navigation without receiving input while hidden.
 */
export function AppPagePanel({ active, id, labelledBy, children }: AppPagePanelProps) {
  return (
    <div
      id={id}
      role="tabpanel"
      aria-labelledby={labelledBy}
      aria-hidden={!active}
      hidden={!active}
      inert={!active}
      className="flex min-h-0 flex-1 px-1"
    >
      {children}
    </div>
  );
}

export function AppShell({ titleBar, home, workspace, device, activeTab = 'home', toolbar, status }: {
  titleBar: ReactNode;
  toolbar: ReactNode;
  home: ReactNode;
  // Fills the row between the toolbar and the status bar, so it has to
  // stretch itself (`flex-1 min-h-0`) — see Workspace.
  workspace: ReactNode;
  device: ReactNode;
  activeTab?: AppTab;
  status: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      {titleBar}
      <div className="flex h-6 items-center gap-2 px-1 mb-0.5">{toolbar}</div>
      <AppPagePanel active={activeTab === 'home'} id="app-panel-home" labelledBy="app-tab-home">
        {home}
      </AppPagePanel>
      <AppPagePanel active={isWorkspaceTab(activeTab)} id="app-panel-workspace" labelledBy={`app-tab-${activeTab}`}>
        {workspace}
      </AppPagePanel>
      <AppPagePanel active={activeTab === 'device'} id="app-panel-device" labelledBy="app-tab-device">
        {device}
      </AppPagePanel>
      <footer className="h-6 flex items-center px-1 text-xs text-muted-foreground">{status}</footer>
    </div>
  );
}
