import type { SlicerClient, SetupWizardCatalogueResult, SetupWizardCloseResult } from '@slicer/client';
type Runtime = Pick<SlicerClient, 'openSetupWizardCatalogue' | 'closeSetupWizardCatalogue'>;
const owners = new WeakMap<Runtime, Promise<void>>();
/** Catalogue ownership is serialized through terminal close, including unmount
 * during synchronous native parsing. An old effect cannot close a newer owner. */
export function createWizardCatalogueSession(runtime: Runtime) {
  const previous = owners.get(runtime) ?? Promise.resolve();
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  owners.set(runtime, released);
  let cancelled = false, opened = false;
  let opening: Promise<SetupWizardCatalogueResult> | null = null;
  let closing: Promise<SetupWizardCloseResult> | null = null;
  return {
    open(): Promise<SetupWizardCatalogueResult> {
      opening ??= (async () => {
        await previous;
        if (cancelled) return { ok: false, error: 'catalogue opening was cancelled' };
        const result = await runtime.openSetupWizardCatalogue();
        opened = result.ok;
        return result;
      })();
      return opening;
    },
    close(): Promise<SetupWizardCloseResult> {
      cancelled = true;
      closing ??= (async () => {
        await previous;
        await opening?.catch(() => undefined);
        const result = opened ? await runtime.closeSetupWizardCatalogue() : { ok: true as const };
        if (result.ok) { opened = false; release(); }
        else closing = null;
        return result;
      })().catch(error => { closing = null; throw error; });
      return closing;
    },
  };
}
