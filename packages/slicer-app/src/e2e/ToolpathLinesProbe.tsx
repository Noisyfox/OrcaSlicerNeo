import { useEffect } from 'react';
import type { ToolpathGeometry } from '../components/workspace/viewport/useSliceResult';
import type { GpuStreamingRenderer } from '../components/workspace/viewport/gpuStreamingRenderer';
import { registerOrcaE2eOwner } from './registerOrcaE2e';

interface ProbeRef<T> {
  readonly current: T;
}

interface GpuStreamingDiagnostic {
  readonly reason: string;
  readonly message: string;
}

interface ToolpathLinesProbeProps {
  activeRef: ProbeRef<{ backend: Pick<GpuStreamingRenderer, 'status' | 'debugColorSamples'> } | null>;
  diagnosticRef: ProbeRef<GpuStreamingDiagnostic | null>;
  dataRef: ProbeRef<ToolpathGeometry>;
}

export function ToolpathLinesProbe({ activeRef, diagnosticRef, dataRef }: ToolpathLinesProbeProps) {
  useEffect(() => registerOrcaE2eOwner('toolpath-lines', {
    gpuStreamingStatus: () => activeRef.current?.backend.status ?? 'unavailable',
    gpuStreamingDiagnostic: () => diagnosticRef.current,
    gpuStreamingColorSamples: () => activeRef.current?.backend.debugColorSamples() ?? [],
    previewEvidence: () => {
      const current = activeRef.current;
      const latest = dataRef.current;
      const extrusionTools = [...new Set(Array.from(latest.extruderIds)
        .filter((_, index) => latest.moveTypes[index] === 10))].sort((a, b) => a - b);
      const gcode = latest.sourceTextBytes ? new TextDecoder().decode(latest.sourceTextBytes) : '';
      const toolChanges = [...gcode.matchAll(/^T(\d+)\s*$/gm)].map((match) => Number(match[1]));
      return {
        extrusionTools,
        toolChanges,
        palette: (latest.extruderPalette ?? [])
          .filter((entry): entry is typeof entry & { tool: number } => entry.tool !== undefined)
          .map((entry) => ({ tool: entry.tool, color: [...entry.color] })),
        renderedColors: current?.backend.debugColorSamples() ?? [],
      };
    },
  }), []);

  return null;
}
