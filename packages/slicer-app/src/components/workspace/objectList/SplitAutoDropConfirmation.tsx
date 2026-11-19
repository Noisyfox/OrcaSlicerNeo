import { useEffect, useSyncExternalStore } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { splitAutoDropConfirmation } from './splitAutoDropPrompt';

export function SplitAutoDropConfirmation() {
  const request = useSyncExternalStore(splitAutoDropConfirmation.subscribe,
    splitAutoDropConfirmation.getSnapshot, splitAutoDropConfirmation.getSnapshot);
  useEffect(() => () => splitAutoDropConfirmation.cancel(), []);
  if (!request) return null;
  return <Dialog open onOpenChange={(open) => { if (!open) splitAutoDropConfirmation.finish(request, null); }}>
    <DialogContent data-testid="split-auto-drop-confirmation">
      <DialogTitle>Object has floating parts</DialogTitle>
      <DialogDescription>Disable Auto Drop for the new objects to preserve their Z positions, or keep it enabled and place each object on the bed.</DialogDescription>
      <DialogFooter>
        <Button variant="outline" onClick={() => splitAutoDropConfirmation.finish(request, null)}>Cancel</Button>
        <Button variant="outline" data-testid="split-auto-drop-preserve" onClick={() => splitAutoDropConfirmation.finish(request, 'preserve')}>Preserve positions</Button>
        <Button data-testid="split-auto-drop-place" onClick={() => splitAutoDropConfirmation.finish(request, 'drop')}>Place on bed</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
