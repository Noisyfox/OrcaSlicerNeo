// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { Workspace } from './Workspace';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useSlicerStore } from '../../stores/useSlicerStore';

const sliceModelMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./actions/sliceActions', () => ({ sliceModel: sliceModelMock }));

const testMocks = vi.hoisted(() => ({
  viewportProps: [] as Array<Record<string, unknown>>,
}));

// The scene components are intentionally not part of this structural test.
// Mocks keep it focused on Workspace's ownership boundary.
vi.mock('./objectList/ObjectList', () => ({ ObjectList: () => <div data-testid="mock-object-list" /> }));
vi.mock('./settings/SettingsPanel', () => ({ SettingsPanel: () => <div data-testid="mock-settings-panel" /> }));
vi.mock('./viewport/Viewport', () => ({
  Viewport: (props: Record<string, unknown>) => {
    testMocks.viewportProps.push(props);
    return <div data-testid="mock-viewport" />;
  },
}));

const platform = {
  preferences: {
    load: vi.fn(async () => ({ version: 1 as const, selected: {}, ui: { sidebarWidth: 288 } })),
    save: vi.fn(async () => undefined),
  },
} as unknown as PlatformCapabilities;

describe('Workspace ownership', () => {
  let root: Root | undefined;

  afterEach(() => {
    root?.unmount();
    root = undefined;
    testMocks.viewportProps.length = 0;
    document.body.innerHTML = '';
    useSettingsStore.setState({ modelLoaded: false });
    useSlicerStore.setState({ status: 'idle', progress: 0, error: null });
    sliceModelMock.mockClear();
  });

  it('contains only the profile/settings sidebar and 3D scene', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Workspace /></PlatformProvider>);
    });

    expect(container.querySelector('[data-testid="mock-object-list"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mock-settings-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mock-viewport"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="device-panel"]')).toBeNull();
    expect(container.querySelector('[role="tabpanel"]')).toBeNull();
  });

  it('keeps the controller and scene resources stable across a workspace tab switch', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Workspace activeTab="prepare" /></PlatformProvider>);
    });
    const prepareProps = testMocks.viewportProps.at(-1);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Workspace activeTab="preview" /></PlatformProvider>);
    });
    const previewProps = testMocks.viewportProps.at(-1);

    expect(prepareProps).toBeDefined();
    expect(previewProps).toBeDefined();
    expect(previewProps?.activeTab).toBe('preview');
    expect(prepareProps?.sceneInteraction).toBe(previewProps?.sceneInteraction);
    expect(prepareProps?.glVolumes).toBe(previewProps?.glVolumes);
    expect(prepareProps?.toolpath).toBe(previewProps?.toolpath);
  });

  it('automatically ensures a slice on an actual transition into Preview', async () => {
    useSettingsStore.setState({ modelLoaded: true });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Workspace activeTab="prepare" /></PlatformProvider>);
    });
    expect(sliceModelMock).not.toHaveBeenCalled();

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Workspace activeTab="preview" /></PlatformProvider>);
    });

    expect(sliceModelMock).toHaveBeenCalledOnce();
  });
});
