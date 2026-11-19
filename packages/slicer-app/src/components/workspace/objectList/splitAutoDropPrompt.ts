type SplitChoice = 'preserve' | 'drop' | null;
type Request = { readonly objectId: number };
let current: Request | null = null;
let complete: ((choice: SplitChoice) => void) | null = null;
const listeners = new Set<() => void>();
const publish = () => { for (const listener of listeners) listener(); };

/** The prompt owns no project state; the Worker validates its revision later. */
export const splitAutoDropConfirmation = {
  getSnapshot: () => current,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  request(objectId: number): Promise<SplitChoice> {
    if (current) return Promise.resolve(null);
    return new Promise((resolve) => { current = { objectId }; complete = resolve; publish(); });
  },
  finish(request: Request, choice: SplitChoice) {
    if (current !== request) return;
    const resolve = complete;
    current = null; complete = null; publish();
    resolve?.(choice);
  },
  cancel() { if (current) this.finish(current, null); },
};
