import React from 'react';
import { createRoot } from 'react-dom/client';
import { App, installGpuStreamingBrowserHarness } from '@orca/slicer-app';
import './styles.css';
import { slicerClient } from '@orca/slicer-runtime';
import { createElectronAdapter } from './platform/electronAdapter';
import { PlatformProvider } from '@orca/platform-contract';

// Diagnostic-only real-browser renderer harness. The helper is a no-op in
// normal Electron builds and never becomes a persisted product setting.
installGpuStreamingBrowserHarness();

// The global Z-up convention (THREE.Object3D.DEFAULT_UP) is set by the
// @orca/slicer-app package entry, before anything here constructs an Object3D.

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PlatformProvider value={createElectronAdapter(slicerClient)}>
      <App />
    </PlatformProvider>
  </React.StrictMode>
);
