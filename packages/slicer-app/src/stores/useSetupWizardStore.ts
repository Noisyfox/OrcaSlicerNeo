import { create } from 'zustand';
export const useSetupWizardStore = create<{ active: boolean; setActive(active: boolean): void }>(set => ({ active: false, setActive: active => set({ active }) }));
