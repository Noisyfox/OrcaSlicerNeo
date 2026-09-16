export async function awaitAsyncTask(callJson, accepted, timeoutMs = 120_000) {
  if (accepted?.accepted !== true) return accepted;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const drained = callJson('orc_drain_async_task_mailbox', [], []);
    const terminal = drained.messages?.find((message) =>
      message.type === 'task-terminal' && message.task_id === accepted.task_id);
    if (terminal) return terminal.result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { error: `timed out waiting for task ${accepted.task_id}` };
}

export async function callAsyncTask(callJson, name, argTypes, args, timeoutMs) {
  return awaitAsyncTask(callJson, callJson(name, argTypes, args), timeoutMs);
}
