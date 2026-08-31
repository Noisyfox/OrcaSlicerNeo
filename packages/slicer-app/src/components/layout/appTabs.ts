/** Top-level navigation tabs shared by the app shell and toolbar. */
export type AppTab = 'home' | 'prepare' | 'preview' | 'device';

export function isWorkspaceTab(tab: AppTab): tab is 'prepare' | 'preview' {
  return tab === 'prepare' || tab === 'preview';
}
