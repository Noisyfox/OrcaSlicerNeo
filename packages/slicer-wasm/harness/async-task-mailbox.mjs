export async function awaitAsyncTask(callJson, accepted, timeoutMs = 120_000) {
  if (accepted?.accepted !== true) return accepted;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const drained = callJson('orc_drain_async_task_mailbox', [], []);
    if (process.env.ORCA_HARNESS_TRACE === '1') {
      for (const message of drained.messages ?? [])
        if (message.task_id === accepted.task_id)
          console.error(`[async-task ${accepted.task_id}] ${message.type} ${message.percent ?? ''} ${message.text ?? message.terminal ?? ''}`.trim());
    }
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
