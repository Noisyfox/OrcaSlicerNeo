import { create } from 'zustand';

/** Transient filter shared by the plate toolbar and its scrolling list. */
export const usePlateListViewStore = create<{
  searchOpen: boolean;
  query: string;
  toggleSearch: () => void;
  setQuery: (query: string) => void;
  reset: () => void;
}>((set) => ({
  searchOpen: false,
  query: '',
  toggleSearch: () => set(state => ({ searchOpen: !state.searchOpen, query: '' })),
  setQuery: query => set({ query }),
  reset: () => set({ searchOpen: false, query: '' }),
}));
