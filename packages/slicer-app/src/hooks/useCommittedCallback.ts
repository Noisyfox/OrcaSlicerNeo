import { useCallback, useLayoutEffect, useRef } from 'react';

/** Stable event identity, always dispatching to the latest committed render. */
export function useCommittedCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  const latest = useRef(callback);
  useLayoutEffect(() => { latest.current = callback; });
  return useCallback((...args: Args) => latest.current(...args), []);
}
