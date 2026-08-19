import { createContext, useContext, type ReactNode } from 'react';
import type { PlatformCapabilities } from './contracts';

const PlatformContext = createContext<PlatformCapabilities | null>(null);

export function PlatformProvider({ value, children }: { value: PlatformCapabilities; children: ReactNode }) {
  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>;
}

export function usePlatform(): PlatformCapabilities {
  const value = useContext(PlatformContext);
  if (!value) throw new Error('PlatformCapabilities provider is missing');
  return value;
}
