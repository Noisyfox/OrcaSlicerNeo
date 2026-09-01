import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformCapabilities } from '@orca/platform-contract';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { useSettingsStore } from '../../../stores/useSettingsStore';

// The app package tests source files directly; the runtime package's public
// barrel aliases its generated client package only in host builds.  This
// action needs just errorText, so keep the unit test at its actual boundary.
vi.mock('@orca/slicer-runtime', () => ({
  errorText: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

import { addModel } from './sceneActions';

function platformFor(fileName: string, result: { ok: boolean; error?: string }) {
  const addModel = vi.fn(async () => result);
  return {
    platform: {
      models: { pick: vi.fn(async () => ({ displayName: fileName, bytes: new Uint8Array([1]) })) },
      runtime: { addModel },
    } as unknown as PlatformCapabilities,
    addModel,
  };
}

describe('scene add-model action', () => {
  beforeEach(() => {
    useSlicerStore.setState({ status: 'idle', error: null, resultExported: false });
    useSettingsStore.setState({ values: {}, modelLoaded: false });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('passes the selected DRC basename to the runtime', async () => {
    const { platform, addModel: runtimeAdd } = platformFor('cube_att.drc', { ok: true });
    await addModel(platform, null);
    expect(runtimeAdd).toHaveBeenCalledWith(new Uint8Array([1]), 'drc', 'cube_att.drc');
    expect(useSettingsStore.getState().values.modelPath).toBe('cube_att.drc');
  });

  it('does not expose decoder diagnostics when DRC import fails', async () => {
    const { platform } = platformFor('broken.drc', { ok: false, error: 'Draco decoder detail' });
    await addModel(platform, null);
    expect(useSlicerStore.getState().error).toBe('Unable to import DRC file');
  });
});
