import { randomUUID } from 'node:crypto';
import type * as D from '@orca/printer-control/domain';
import type { CommandContext, PreparedCommand } from './commands';
import { printErrorResource } from './errorResources';

/** Recovery references belong to the current error/task episode; callers never supply protocol fields. */
export class BambuRecovery {
  private readonly episodes = new Map<string, { key: string; id: string; tokens: Map<string, string> }>();
  decorate(context: CommandContext): CommandContext {
    const machine = context.machine, error = machine.printError;
    const task = context.values.status.printStatus.taskId;
    const phase = context.values.status.printStatus.phase;
    const route = context.target.routeId;
    const key = JSON.stringify([context.configurationRevision, machine.toolChangeFailed, error, machine.jobId, machine.subtaskId, task.kind === 'known' ? task.value : null]);
    let episode = this.episodes.get(route);
    if (!episode || episode.key !== key) { episode = { key, id: randomUUID(), tokens: new Map() }; this.episodes.set(route, episode); }
    const recovery: NonNullable<CommandContext['recovery']> = [];
    const action = (key: string, label: string, fields: Record<string, unknown>, qos = 1, section: PreparedCommand['section'] = 'print', keepDialogOpen = false): D.PrinterAction => {
      let token = episode.tokens.get(key);
      if (!token) { token = randomUUID(); episode.tokens.set(key, token); }
      const localResume = machine.localControlOnly && (['resume', 'ignore', 'idle_ignore'].includes(String(fields.command)) || fields.command === 'ams_control' && fields.param === 'resume');
      const value: D.PrinterAction = { actionRef: { ...context.target, configurationRevision: context.configurationRevision, token: token as D.Id<'action-context'> },
        label, description: null, expiresAtMs: null, ...(keepDialogOpen ? { keepDialogOpen: true } : {}),
        availability: context.fresh && !localResume ? { kind: 'available' } : { kind: 'blocked', reasons: [{ code: context.fresh ? 'precondition-failed' : 'offline', message: context.fresh ? 'This task must be resumed on the printer.' : 'Wait for fresh printer status.' }] } };
      recovery.push({ action: value, command: { section, fields, qos } });
      return value;
    };
    let alerts = context.values.alerts;
    if (error && error !== 0x0300400c) {
      const resource = printErrorResource(context.values.descriptor.identity.serialNumber, error);
      // Orca treats an explicitly empty introduction as an internal error, with no dialog.
      alerts = alerts.filter(alert => !String(alert.id).startsWith('print:'));
      if (resource?.message !== '') {
        const code = error.toString(16).toUpperCase().padStart(8, '0');
        const severity = machine.printErrorLevel === 'unknown' ? 'error' : machine.printErrorLevel;
        const actions: D.PrinterAction[] = [];
        // DeviceErrorDialog::on_button_click. IDs without an implemented command (e.g. HMS-page navigation) stay absent.
        const legacyRetry = [0x07018004, 0x07018005, 0x07018007, 0x07018012, 0x07028012, 0x07038012, 0x07ff8012, 0x07ff8013].includes(error);
        const closeCommand = { section: 'system' as const, fields: { command: 'uiop', name: 'print_error', action: 'close', source: 1, type: 'dialog', err: code }, qos: 0 };
        for (const id of new Set(legacyRetry ? [10002, 10004] : resource?.actions ?? [])) {
          const hms = (command: string) => ({ command, err: String(error), param: 'reserve', job_id: machine.jobId });
          const ams = (param: string) => ({ command: 'ams_control', param });
          const resume: Record<number, string> = { 2: 'Resume Printing', 3: 'Resume (defects acceptable)', 4: 'Resume (problem solved)', 12: 'Filament Loaded, Resume', 28: 'Problem Solved and Resume' };
          if (resume[id]) actions.push(action(String(id), resume[id], hms('resume')));
          else if (id === 5) actions.push(action('5', 'Stop Printing', hms('stop')));
          else if (id === 25 || id === 27) actions.push(action(String(id), id === 27 ? 'Ignore this and Resume' : "Ignore. Don't Remind Next Time", hms('ignore')));
          else if (id === 23) actions.push(action('23', 'No Reminder Next Time', { command: 'idle_ignore', err: String(error), type: 0 }));
          else if (id === 7) actions.push(action('7', 'Filament Extruded, Continue', ams('done'), 0));
          else if ([8, 9, 34].includes(id)) actions.push(action(String(id), id === 8 ? 'Not Extruded Yet, Retry' : id === 9 ? 'Finished, Continue' : 'Retry (problem solved)', ams('resume'), 0, 'print', id === 8));
          else if (id === 11) actions.push(action('11', 'OK', { command: 'clean_print_error', subtask_id: machine.subtaskId, print_error: error }, 0));
          else if (id === 24) actions.push(action('24', 'Recheck', { command: 'refresh_nozzle' }));
          else if (id === 29) actions.push(action('29', 'Got it, Turn off the Fire Alarm.', { command: 'buzzer_ctrl', mode: 0 }));
          else if (id === 35) actions.push(action('35', 'Stop Drying', { command: 'auto_stop_ams_dry' }, 0));
          else if (id === 51) actions.push(action('51', 'Abort', ams('abort'), 0));
          else if (id === 54) actions.push(action('54', 'Disable Purification for This Print', { command: 'close_air_filt' }));
          else if (id === 10002) actions.push(action('10002', 'Retry', ams('resume'), 0));
          else if (id === 10004) {
            actions.push(action('10004', 'Confirm', { command: 'clean_print_error', subtask_id: machine.subtaskId, print_error: error }, 0));
            recovery[recovery.length - 1].command.followUp = closeCommand;
          }
        }
        const dismissible = !resource?.actions.includes(39);
        alerts = [...alerts, { id: `print:${episode.id}` as D.Id<'alert'>, severity, code, message: resource?.message || 'Unknown error.', actions,
          dialog: { title: { error: 'Error', warning: 'Warning', info: 'Info', unknown: 'Unknown' }[machine.printErrorLevel], dismissible,
            ...(dismissible ? { dismissAction: action('close', 'Close', closeCommand.fields, closeCommand.qos, closeCommand.section) } : {}) } }];
      }
    }
    if (machine.toolChangeFailed) {
      const actions = [action('tool-resume', 'Retry tool change', { command: 'ams_control', param: 'resume' }, 0)];
      if (phase.kind === 'known' && ['idle', 'completed', 'cancelled', 'failed'].includes(phase.value)) actions.push(action('tool-abort', 'Abort tool change', { command: 'ams_control', param: 'abort' }, 0));
      alerts = [...alerts, { id: 'tool-switch' as D.Id<'alert'>, severity: 'error', code: 'tool-switch-failed', message: 'Tool change failed.', actions }];
    }
    return { ...context, recovery, values: { ...context.values, alerts } };
  }
}
