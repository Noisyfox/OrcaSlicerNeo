import { expect, it } from 'vitest';
import { primeTowerProjectionPendingCount, trackPrimeTowerProjectionRead } from './WorkspaceHistoryProbe';

it('keeps a superseded read pending after the newest read settles, including rejection', async () => {
  const runtime = {};
  let resolveLatest!: () => void;
  let rejectOlder!: (error: Error) => void;
  const older = new Promise<void>((_resolve, reject) => { rejectOlder = reject; });
  const latest = new Promise<void>(resolve => { resolveLatest = resolve; });
  trackPrimeTowerProjectionRead(runtime, older);
  trackPrimeTowerProjectionRead(runtime, latest);
  expect(primeTowerProjectionPendingCount(runtime)).toBe(2);
  expect(primeTowerProjectionPendingCount({})).toBe(0);
  resolveLatest();
  await latest;
  expect(primeTowerProjectionPendingCount(runtime)).toBe(1);
  rejectOlder(new Error('superseded RPC failed'));
  await older.catch(() => {});
  expect(primeTowerProjectionPendingCount(runtime)).toBe(0);
});
