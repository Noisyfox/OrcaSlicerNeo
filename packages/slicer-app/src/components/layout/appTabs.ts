import { APP_TABS, type AppTab } from '@orca/platform-contract';

/** Top-level navigation tabs shared by the app shell and toolbar. */
export type { AppTab } from '@orca/platform-contract';

/** Narrow a DOM tab value to the application's supported top-level tabs. */
export function isAppTab(tab: unknown): tab is AppTab {
  return typeof tab === 'string' && (APP_TABS as readonly string[]).includes(tab);
}

export function isWorkspaceTab(tab: AppTab): tab is 'prepare' | 'preview' {
  return isPrepareTab(tab) || isPreviewTab(tab);
}

export function isPrepareTab(tab: AppTab): tab is 'prepare' {
  return tab === 'prepare';
}

export function isPreviewTab(tab: AppTab | null | undefined): tab is 'preview' {
  return tab === 'preview';
}

/** True only for an actual transition into Preview, never a Preview reselect. */
export function hasEnteredPreview(previousTab: AppTab | null | undefined, activeTab: AppTab): boolean {
  return isPreviewTab(activeTab) && !isPreviewTab(previousTab);
}
