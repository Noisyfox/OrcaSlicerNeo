import type {
  MenuCommandId,
  MenuStateSnapshot,
  PlatformCapabilities,
} from '@orca/platform-contract';

export interface CommandActions {
  addModel: () => Promise<void>;
  clearScene: () => Promise<void>;
  slice: () => Promise<void>;
  exportGcode: () => Promise<void>;
  openSource: () => Promise<void>;
  quit: () => Promise<void>;
}

export interface CommandDispatcher {
  /** Returns false when the command was stale, disabled, or after disposal. */
  dispatch(command: MenuCommandId): Promise<boolean>;
  dispose(): void;
}

export interface CreateCommandDispatcherOptions {
  getSnapshot: () => MenuStateSnapshot;
  actions: CommandActions;
}

/**
 * The only shared-app command gate. Callers may render a stale enabled state,
 * so dispatch reads the current complete snapshot twice immediately before
 * invoking an action and also prevents duplicate in-flight transitions.
 */
export function createCommandDispatcher({
  getSnapshot,
  actions,
}: CreateCommandDispatcherOptions): CommandDispatcher {
  let active = true;
  const inFlight = new Set<MenuCommandId>();

  return {
    async dispatch(command) {
      if (!active || inFlight.has(command)) return false;
      if (!getSnapshot().items[command]?.enabled) return false;

      // A store update can happen between a menu click and this call. The
      // second read is intentionally adjacent to action selection.
      const current = getSnapshot();
      if (!current.items[command]?.enabled) return false;

      inFlight.add(command);
      try {
        await actions[commandToAction(command)]();
        return active;
      } catch (error) {
        // Existing action helpers own user-facing error state. The dispatcher
        // still absorbs a host/action exception so native callbacks cannot
        // create an unhandled rejection.
        console.error(`menu command failed: ${command}`, error);
        return false;
      } finally {
        inFlight.delete(command);
      }
    },
    dispose() {
      active = false;
      inFlight.clear();
    },
  };
}

function commandToAction(command: MenuCommandId): keyof CommandActions {
  switch (command) {
    case 'add-model': return 'addModel';
    case 'clear-scene': return 'clearScene';
    case 'slice': return 'slice';
    case 'export-gcode': return 'exportGcode';
    case 'open-source': return 'openSource';
    case 'quit': return 'quit';
  }
}

/** Register the host's native menu callback at the shared-app boundary. */
export function registerNativeMenuCommands(
  platform: Pick<PlatformCapabilities, 'menu'>,
  dispatcher: CommandDispatcher,
): () => void {
  return platform.menu.onCommand((command) => {
    void dispatcher.dispatch(command);
  });
}
