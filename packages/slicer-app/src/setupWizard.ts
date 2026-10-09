import type { ProfileActivation, ProfileActivationApplicationResult, SlicerClient } from '@slicer/client';
import type { UserPreferencesRepository } from '@orca/platform-contract';
import { loadSetupTransitionPreferences } from './preferences';
import { updateUserPreferences } from '@orca/platform-contract';

const completions = new WeakSet<object>();

type SetupRuntime = Pick<SlicerClient, 'prepareProfileActivation' | 'applyProfileActivation'>;
export type SetupCompletionResult = Extract<ProfileActivationApplicationResult, { ok: true }> | {
  ok: false; error: string; phase: 'prepare' | 'save' | 'apply';
};

/** Persist the native-normalized global availability before changing live state.
 * Apply failures retain both the saved record and native prepared state for retry. */
export async function completeSetupWizard(
  runtime: SetupRuntime, repository: UserPreferencesRepository, selection: ProfileActivation,
): Promise<SetupCompletionResult> {
  if (completions.has(runtime)) return failure('prepare', new Error('setup completion is already in progress'));
  completions.add(runtime);
  try {
    let prepared;
    try {
      const preferences = await loadSetupTransitionPreferences(repository);
      prepared = await runtime.prepareProfileActivation({ activation: selection,
        rememberedFilamentRacks: preferences.rememberedFilamentRacks ?? {},
        rememberedBedTypes: preferences.rememberedBedTypes });
    }
    catch (error) { return failure('prepare', error); }
    if (!prepared.ok) return { ...prepared, phase: 'prepare' };
    try {
      await updateUserPreferences(repository, current => ({ ...current, profileActivation: prepared.activation }));
    } catch (error) { return failure('save', error); }
    return await applyPrepared(runtime);
  } finally { completions.delete(runtime); }
}

/** Retry the already-saved, already-prepared native candidate without another save. */
export async function retrySetupWizardApplication(
  runtime: Pick<SetupRuntime, 'applyProfileActivation'>,
): Promise<SetupCompletionResult> {
  if (completions.has(runtime)) return failure('apply', new Error('setup completion is already in progress'));
  completions.add(runtime);
  try { return await applyPrepared(runtime); }
  finally { completions.delete(runtime); }
}

async function applyPrepared(runtime: Pick<SetupRuntime, 'applyProfileActivation'>): Promise<SetupCompletionResult> {
  try {
    const result = await runtime.applyProfileActivation();
    return result.ok ? result : { ...result, phase: 'apply' };
  } catch (error) { return failure('apply', error); }
}

function failure(phase: 'prepare' | 'save' | 'apply', error: unknown): SetupCompletionResult {
  return { ok: false, phase, error: error instanceof Error ? error.message : String(error) };
}
