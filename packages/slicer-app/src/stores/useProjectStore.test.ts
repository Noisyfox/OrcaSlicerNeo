import { beforeEach, describe, expect, it } from 'vitest';
import { useProjectStore } from './useProjectStore';

describe('project session store', () => {
  beforeEach(() => useProjectStore.getState().reset());

  it('tracks clean baseline, opaque location, notices and operation progress', () => {
    const location = {} as never;
    useProjectStore.getState().setProject({ projectName: 'Robot', hasContent: true, location });
    useProjectStore.getState().markDirty();
    useProjectStore.getState().setOperation({ phase: 'saving', progress: 55, cancellable: true });
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'Robot', hasContent: true, location, dirty: true, operation: { phase: 'saving', progress: 55, cancellable: true } });
    useProjectStore.getState().markClean();
    expect(useProjectStore.getState().dirty).toBe(false);
  });

  it('reset returns to the Untitled system-scoped clean session', () => {
    useProjectStore.getState().setProject({ projectName: 'Robot', scope: 'project', dirty: true });
    useProjectStore.getState().reset();
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'Untitled', scope: 'system', dirty: false, hasContent: false, notices: [] });
  });

  it('records mutation revisions and deduplicated dirty reasons while selection stays clean', () => {
    const store = useProjectStore.getState();
    store.recordPlateMutation({
      inputRevisions: { 'plate-1': 2, 'plate-2': 0 },
      dirtyReasons: ['model-transform', 'model-transform'],
    });
    expect(useProjectStore.getState()).toMatchObject({
      dirty: true,
      dirtyReasons: ['model-transform'],
      plateInputRevisions: { 'plate-1': 2, 'plate-2': 0 },
    });
    store.markClean();
    expect(useProjectStore.getState().dirty).toBe(false);
    expect(useProjectStore.getState().dirtyReasons).toEqual([]);
    expect(useProjectStore.getState().plateInputRevisions).toEqual({ 'plate-1': 2, 'plate-2': 0 });
  });
});

