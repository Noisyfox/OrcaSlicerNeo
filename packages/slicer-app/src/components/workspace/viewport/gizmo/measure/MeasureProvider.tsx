import { createContext, useContext, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { readProjectMutationReservation } from '@/components/workspace/actions/historyMutation';
import { MeasureController } from './MeasureController';
import { registerMeasureCommands } from './projectCommands';

const Context = createContext<MeasureController | null>(null);

/** The Prepare workspace stays mounted while Home and Device are shown. */
export function MeasureProvider({ children }: { children: ReactNode }) {
  const { runtime } = usePlatform();
  const owner = useRef<MeasureController | null>(null);
  if (!owner.current) owner.current = new MeasureController({
    api: runtime,
    coordinate: readProjectMutationReservation,
    canMeasure: () => !runtime.getRuntimeExecutionState?.().serialSliceActive,
    admissionKey: () => {
      const state = runtime.getRuntimeExecutionState?.();
      return state?.threaded === true ? 'threaded' : `serial:${state?.serialTerminalEpoch ?? '0'}`;
    },
    invalidate: () => {},
  });
  useLayoutEffect(() => registerMeasureCommands(owner.current!), []);
  return <Context.Provider value={owner.current}>{children}</Context.Provider>;
}

export function useMeasureController(): MeasureController | null { return useContext(Context); }
export function useMeasureState() {
  const controller = useMeasureController();
  return useSyncExternalStore(controller?.subscribe ?? noSubscribe, controller?.getSnapshot ?? noSnapshot);
}
const noSubscribe = () => () => {};
const noSnapshot = () => null;
