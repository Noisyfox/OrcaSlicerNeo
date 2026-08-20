import type { PlatformChrome } from '@orca/platform-contract';

export function BrandBar({ chrome }: { chrome: PlatformChrome }) {
  // macOS traffic lights float over the top-left of the custom bar; give
  // the label clearance there. Windows/Linux WCO buttons sit top-right and
  // never collide with the left-aligned label.
  return (
    <header className={`flex h-9 items-center justify-between bg-background px-3 select-none ${chrome.dragRegion ? '[-webkit-app-region:drag]' : ''} ${chrome.macSafeInset ? 'pl-20' : ''}`}>
      <span className="text-xs font-semibold tracking-wide text-muted-foreground">OrcaSlicerNeo</span>
      <a className="text-[11px] text-muted-foreground hover:text-foreground" href="https://github.com/Noisyfox/OrcaSlicerNeo" target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>AGPL-3.0 source</a>
    </header>
  );
}

/** Compatibility export for host code that still refers to the old name. */
export function TitleBar({ chrome }: { chrome: PlatformChrome }) {
  return <BrandBar chrome={chrome} />;
}
