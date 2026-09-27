import { useEffect } from 'react';
import type { PlatformCapabilities } from '@orca/platform-contract';
import type { HistoryRestoreCoordinator } from '../history/restoreCoordinator';

interface ScopedConfigurationGateProbeProps {
  platform: PlatformCapabilities;
  coordinator: HistoryRestoreCoordinator;
}

export function ScopedConfigurationGateProbe({ platform, coordinator }: ScopedConfigurationGateProbeProps) {
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void import('../history/scopedConfigurationGate').then(({ installScopedConfigurationGate }) => {
      if (!disposed) cleanup = installScopedConfigurationGate(platform, coordinator);
    });
    return () => { disposed = true; cleanup?.(); };
  }, [platform, coordinator]);

  return null;
}
