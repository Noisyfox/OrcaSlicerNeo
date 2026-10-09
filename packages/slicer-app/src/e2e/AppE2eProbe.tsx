import { useEffect } from 'react';
import { syncHistoryStatus } from '../components/workspace/actions/historyMutation';
import type { PlatformCapabilities } from '@orca/platform-contract';
import type { ProjectLoadReceipt } from '../projectActions';
import { useProjectStore } from '../stores/useProjectStore';
import { registerOrcaE2eOwner } from './registerOrcaE2e';

interface AppE2eProbeProps {
  platform: PlatformCapabilities;
  projectLoadReceiptRef: { readonly current: ProjectLoadReceipt | null };
}

type RealProjectProfileRuntime = PlatformCapabilities['runtime'] & {
  realProjectProfileActiveSliceCount(): Promise<unknown>;
  realProjectProfileLastRestoreSliceActive(): boolean | null;
  takeRealProjectProfileSnapshot(): Promise<unknown>;
};

export function AppE2eProbe({ platform, projectLoadReceiptRef }: AppE2eProbeProps) {
  useEffect(() => {
    const env = import.meta.env as { MODE?: string; VITE_E2E?: string; VITE_REAL_PROJECT_PROFILE?: string };
    if (env.MODE !== 'e2e' && env.VITE_E2E !== '1') return;

    const realProjectRuntime = platform.runtime as RealProjectProfileRuntime;
    return registerOrcaE2eOwner('app-project-profile', {
      setupActivationEvidence: async () => ({ history: await syncHistoryStatus(platform.runtime),
        profiles: await platform.runtime.getProfileSnapshot() }),
      projectLoadEvidence: () => {
        const project = useProjectStore.getState();
        return {
          receipt: projectLoadReceiptRef.current,
          session: {
            projectName: project.projectName,
            hasContent: project.hasContent,
            scope: project.scope,
            hasLocation: project.location !== undefined,
          },
        };
      },
      takeNativePerformanceProfile: () => platform.runtime.takeNativePerformanceProfile?.() ??
        Promise.resolve({ version: 1, samples: [] }),
      ...(env.VITE_REAL_PROJECT_PROFILE === '1' ? {
        realProjectProfileMutationPendingCount: () => useProjectStore.getState().projectMutationPendingCount,
        realProjectProfileActiveSliceCount: () => realProjectRuntime.realProjectProfileActiveSliceCount(),
        realProjectProfileLastRestoreSliceActive: () => realProjectRuntime.realProjectProfileLastRestoreSliceActive(),
        takeRealProjectProfileSnapshot: () => realProjectRuntime.takeRealProjectProfileSnapshot(),
      } : {}),
    });
  }, [platform, projectLoadReceiptRef]);

  return null;
}
