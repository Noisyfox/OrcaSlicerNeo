import { Minus, Square, X } from 'lucide-react';
import { Button } from '../ui/button';

export function TitleBar() {
  return (
    <header className="flex h-9 items-center justify-between border-b bg-card px-3 select-none">
      <span className="text-xs font-semibold tracking-wide text-muted-foreground">OrcaSlicerNeo</span>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => window.orca.minimize()} aria-label="Minimize">
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => window.orca.toggleMaximize()} aria-label="Maximize">
          <Square className="h-3 w-3" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6 hover:bg-destructive hover:text-destructive-foreground" onClick={() => window.orca.close()} aria-label="Close">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </header>
  );
}
