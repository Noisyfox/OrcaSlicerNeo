import { usePlatform } from '../../platform';

export function TitleBar() {
  // macOS traffic lights float over the top-left of the custom bar; give
  // the label clearance there. Windows/Linux WCO buttons sit top-right and
  // never collide with the left-aligned label.
  const isMac = usePlatform().chrome.platform === 'darwin';
  return (
    <header className={`flex h-9 items-center bg-background px-3 select-none [-webkit-app-region:drag] ${isMac ? 'pl-20' : ''}`}>
      <span className="text-xs font-semibold tracking-wide text-muted-foreground">OrcaSlicerNeo</span>
    </header>
  );
}
