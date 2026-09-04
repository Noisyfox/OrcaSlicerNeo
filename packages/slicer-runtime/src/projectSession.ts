import type { ProjectLoadBehaviour } from '../../platform-contract/src/contracts';
import type { ProjectLoadResult } from '@slicer/client';

export type ProjectLoadChoice = 'project' | 'geometry-only' | 'cancel';
export type DirtyProjectDecision = 'save' | 'dont-save' | 'cancel';

/** The policy is intentionally pure so UI and host entry points cannot drift. */
export function shouldAskProjectLoad(
  behaviour: ProjectLoadBehaviour,
  hasModel: boolean,
): boolean {
  if (behaviour === 'always_ask') return true;
  return behaviour === 'ask_when_relevant' && hasModel;
}

/** Unsupported/generic/missing-setting projects retain geometry but not config. */
export function compatibilityFallback(result: ProjectLoadResult): string | null {
  if (!result.ok) return null;
  if (result.compatibility === 'generic') return 'This 3MF contains generic geometry without supported project settings; imported as geometry with project replacement.';
  if (result.compatibility === 'unsupported' || result.projectSettingsAvailable === false) return 'Project settings in this 3MF are unavailable or incompatible; imported geometry with project replacement.';
  return null;
}

export function projectNameFromDisplayName(displayName: string): string {
  const base = displayName.replace(/[\\/]+/g, '/').split('/').pop() ?? displayName;
  return base.replace(/\.3mf$/i, '') || 'Untitled';
}
