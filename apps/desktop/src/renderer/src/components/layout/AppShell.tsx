import type { ReactNode } from 'react';
import { TitleBar } from './TitleBar';

export function AppShell({ settings, viewport, toolbar, status }: {
  settings: ReactNode;
  viewport: ReactNode;
  toolbar: ReactNode;
  status: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex h-10 items-center gap-2 border-b bg-card px-3">{toolbar}</div>
      <div className="flex flex-1 min-h-0">
        <aside className="w-72 shrink-0 overflow-y-auto border-r bg-card">{settings}</aside>
        <main className="relative flex-1">{viewport}</main>
      </div>
      <footer className="h-7 border-t bg-card px-3 text-xs text-muted-foreground flex items-center">{status}</footer>
    </div>
  );
}
