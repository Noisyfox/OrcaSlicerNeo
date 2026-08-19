import { usePlatform } from '@orca/platform-contract';

export function TitleBar() {
  // macOS traffic lights float over the top-left of the custom bar; give
  // the label clearance there. Windows/Linux WCO buttons sit top-right and
  // never collide with the left-aligned label.
  const isMac = usePlatform().chrome.platform === 'darwin';
  const chrome = usePlatform().chrome;
  return (
    <header className={`flex h-9 items-center justify-between bg-background px-3 select-none ${chrome.kind === 'desktop' ? '[-webkit-app-region:drag]' : ''} ${isMac && chrome.kind === 'desktop' ? 'pl-20' : ''}`}>
      <span className="text-xs font-semibold tracking-wide text-muted-foreground">OrcaSlicerNeo</span>
      <a className="text-[11px] text-muted-foreground hover:text-foreground" href="https://github.com/Noisyfox/OrcaSlicerNeo" target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>AGPL-3.0 source</a>
    </header>
  );
}
