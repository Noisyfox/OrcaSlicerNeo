import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { glVolumeCollection } from './GLVolume';
import { SceneInteractionController } from './SceneInteractionController';

const SceneInteractionContext = createContext<SceneInteractionController | null>(null);

/** Shares scene interaction with viewport children and the sidebar without a UI store. */
export function SceneInteractionProvider({ children }: { children: ReactNode }) {
  const controllerRef = useRef<SceneInteractionController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new SceneInteractionController(() => glVolumeCollection.volumes);
  }
  return (
    <SceneInteractionContext.Provider value={controllerRef.current}>
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
export function useSceneInteractionVersion(): number {
  const controller = useSceneInteraction();
  const [version, setVersion] = useState(0);
  useEffect(() => controller.subscribe(() => setVersion((value) => value + 1)), [controller]);
  return version;
}
