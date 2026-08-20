import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@orca/slicer-app';
import '@orca/slicer-app-css';
import { PlatformProvider } from '@orca/platform-contract';
import { createBrowserAdapter } from './browserAdapter';
import { detectWebCapabilities } from './capabilities';
import { startWebApp } from './startup';
import './styles.css';

function message(text: string, detail: string) {
  document.getElementById('root')!.innerHTML = `<main class="web-startup"><h1>OrcaSlicerNeo</h1><h2>${text}</h2><p>${detail}</p><a href="https://github.com/Noisyfox/OrcaSlicerNeo" target="_blank" rel="noreferrer">AGPL-3.0 source</a></main>`;
}

void startWebApp({
  detect: detectWebCapabilities,
  isolated: crossOriginIsolated,
  // Deliberately import the runtime only after capability gating: importing
  // it constructs the Worker-backed client.
  loadRuntime: () => import('@orca/slicer-runtime'),
  render: (loadedRuntime, state) => {
    const { slicerClient } = loadedRuntime as typeof import('@orca/slicer-runtime');
    // The global Z-up convention (THREE.Object3D.DEFAULT_UP) is set by the
    // @orca/slicer-app package entry, before anything here constructs an Object3D.
    createRoot(document.getElementById('root')!).render(<React.StrictMode><div className="web-app-shell">
      {state.serialFallback && <aside className="web-serial-status" data-testid="serial-fallback-status" role="status">
        Threaded WebAssembly is unavailable in this page, so OrcaSlicerNeo is running the serial wasm64 fallback.
      </aside>}
      <PlatformProvider value={createBrowserAdapter(slicerClient)}><App /></PlatformProvider>
    </div></React.StrictMode>);
  },
  unsupported: (detail) => message('Unsupported environment', detail),
  failed: (error) => message('Startup failed', String(error)),
});
