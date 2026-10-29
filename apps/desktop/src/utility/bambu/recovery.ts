import { randomUUID } from 'node:crypto';
import type * as D from '@orca/printer-control/domain';
import type { CommandContext } from './commands';
/** Recovery references are scoped to an observed error episode, never caller-authored protocol actions. */
export class BambuRecovery {
  private readonly episodes = new Map<string, { key: string; retry: string; abort: string }>();
  decorate(context: CommandContext): CommandContext {
    const p = context.report;
    const failed = context.machine.toolChangeFailed;
    const task = context.values.status.printStatus.taskId;
    const phase = context.values.status.printStatus.phase;
    const route = context.target.routeId;
    const key = JSON.stringify([context.configurationRevision, failed, p.print_error, task.kind === 'known' ? task.value : null]);
    let episode = this.episodes.get(route);
    if (!episode || episode.key !== key) { episode = { key, retry: randomUUID(), abort: randomUUID() }; this.episodes.set(route, episode); }
    if (!failed) return context;
    const actions: NonNullable<CommandContext['recovery']> = [];
    const add = (kind: 'resume' | 'abort', token: string, label: string) => {
      const action: D.PrinterAction = { actionRef: { ...context.target, configurationRevision: context.configurationRevision, token: token as D.Id<'action-context'> },
        label, description: kind === 'resume' ? 'Retry the failed tool change.' : 'Abort the failed tool change.', expiresAtMs: null,
        availability: context.fresh ? { kind: 'available' } : { kind: 'blocked', reasons: [{ code: 'offline', message: 'Wait for fresh printer status.' }] } };
      actions.push({ action, kind });
    };
    add('resume', episode.retry, 'Retry tool change');
    if (phase.kind === 'known' && ['idle', 'completed', 'cancelled', 'failed'].includes(phase.value)) add('abort', episode.abort, 'Abort tool change');
    return { ...context, recovery: actions, values: { ...context.values, alerts: [...context.values.alerts, {
      id: 'tool-switch' as D.Id<'alert'>, severity: 'error', code: 'tool-switch-failed', message: 'Tool change failed.', actions: actions.map(item => item.action),
    }] } };
  }
}
