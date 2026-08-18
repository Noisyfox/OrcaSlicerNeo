import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { SceneInteractionController } from './SceneInteractionController';

const SceneInteractionContext = createContext<SceneInteractionController | null>(null);

/** Shares the Scene-created controller with only its canvas descendants. */
export function SceneInteractionProvider({ controller, children }: {
  controller: SceneInteractionController;
  children: ReactNode;
}) {
  return (
    <SceneInteractionContext.Provider value={controller}>
      {children}
    </SceneInteractionContext.Provider>
  );
}

export function useSceneInteraction(): SceneInteractionController {
  const controller = useContext(SceneInteractionContext);
  if (!controller) throw new Error('SceneInteractionProvider is missing');
  return controller;
}

/** Re-render a React consumer when the scene controller changes. */
export function useSceneInteractionVersion(controller?: SceneInteractionController): number {
  const contextualController = useContext(SceneInteractionContext);
  const activeController = controller ?? contextualController;
  const [version, setVersion] = useState(0);
  useEffect(
    () => activeController?.subscribe(() => setVersion((value) => value + 1)),
    [activeController],
  );
  return version;
}
