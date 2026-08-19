// apps/desktop/src/renderer/src/components/status/StatusBar.tsx
import { useSlicerStore } from '../../stores/useSlicerStore';
import { Progress } from '@/components/ui/progress';

export function StatusBar() {
  const status = useSlicerStore((s) => s.status);
  const progress = useSlicerStore((s) => s.progress);
  const layers = useSlicerStore((s) => s.layers);
  const error = useSlicerStore((s) => s.error);

  return (
    <div className="flex w-full items-center gap-3">
      <span className="shrink-0" data-testid="slicer-status">{statusText(status)}</span>
      {status === 'slicing' && (
        <Progress value={progress} data-testid="slicer-progress" data-progress={progress} className="w-40" />
      )}
      {status === 'done' && layers > 0 && (
        <span>{layers} layers</span>
      )}
      {error && <span className="text-destructive truncate">{error}</span>}
    </div>
  );
}

function statusText(s: string): string {
  switch (s) {
    case 'idle': return 'Ready';
    case 'slicing': return 'Slicing…';
    case 'done': return 'Sliced';
    case 'error': return 'Error';
    default: return s;
  }
}
