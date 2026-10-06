import { useEffect, useRef } from 'react';
import { usePlatform } from '@orca/platform-contract';
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
  activeRef: ProbeRef<{ backend: Pick<GpuStreamingRenderer, 'status' | 'debugColorSamples' | 'pages'> } | null>;
  diagnosticRef: ProbeRef<GpuStreamingDiagnostic | null>;
  dataRef: ProbeRef<ToolpathGeometry>;
}

export function ToolpathLinesProbe({ activeRef, diagnosticRef, dataRef }: ToolpathLinesProbeProps) {
  const platform = usePlatform();
  const toolChangesCache = useRef<{ geometry: ToolpathGeometry; receiptKey: string; changes: number[] } | null>(null);
  useEffect(() => {
    let disposed = false;
    const unregister = registerOrcaE2eOwner('toolpath-lines', {
      gpuStreamingStatus: () => activeRef.current?.backend.status ?? 'unavailable',
      gpuStreamingDiagnostic: () => diagnosticRef.current,
      gpuStreamingMoveCounts: () => {
        const counts: Record<number, number> = {};
        const data = dataRef.current;
        for (const page of activeRef.current?.backend.pages ?? []) {
          const count = page.mesh.count + page.markerMesh.count;
          for (let i = 0; i < count; i++) {
            const type = data.moveTypes[page.planPage.firstSegment + page.indexData[i]];
            counts[type] = (counts[type] ?? 0) + 1;
          }
        }
        return counts;
      },
      gpuStreamingColorSamples: () => activeRef.current?.backend.debugColorSamples() ?? [],
      previewEvidence: async () => {
        const current = activeRef.current;
        const latest = dataRef.current;
        const extrusionTools = [...new Set(Array.from(latest.extruderIds)
          .filter((_, index) => latest.moveTypes[index] === 10))].sort((a, b) => a - b);
        const receiptKey = JSON.stringify([latest.receipt, latest.metadata?.resultId]);
        let toolChanges = toolChangesCache.current?.geometry === latest &&
          toolChangesCache.current.receiptKey === receiptKey
          ? toolChangesCache.current.changes : undefined;
        if (toolChanges === undefined) {
          // Source text is normally paged lazily; fetch it only when this E2E
          // diagnostic is requested, then retain just the tool-change numbers.
          let bytes = latest.sourceTextBytes;
          if (!bytes) {
            const exported = await platform.runtime.exportGcodePlate({ receipt: latest.receipt, filenameBase: '' });
            if (disposed || dataRef.current !== latest || activeRef.current !== current) return null;
            if (!exported.ok)
              throw new Error(`preview G-code export failed: ${exported.status ?? exported.error ?? 'unknown error'}`);
            bytes = exported.bytes;
          }
          if (disposed || dataRef.current !== latest || activeRef.current !== current) return null;
          const gcode = new TextDecoder().decode(bytes);
          toolChanges = [...gcode.matchAll(/^T(\d+)\s*$/gm)].map((match) => Number(match[1]));
          toolChangesCache.current = { geometry: latest, receiptKey, changes: toolChanges };
        }
        if (disposed || dataRef.current !== latest || activeRef.current !== current) return null;
        return {
          extrusionTools,
          toolChanges,
          palette: (latest.extruderPalette ?? [])
            .filter((entry): entry is typeof entry & { tool: number } => entry.tool !== undefined)
            .map((entry) => ({ tool: entry.tool, color: [...entry.color] })),
          renderedColors: current?.backend.debugColorSamples() ?? [],
        };
      },
    });
    return () => {
      disposed = true;
      toolChangesCache.current = null;
      unregister();
    };
  }, [platform.runtime]);

  return null;
}
