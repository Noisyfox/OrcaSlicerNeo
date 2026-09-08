import { afterEach, describe, expect, it } from 'vitest';
import {
  glVolumeCollection,
  rejectGLVolumeRevision,
  waitForGLVolumeRevision,
} from './GLVolume';

describe('GL volume revision barrier', () => {
  afterEach(() => {
    glVolumeCollection.clear(glVolumeCollection.revision + 1);
  });

  it('settles only when the requested renderer revision is published', async () => {
    const revision = glVolumeCollection.revision + 1;
    let settled = false;
    const wait = waitForGLVolumeRevision(revision).then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    glVolumeCollection.clear(revision);
    await wait;
    expect(settled).toBe(true);
  });

  it('rejects stale and failed revision waits', async () => {
    const staleRevision = glVolumeCollection.revision + 1;
    const staleWait = waitForGLVolumeRevision(staleRevision);
    glVolumeCollection.clear(staleRevision + 1);
    await expect(staleWait).rejects.toThrow('superseded');

    const failedRevision = glVolumeCollection.revision + 1;
    const failedWait = waitForGLVolumeRevision(failedRevision);
    rejectGLVolumeRevision(failedRevision, new Error('mesh failed'));
    await expect(failedWait).rejects.toThrow('mesh failed');
  });
});
