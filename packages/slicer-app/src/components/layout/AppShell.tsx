import { type ReactNode } from 'react';

export type AppPage = 'workspace' | 'device';

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

export function AppShell({ titleBar, workspace, device, activePage, workspaceLabelledBy = 'app-tab-home', toolbar, status }: {
  titleBar: ReactNode;
  toolbar: ReactNode;
  // Fills the row between the toolbar and the status bar, so it has to
  // stretch itself (`flex-1 min-h-0`) — see Workspace.
  workspace: ReactNode;
  device: ReactNode;
  activePage: AppPage;
  workspaceLabelledBy?: string;
  status: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      {titleBar}
      <div className="flex h-6 items-center gap-2 px-1 mb-0.5">{toolbar}</div>
      <AppPagePanel active={activePage === 'workspace'} id="app-panel-workspace" labelledBy={workspaceLabelledBy}>
        {workspace}
      </AppPagePanel>
      <AppPagePanel active={activePage === 'device'} id="app-panel-device" labelledBy="app-tab-device">
        {device}
      </AppPagePanel>
      <footer className="h-6 flex items-center px-1 text-xs text-muted-foreground">{status}</footer>
    </div>
  );
}
