import { create } from 'zustand';
import type { PlateOperationTarget, SliceDiagnostic, SliceDiagnosticEvent } from '@slicer/client';

export interface NotificationAttempt extends PlateOperationTarget {
  readonly session: number;
  readonly id: number;
}

export interface NotificationAction {
  readonly id: string;
  readonly label: string;
  readonly onClick: () => void | Promise<void>;
  readonly disabled?: boolean;
  readonly testId?: string;
}

interface NotificationPresentation {
  readonly title: string;
  readonly progress: { readonly value: number | null; readonly label: string } | null;
  readonly actions: readonly NotificationAction[];
  readonly dismissible: boolean;
  readonly priority: 'foreground' | 'normal';
  readonly testId?: string;
}

export interface SliceNotification extends SliceDiagnostic, NotificationPresentation {
  readonly source: 'slice';
  readonly plateId: string;
  readonly id: string;
  readonly attempt: NotificationAttempt;
  readonly phase: 'validation' | 'slicing';
  readonly stale: boolean;
  readonly dismissed: boolean;
  readonly order: number;
}

export interface OperationNotification extends NotificationPresentation {
  readonly source: 'operation';
  readonly key: string;
  readonly status: 'active' | 'finished';
  readonly id: string;
  readonly session: number;
  readonly plateId: string;
  readonly message: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly stale: false;
  readonly dismissed: boolean;
  readonly order: number;
}
export type WorkspaceNotification = SliceNotification | OperationNotification;
export type OperationOutcome = Pick<OperationNotification, 'title' | 'message' | 'severity'>;
export type OperationNotificationInput = OperationOutcome & Pick<OperationNotification, 'key' | 'plateId'> & Partial<NotificationPresentation>;
export type OperationNotificationUpdate = Partial<OperationOutcome & NotificationPresentation>;
const isSlice = (n: WorkspaceNotification): n is SliceNotification => n.source === 'slice';

interface ActiveAttempt {
  token: NotificationAttempt;
  processing: boolean;
  invalidated: boolean;
  taskId?: string;
}

interface NotificationState {
  session: number;
  nextAttempt: number;
  nextOrder: number;
  notifications: readonly WorkspaceNotification[];
  attempts: Readonly<Record<string, ActiveAttempt>>;
  livingObjects: ReadonlySet<string> | null;
  begin: (target: PlateOperationTarget) => NotificationAttempt;
  receive: (attempt: NotificationAttempt, event: SliceDiagnosticEvent) => void;
  fail: (attempt: NotificationAttempt, message: string) => void;
  beginOperation: (input: OperationNotificationInput) => OperationNotification;
  updateOperation: (token: OperationNotification, update: OperationNotificationUpdate) => void;
  finishOperation: (token: OperationNotification, outcome: OperationOutcome) => void;
  dismiss: (id: string) => void;
  invalidate: (plateIds: readonly string[]) => void;
  reconcileOwners: (plateIds: readonly string[], objectIds: readonly string[]) => void;
  reset: () => void;
}

function activeAttempt(state: NotificationState, token: NotificationAttempt): ActiveAttempt | undefined {
  const active = state.attempts[token.plateId];
  return state.session === token.session && active?.token.id === token.id && !active.invalidated
    ? active : undefined;
}

function diagnosticKey(diagnostic: SliceDiagnostic): string {
  // Native category alone cannot collapse distinct details into one message.
  return JSON.stringify([diagnostic.severity, diagnostic.key, diagnostic.message]);
}

function replacePhase(state: NotificationState, token: NotificationAttempt,
  phase: SliceNotification['phase'], diagnostics: readonly SliceDiagnostic[]): Partial<NotificationState> {
  const grouped = new Map<string, SliceDiagnostic>();
  for (const source of diagnostics) {
    if (!source.message) continue;
    const objectIds = state.livingObjects === null ? source.objectIds
      : source.objectIds.filter(id => state.livingObjects!.has(id));
    if (source.objectIds.length && !objectIds.length) continue;
    const diagnostic = { ...source, objectIds };
    const key = diagnosticKey(diagnostic);
    const previous = grouped.get(key);
    grouped.set(key, { ...diagnostic, objectIds: [...new Set([
      ...(previous?.objectIds ?? []), ...diagnostic.objectIds,
    ])] });
  }
  const old = state.notifications.filter(isSlice).filter(n => n.plateId === token.plateId && n.phase === phase);
  let nextOrder = state.nextOrder;
  const replacement = [...grouped.entries()].map(([key, diagnostic]): SliceNotification => {
    const previous = old.find(n => n.attempt.id === token.id && diagnosticKey(n) === key);
    return {
      ...diagnostic, source: 'slice', plateId: token.plateId, id: JSON.stringify([token.session, token.id, phase, key]),
      title: diagnostic.severity === 'error' ? 'Error' : 'Warning', progress: null, actions: [],
      dismissible: true, priority: 'normal', testId: 'slice-notification',
      attempt: token, phase, stale: false, dismissed: previous?.dismissed ?? false,
      order: previous?.order ?? nextOrder++,
    };
  });
  return { nextOrder, notifications: [
    ...state.notifications.filter(n => !isSlice(n) || n.plateId !== token.plateId || n.phase !== phase),
    ...replacement,
  ] };
}

/** Presentation acknowledgement never owns slicing eligibility or result validity. */
export const useNotificationStore = create<NotificationState>((set, get) => ({
  session: 1, nextAttempt: 1, nextOrder: 1, notifications: [], attempts: {}, livingObjects: null,
  begin: target => {
    const token = { ...target, session: get().session, id: get().nextAttempt };
    set(state => ({ nextAttempt: state.nextAttempt + 1,
      attempts: { ...state.attempts, [target.plateId]: { token, processing: false, invalidated: false } },
    }));
    return token;
  },
  receive: (token, event) => set(state => {
    const active = activeAttempt(state, token);
    if (!active || event.plateId !== token.plateId || event.inputRevision !== token.inputRevision ||
        (active.taskId !== undefined && active.taskId !== event.taskId)) return state;
    // Ordered native phases cannot move an already running attempt back to validation.
    if (active.processing && event.phase === 'validation') return state;
    const next = { ...active, taskId: event.taskId };
    if (event.phase === 'processing') {
      if (active.processing) return state;
      next.processing = true;
      return { attempts: { ...state.attempts, [token.plateId]: next },
        notifications: state.notifications.filter(n => !isSlice(n) || n.plateId !== token.plateId || n.phase !== 'slicing') };
    }
    if (event.phase === 'slicing' && !active.processing) return state;
    return { ...replacePhase(state, token, event.phase, event.diagnostics),
      attempts: { ...state.attempts, [token.plateId]: next } };
  }),
  fail: (token, message) => set(state => {
    const active = activeAttempt(state, token);
    if (!active || !message) return state;
    // The terminal must not add a generic duplicate of typed native errors.
    if (state.notifications.some(n => isSlice(n) && n.attempt.id === token.id && n.severity === 'error' && n.key !== 'failure')) return state;
    const phase = active.processing ? 'slicing' : 'validation';
    const diagnostics = state.notifications.filter(isSlice).filter(n => n.attempt.id === token.id && n.phase === phase);
    return replacePhase(state, token, phase, [...diagnostics,
      { key: 'failure', severity: 'error', message, objectIds: [] }]);
  }),
  beginOperation: input => {
    const state = get();
    const token: OperationNotification = { progress: null, actions: [], dismissible: true, priority: 'normal',
      ...input, source: 'operation', status: 'active', id: `operation:${state.session}:${state.nextOrder}`,
      session: state.session, stale: false, dismissed: false, order: state.nextOrder };
    set({ nextOrder: state.nextOrder + 1,
      notifications: [...state.notifications.filter(n => n.source !== 'operation' || n.key !== input.key), token] });
    return token;
  },
  updateOperation: (token, update) => set(state => state.session !== token.session ? state : ({
    notifications: state.notifications.map(n => n.source === 'operation' && n.id === token.id && n.status === 'active'
      ? { ...n, ...update } : n),
  })),
  finishOperation: (token, outcome) => set(state => state.session !== token.session ? state : ({
    notifications: state.notifications.map(n => n.source === 'operation' && n.id === token.id && n.status === 'active'
      ? { ...n, ...outcome, status: 'finished', progress: null, actions: [], dismissible: true, priority: 'normal' } : n),
  })),
  dismiss: id => set(state => ({ notifications: state.notifications.map(n => n.id === id && n.dismissible ? { ...n, dismissed: true } : n) })),
  invalidate: plateIds => set(state => {
    if (!plateIds.length) return state;
    const affected = new Set(plateIds);
    return { notifications: state.notifications.map(n => isSlice(n) && affected.has(n.plateId) ? { ...n, stale: true } : n),
      attempts: Object.fromEntries(Object.entries(state.attempts).map(([id, active]) =>
        [id, affected.has(id) ? { ...active, invalidated: true } : active])) };
  }),
  reconcileOwners: (plateIds, objectIds) => set(state => {
    const plates = new Set(plateIds), objects = new Set(objectIds);
    return { livingObjects: objects,
      attempts: Object.fromEntries(Object.entries(state.attempts).filter(([id]) => plates.has(id))),
      notifications: state.notifications.flatMap<WorkspaceNotification>(n => {
        if (!plates.has(n.plateId)) return [];
        if (!isSlice(n)) return [n];
        if (!n.objectIds.length) return [n];
        const living = n.objectIds.filter(id => objects.has(id));
        return living.length === n.objectIds.length ? [n] : living.length ? [{ ...n, objectIds: living }] : [];
      }) };
  }),
  reset: () => set(state => ({ session: state.session + 1, notifications: [], attempts: {}, livingObjects: null })),
}));

export function visibleNotifications(notifications: readonly WorkspaceNotification[], plateId: string): WorkspaceNotification[] {
  const priority = (n: WorkspaceNotification) => n.priority === 'foreground' ? -1
    : n.stale ? 3 : n.severity === 'error' ? 0 : n.severity === 'warning' ? 1 : 2;
  return notifications.filter(n => n.plateId === plateId && !n.dismissed)
    .sort((a, b) => priority(a) - priority(b) || b.order - a.order);
}
