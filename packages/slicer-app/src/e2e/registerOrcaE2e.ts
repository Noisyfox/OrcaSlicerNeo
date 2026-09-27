import type { HistoryObservabilitySnapshot } from '../history/historyDiagnostics';

declare const __ORCA_E2E__: boolean;

export interface OrcaE2eHooks extends Record<string, unknown> {
  historyDiagnostics?: () => HistoryObservabilitySnapshot;
}

declare global {
  interface Window {
    __orcaE2e?: OrcaE2eHooks;
  }
}

type OwnerRegistration = { unregister: () => void };

let registrationsByWindow: WeakMap<Window, Map<string, OwnerRegistration>> | undefined;

function ownerRegistrationsFor(target: Window): Map<string, OwnerRegistration> {
  registrationsByWindow ??= new WeakMap();
  let registrations = registrationsByWindow.get(target);
  if (!registrations) {
    registrations = new Map();
    registrationsByWindow.set(target, registrations);
  }
  return registrations;
}

export function registerOrcaE2eOwner<THooks extends OrcaE2eHooks>(owner: string, hooks: THooks): () => void {
  if (!__ORCA_E2E__) return () => {};

  const target = window;
  ownerRegistrationsFor(target).get(owner)?.unregister();
  const registrations = ownerRegistrationsFor(target);
  const api = target.__orcaE2e ?? (target.__orcaE2e = {});

  const entries = Object.entries(hooks);
  for (const [key, value] of entries) api[key] = value;

  let active = true;
  const unregister = () => {
    if (!active) return;
    active = false;

    for (const [key, value] of entries) {
      if (api[key] === value) delete api[key];
    }

    if (target.__orcaE2e === api && Object.keys(api).length === 0) delete target.__orcaE2e;
    if (registrations.get(owner)?.unregister === unregister) registrations.delete(owner);
    if (registrations.size === 0) registrationsByWindow?.delete(target);
  };

  registrations.set(owner, { unregister });
  return unregister;
}
