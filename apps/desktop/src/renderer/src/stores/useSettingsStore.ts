import { create } from 'zustand';
import type { OptionMetadata } from '@slicer/client';

interface SettingsState {
  metadata: OptionMetadata | null;
  printers: string[];
  prints: string[];
  filaments: string[];
  values: Record<string, string>;
  setMetadata: (m: OptionMetadata) => void;
  setPresets: (printers: string[], prints: string[], filaments: string[]) => void;
  setValue: (key: string, value: string) => void;
  setValues: (values: Record<string, string>) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  metadata: null,
  printers: [],
  prints: [],
  filaments: [],
  values: {},
  setMetadata: (metadata) => set({ metadata }),
  setPresets: (printers, prints, filaments) => set({ printers, prints, filaments }),
  setValue: (key, value) => set((s) => ({ values: { ...s.values, [key]: value } })),
  setValues: (values) => set({ values }),
}));
