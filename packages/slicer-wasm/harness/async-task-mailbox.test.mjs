import { describe, expect, it } from 'vitest';
import { awaitAsyncTask } from './async-task-mailbox.mjs';

describe('async task mailbox', () => {
  it('retains other task terminals drained while awaiting a replaced task', async () => {
    const messages = [
      { type: 'task-terminal', entry_incarnation: '10', task_id: '2', result: { error: 'cancelled' } },
      { type: 'task-terminal', entry_incarnation: '10', task_id: '3', result: { error: 'replaced' } },
      { type: 'task-terminal', entry_incarnation: '10', task_id: '4', result: { ok: true } },
    ];
    const observed = [];
    let drains = 0;
    const callJson = () => ({ ok: true, messages: drains++ === 0 ? messages : [] });
    const accepted = (task_id) => ({ accepted: true, entry_incarnation: '10', task_id });
    const wait = (task_id) => awaitAsyncTask(callJson, accepted(task_id), 100,
      (batch) => observed.push(...batch));

    expect(await wait('3')).toEqual({ error: 'replaced' });
    expect(await wait('2')).toEqual({ error: 'cancelled' });
    expect(await wait('4')).toEqual({ ok: true });
    expect(observed).toEqual(messages);
  });
});
