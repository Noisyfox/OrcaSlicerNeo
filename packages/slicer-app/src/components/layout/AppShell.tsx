import { type ReactNode } from 'react';

export function AppShell({ titleBar, workspace, toolbar, status }: {
  titleBar: ReactNode;
  toolbar: ReactNode;
  // Fills the row between the toolbar and the status bar, so it has to
  // stretch itself (`flex-1 min-h-0`) — see Workspace.
  workspace: ReactNode;
  status: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      {titleBar}
      <div className="flex h-6 items-center gap-2 px-1 mb-0.5">{toolbar}</div>
      {workspace}
      <footer className="h-6 flex items-center px-1 text-xs text-muted-foreground">{status}</footer>
    </div>
  );
}
