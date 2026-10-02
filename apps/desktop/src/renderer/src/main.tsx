import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@orca/slicer-app';
import './styles.css';
import { createElectronRuntime } from './platform/electronRuntime';
import { createElectronAdapter } from './platform/electronAdapter';
import { PlatformProvider } from '@orca/platform-contract';

// The global Z-up convention (THREE.Object3D.DEFAULT_UP) is set by the
// @orca/slicer-app package entry, before anything here constructs an Object3D.

// Test-only A/B baseline. Production has no renderer-runtime fallback.
async function mount() {
  const slicerClient = import.meta.env.VITE_E2E === '1' && import.meta.env.VITE_RUNTIME_BASELINE === '1'
    ? (await import('../../../../../packages/slicer-runtime/src/slicer/slicerClient')).slicerClient
    : createElectronRuntime();
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <PlatformProvider value={createElectronAdapter(slicerClient)}>
        <App />
      </PlatformProvider>
    </React.StrictMode>
  );
}
void mount();
