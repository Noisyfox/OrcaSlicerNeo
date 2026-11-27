import type { LayerHeightFrame, LayerHeightProfile, LayerHeightSample, LayerHeightStroke } from '@slicer/client';
import type { SlicerRuntime } from '@orca/platform-contract';

type BrushRuntime = Pick<SlicerRuntime, 'beginLayerHeightStroke' | 'sampleLayerHeightStroke' | 'cancelLayerHeightStroke'>;

/** Keep one Worker request in flight. Every accepted sample remains in FIFO
 * order even when a newer pointer position supersedes a displayed frame. */
export class BrushQueue {
  private readonly target: Promise<LayerHeightStroke>;
  private pending: LayerHeightSample[] = [];
  private draining: Promise<void> | null = null;
  private closed = false;
  private discarded = false;

  constructor(private runtime: BrushRuntime, profile: LayerHeightProfile, private display: (frame: LayerHeightFrame) => void) {
    const target = { objectId: profile.objectId, plateId: profile.stamp.plateId };
    this.target = runtime.beginLayerHeightStroke({ ...target, stamp: profile.stamp }).then(strokeId => ({ ...target, strokeId }));
  }

  append(sample: LayerHeightSample) {
    if (this.closed) return;
    this.pending.push(sample);
    if (!this.draining) this.draining = this.drain().finally(() => { this.draining = null; });
    return this.draining;
  }

  private async drain() {
    const target = await this.target;
    while (this.pending.length) {
      const samples = this.pending;
      this.pending = [];
      const frame = await this.runtime.sampleLayerHeightStroke({ ...target, samples });
      if (!this.discarded) this.display(frame);
    }
  }

  async release() {
    this.closed = true;
    await this.draining;
    return this.target;
  }

  async cancel() {
    if (this.discarded) return;
    this.closed = this.discarded = true;
    this.pending = [];
    try { await this.draining; }
    finally { await this.runtime.cancelLayerHeightStroke(await this.target); }
  }
}
