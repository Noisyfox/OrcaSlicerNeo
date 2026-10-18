import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { OptionStateScope, optionStateRegistry } from './optionStateRegistry';

export function useOptionStateScope<T>() {
  const [scope] = useState(() => new OptionStateScope<T>());
  useLayoutEffect(() => optionStateRegistry.retain(scope), [scope]);
  return scope;
}

export function useOptionState<T>(scope: OptionStateScope<T>, key: string) {
  const subscribe = useCallback((listener: () => void) => scope.subscribe(key, listener), [scope, key]);
  const get = useCallback(() => scope.get(key), [scope, key]);
  return useSyncExternalStore(subscribe, get, get);
}

export function useVisibleOptionCount<T>(scope: OptionStateScope<T>, keys: readonly string[]) {
  const subscribe = useCallback((listener: () => void) => {
    const cleanups = keys.map(key => scope.subscribe(key, listener));
    return () => { for (const cleanup of cleanups) cleanup(); };
  }, [scope, keys]);
  const get = useCallback(() => keys.reduce((count, key) => count + (scope.get(key)?.visible ? 1 : 0), 0), [scope, keys]);
  return useSyncExternalStore(subscribe, get, get);
}
