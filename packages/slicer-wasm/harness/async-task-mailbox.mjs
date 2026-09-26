const pendingTerminals = new WeakMap();
const taskKey = (task) => `${task.entry_incarnation ?? ''}:${task.task_id}`;

export async function awaitAsyncTask(callJson, accepted, timeoutMs = 120_000, onMessages) {
  if (accepted?.accepted !== true) return accepted;
  let pending = pendingTerminals.get(callJson);
  if (!pending) { pending = new Map(); pendingTerminals.set(callJson, pending); }
  const key = taskKey(accepted);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const drained = callJson('orc_drain_async_task_mailbox', [], []);
    const messages = drained.messages ?? [];
    onMessages?.(messages);
    if (process.env.ORCA_HARNESS_TRACE === '1') {
      for (const message of messages)
        if (message.task_id === accepted.task_id)
          console.error(`[async-task ${accepted.task_id}] ${message.type} ${message.percent ?? ''} ${message.text ?? message.terminal ?? ''}`.trim());
    }
    for (const message of messages)
      if (message.type === 'task-terminal') pending.set(taskKey(message), message.result);
    if (pending.has(key)) {
      const result = pending.get(key);
      pending.delete(key);
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { error: `timed out waiting for task ${accepted.task_id}` };
}

export async function callAsyncTask(callJson, name, argTypes, args, timeoutMs) {
  return awaitAsyncTask(callJson, callJson(name, argTypes, args), timeoutMs);
}

export function resultTarget(plateId, inputStamp, resultGeneration) {
  return {
    plate_id: plateId,
    input_stamp: Number(inputStamp),
    result_generation: String(resultGeneration),
  };
}

export function getSliceResult(callJson, receipt) {
  return callJson('orc_get_slice_result', ['string', 'number', 'number'], [
    receipt.plate_id,
    Number(receipt.input_stamp),
    Number(receipt.result_generation),
  ]);
}

export function exportGcode(callJson, receipt) {
  return callJson('orc_export_gcode_plate', ['string', 'number', 'number'], [
    receipt.plate_id,
    Number(receipt.input_stamp),
    Number(receipt.result_generation),
  ]);
}
