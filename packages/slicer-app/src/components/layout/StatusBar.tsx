// packages/slicer-app/src/components/layout/StatusBar.tsx
import { useSlicerStore } from '../../stores/useSlicerStore';
import { Progress } from '@/components/ui/progress';
import { usePlatform } from '@orca/platform-contract';

export function StatusBar() {
  const status = useSlicerStore((s) => s.status);
  const progress = useSlicerStore((s) => s.progress);
  const layers = useSlicerStore((s) => s.layers);
  const error = useSlicerStore((s) => s.error);
  const platform = usePlatform();

  return (
    <div className="flex w-full items-center gap-3">
      <span className="shrink-0" data-testid="slicer-status">{statusText(status)}</span>
      {status === 'slicing' && (
        <Progress value={progress} data-testid="slicer-progress" data-progress={progress} className="w-40" />
      )}
      {status === 'done' && layers > 0 && (
        <span>{layers} layers</span>
      )}
      {error && (
        <span className="min-w-0 text-destructive" data-testid="slicer-error" role="alert" title={error}>
          {error}
        </span>
      )}
      {platform.chrome.kind === 'web' && typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated && (
        <span className="ml-auto shrink-0" data-testid="serial-runtime-status">Single-thread fallback</span>
      )}
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
