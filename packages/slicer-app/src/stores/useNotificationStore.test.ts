import { beforeEach, describe, expect, it } from 'vitest';
import type { SliceDiagnostic, SliceDiagnosticEvent } from '@slicer/client';
import { useNotificationStore as store, visibleNotifications } from './useNotificationStore';

const warning = (message = 'Native warning', objectIds: string[] = []): SliceDiagnostic =>
  ({ key: 'native:1', severity: 'warning', message, objectIds });
const begin = (plateId = 'a', inputRevision = 1) => store.getState().begin({ plateId, inputRevision });
const event = (phase: SliceDiagnosticEvent['phase'], diagnostics: SliceDiagnostic[] = [], plateId = 'a'):
  SliceDiagnosticEvent => ({ taskId: '10', plateId, inputRevision: 1, phase, diagnostics });
const cards = (plateId = 'a') => visibleNotifications(store.getState().notifications, plateId);

describe('slice notification lifecycle', () => {
  beforeEach(() => store.getState().reset());

  it('groups equivalent diagnostics and preserves acknowledgement on repeated delivery', () => {
    const token = begin();
    store.getState().receive(token, event('validation', [warning('Same', ['1']), warning('Same', ['2'])]));
    expect(cards()).toHaveLength(1);
    expect(cards()[0].objectIds).toEqual(['1', '2']);
    store.getState().dismiss(cards()[0].id);
    store.getState().receive(token, event('validation', [warning('Same', ['1', '2'])]));
    expect(cards()).toEqual([]);
    store.getState().invalidate(['a']);
    expect(cards()).toEqual([]);
    const retry = begin();
    store.getState().receive(retry, event('validation', [warning('Same', ['1'])]));
    expect(cards()).toHaveLength(1);
  });

  it('retains stale diagnostics until the corresponding phase replaces them', () => {
    const token = begin();
    store.getState().receive(token, event('validation', [warning('Validate')]));
    store.getState().receive(token, event('processing'));
    store.getState().receive(token, event('slicing', [warning('Process')]));
    store.getState().invalidate(['a']);
    expect(cards().every(n => n.stale)).toBe(true);
    const retry = begin('a', 2);
    store.getState().receive(retry, { ...event('validation'), inputRevision: 2 });
    expect(cards().map(n => n.message)).toEqual(['Process']);
    store.getState().receive(retry, { ...event('processing'), inputRevision: 2 });
    expect(cards()).toEqual([]);
  });

  it('isolates plates, tasks, superseded attempts, invalidated inputs and project sessions', () => {
    const old = begin();
    const current = begin();
    store.getState().receive(old, event('validation', [warning('Late')]));
    store.getState().receive(current, event('validation', [warning('Current')]));
    const other = begin('b');
    store.getState().receive(other, event('validation', [warning('Other')], 'b'));
    store.getState().receive(current, { ...event('validation', [warning('Wrong task')]), taskId: '11' });
    expect(cards().map(n => n.message)).toEqual(['Current']);
    expect(cards('b').map(n => n.message)).toEqual(['Other']);
    store.getState().invalidate(['a']);
    store.getState().receive(current, event('validation', [warning('Invalid input')]));
    expect(cards()[0].message).toBe('Current');
    store.getState().reset();
    begin();
    store.getState().receive(current, event('validation', [warning('Old project')]));
    expect(cards()).toEqual([]);
  });

  it('removes deleted owners without losing surviving groups or guessing plate-scoped attribution', () => {
    const token = begin();
    store.getState().receive(token, event('validation', [warning('Group', ['1', '2']), warning('Plate')]));
    store.getState().reconcileOwners(['a'], ['2']);
    expect(cards().find(n => n.message === 'Group')?.objectIds).toEqual(['2']);
    store.getState().reconcileOwners(['a'], []);
    expect(cards().map(n => n.message)).toEqual(['Plate']);
    store.getState().receive(token, event('validation', [warning('Deleted object', ['1'])]));
    expect(cards()).toEqual([]);
    store.getState().reconcileOwners([], []);
    store.getState().receive(token, event('validation', [warning('Deleted plate')]));
    expect(cards()).toEqual([]);
  });

  it('puts fresh validation ahead of stale processing messages even if the stale message is an error', () => {
    const token = begin();
    store.getState().receive(token, event('processing'));
    store.getState().fail(token, 'Old failure');
    store.getState().invalidate(['a']);
    const retry = begin('a', 2);
    store.getState().receive(retry, { ...event('validation', [warning('New validation')]), inputRevision: 2 });
    expect(cards().map(n => [n.message, n.stale])).toEqual([['New validation', false], ['Old failure', true]]);
  });

  it('keeps warnings alongside failure, avoids duplicate native errors and orders current before stale', () => {
    const token = begin();
    store.getState().receive(token, event('validation', [warning(), { ...warning('Invalid input'), severity: 'error' }]));
    store.getState().fail(token, 'Invalid input');
    expect(cards().map(n => n.severity)).toEqual(['error', 'warning']);
    store.getState().invalidate(['a']);
    const retry = begin();
    store.getState().receive(retry, event('validation', [warning('Fresh')]));
    store.getState().receive(retry, event('processing'));
    store.getState().receive(retry, event('slicing', [warning('Later warning')]));
    store.getState().fail(retry, 'Native process failed');
    expect(cards().map(n => n.message)).toEqual(['Native process failed', 'Later warning', 'Fresh']);
    store.getState().receive(retry, event('processing'));
    expect(cards()).toHaveLength(3);
  });
});
