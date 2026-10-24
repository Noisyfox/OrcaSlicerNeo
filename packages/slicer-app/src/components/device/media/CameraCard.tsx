import { useRef, useState } from 'react';
import type * as D from '@orca/printer-control/domain';
import { Button } from '@/components/ui/button';
import { ControlCard } from '../PrinterControlCards';
import { MediaPlayer } from './MediaPlayer';
import { useCameraView } from './useCameraView';

export function CameraCard({ media, target, capability, name, visible, disabled }: {
  media: D.PrinterMedia; target: D.TargetRequest; capability: D.CameraMediaCapability;
  name: string; visible: boolean; disabled: boolean;
}) {
  const available = capability.liveView.kind === 'supported' && !disabled;
  const view = useCameraView(media, target, capability.cameraId, visible, available);
  const element = useRef<HTMLDivElement>(null), [fullscreenError, setFullscreenError] = useState(false);
  const [fullscreenPending, setFullscreenPending] = useState(false);
  const unavailable = disabled ? 'Live view is disabled on the printer.' : capability.liveView.kind !== 'supported' ? capability.liveView.reason : null;
  return <ControlCard title={name}><div ref={element} className="printer-camera space-y-2 bg-card p-1" data-testid="camera-card">
    {view.descriptor ? <MediaPlayer descriptor={view.descriptor} media={media} onError={view.playbackFailed} />
      : <p role="status" className="printer-camera-viewport printer-camera-placeholder">{unavailable ?? (view.error ? 'Playback unavailable' : view.wanted ? 'Connecting…' : 'Camera stopped')}</p>}
    {view.error && <p role="alert" className="text-sm text-destructive">{view.error}</p>}
    <div className="flex gap-2">
      {(!view.wanted || view.error) && <Button size="sm" variant="secondary" disabled={!available} onClick={view.play}> {view.error ? 'Retry camera' : 'Play camera'}</Button>}
      {view.wanted && <Button size="sm" variant="secondary" onClick={view.stop}>Stop camera</Button>}
      {view.descriptor && document.fullscreenEnabled && <Button size="sm" variant="ghost" disabled={fullscreenPending} onClick={() => {
        setFullscreenPending(true); setFullscreenError(false);
        const action = document.fullscreenElement ? document.exitFullscreen() : element.current!.requestFullscreen();
        void action.catch(() => setFullscreenError(true)).finally(() => setFullscreenPending(false));
      }}>Fullscreen</Button>}
    </div>
    {fullscreenError && <p className="text-xs">Fullscreen is unavailable in this window.</p>}
  </div></ControlCard>;
}
