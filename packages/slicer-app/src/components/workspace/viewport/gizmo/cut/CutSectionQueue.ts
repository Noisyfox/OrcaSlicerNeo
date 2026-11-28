import type { CutSectionRequest, CutSectionResult } from '@slicer/client';

type Failure = { ok: false; error: string };
export class CutSectionQueue<Success = Extract<CutSectionResult, { ok: true }>> {
  private latest: { request: CutSectionRequest; key: string } | null = null;
  private running = false;
  constructor(private readonly compute: (request: CutSectionRequest) => Promise<Success | Failure>,
    private readonly publish: (key: string, result: Success | Failure) => void) {}

  request(request: CutSectionRequest, key: string) {
    this.latest = { request, key };
    if (!this.running) void this.drain();
  }
  clear() { this.latest = null; }
  private async drain() {
    this.running = true;
    try {
      while (this.latest) {
        const item = this.latest;
        let result: Success | Failure;
        try { result = await this.compute(item.request); }
        catch (error) { result = { ok: false, error: String(error) }; }
        if (this.latest === item) {
          this.latest = null;
          this.publish(item.key, result);
        }
      }
    } finally { this.running = false; }
  }
}
