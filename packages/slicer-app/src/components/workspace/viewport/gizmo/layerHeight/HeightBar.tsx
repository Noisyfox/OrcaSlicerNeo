import { useLayoutEffect, useRef, type PointerEvent } from 'react';
import type { LayerHeightFrame, LayerHeightSample } from '@slicer/client';
import { useLayerHeight } from './state';

import { recordLayerHeightPaint } from '@/e2e/layerHeightProbe';
declare const __ORCA_E2E__: boolean;

function heightAt(curve: number[], z: number) {
  let i = 0;
  while (i + 2 < curve.length && curve[i + 2] <= z) i += 2;
  if (i + 2 === curve.length || z <= curve[i]) return curve[i + 1];
  return curve[i + 1] + (curve[i + 3] - curve[i + 1]) * (z - curve[i]) / (curve[i + 2] - curve[i]);
}

export function HeightBar({ frame, begin, append, release, cancel }: {
  frame: LayerHeightFrame; begin: () => boolean; append: (sample: LayerHeightSample) => void;
  release: () => void; cancel: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const held = useRef<{ pointer: number; button: number; sample: LayerHeightSample; timer: number } | null>(null);
  const cursor = useLayerHeight(s => s.cursor);
  const width = useLayerHeight(s => s.width);
  const { profile } = frame;
  useLayoutEffect(() => {
    const node = canvas.current!;
    const theme = getComputedStyle(node);
    const reference = theme.getPropertyValue('--color-muted-foreground').trim();
    const curve = theme.getPropertyValue('--color-ring').trim();
    function paint() {
      const scale = window.devicePixelRatio || 1;
      const w = node.width = Math.max(1, Math.round(node.clientWidth * scale));
      const h = node.height = Math.max(1, Math.round(node.clientHeight * scale));
      const ctx = node.getContext('2d');
      if (!ctx) return;
      const strip = Math.round(w * .26);
      const img = ctx.createImageData(1, h);
      for (let y = 0; y < h; y++) {
        const cell = Math.round((1 - y / Math.max(1, h - 1)) * (frame.cells - 1));
        const offset = (cell + Math.floor(cell / (frame.width - 1))) * 4;
        img.data.set(frame.pixels.subarray(offset, offset + 4), y * 4);
      }
      const stripe = document.createElement('canvas');
      stripe.width = 1;
      stripe.height = h;
      stripe.getContext('2d')?.putImageData(img, 0, 0);
      ctx.drawImage(stripe, 0, 0, strip, h);
      const x = (value: number) => strip + (w - strip - scale) * value / Math.max(profile.maxHeight, profile.firstHeight);
      const y = (z: number) => h * (1 - z / profile.objectHeight);
      ctx.strokeStyle = reference;
      ctx.setLineDash([3 * scale, 3 * scale]);
      ctx.beginPath(); ctx.moveTo(x(profile.baseHeight), 0); ctx.lineTo(x(profile.baseHeight), h); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = curve;
      ctx.lineWidth = 2 * scale;
      ctx.beginPath();
      for (let i = 0; i < profile.curve.length; i += 2) {
        const px = x(profile.curve[i + 1]), py = y(profile.curve[i]);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      if (cursor !== null) {
        ctx.fillStyle = reference;
        ctx.globalAlpha = .25;
        ctx.fillRect(0, y(cursor + width / 2), w, h * width / profile.objectHeight);
        ctx.globalAlpha = 1;
      }
      if (__ORCA_E2E__) recordLayerHeightPaint(frame, 'bar');
    }
    paint();
    const observer = new ResizeObserver(paint);
    observer.observe(node);
    return () => observer.disconnect();
  }, [frame, profile, width, cursor]);

  const stop = () => {
    if (!held.current) return false;
    window.clearInterval(held.current.timer);
    held.current = null;
    return true;
  };
  useLayoutEffect(() => {
    const interrupt = () => { if (stop()) cancel(); };
    window.addEventListener('blur', interrupt);
    return () => { window.removeEventListener('blur', interrupt); interrupt(); };
  }, [cancel]);

  function sample(event: PointerEvent<HTMLCanvasElement>, button: number): LayerHeightSample {
    const rect = event.currentTarget.getBoundingClientRect();
    const z = Math.max(0, Math.min(1, (rect.bottom - event.clientY) / rect.height)) * profile.objectHeight;
    useLayerHeight.setState({ cursor: z });
    return { z, width: useLayerHeight.getState().width, action: event.shiftKey ? (button === 2 ? 3 : 2) : (button === 2 ? 0 : 1) };
  }
  return <div data-layer-height-control className="pointer-events-auto absolute inset-y-0 right-0 z-30 w-16 border-l border-border bg-card"
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onWheel={event => {
      event.stopPropagation();
      if (!event.deltaY) return;
      const next = Math.max(1.5, Math.min(10, width * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
      useLayerHeight.setState({ width: next });
      if (held.current) held.current.sample = { ...held.current.sample, width: next };
    }}>
    <canvas ref={canvas} aria-label="Variable layer height brush" data-testid="layer-height-bar"
      className="h-full w-full touch-none cursor-crosshair"
      onPointerDown={e => {
        if (held.current || (e.button !== 0 && e.button !== 2) || !begin()) return;
        e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
        const next = sample(e, e.button);
        held.current = { pointer: e.pointerId, button: e.button, sample: next,
          timer: window.setInterval(() => { if (held.current) append(held.current.sample); }, 100) };
        append(next);
      }}
      onPointerMove={e => {
        const state = held.current;
        if (state && state.pointer !== e.pointerId) return;
        const next = sample(e, state?.button ?? 0);
        if (state) { state.sample = next; append(next); }
      }}
      onPointerLeave={() => { if (!held.current) useLayerHeight.setState({ cursor: null }); }}
      onPointerUp={e => { if (held.current?.pointer === e.pointerId && stop()) release(); }}
      onPointerCancel={e => { if (held.current?.pointer === e.pointerId && stop()) cancel(); }}
      onLostPointerCapture={e => { if (held.current?.pointer === e.pointerId && stop()) cancel(); }} />
    {cursor !== null && <output className="pointer-events-none absolute right-full rounded border border-border bg-popover px-1.5 py-0.5 text-xs whitespace-nowrap text-popover-foreground tabular-nums"
      style={{ top: `clamp(0px, ${100 * (1 - cursor / profile.objectHeight)}%, calc(100% - 1.5rem))` }}>
      Z {cursor.toFixed(2)} · {heightAt(profile.curve, cursor).toFixed(3)} mm
    </output>}
  </div>;
}
