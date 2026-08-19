import React from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { App } from '@orca/slicer-app';
import '@orca/slicer-app-css';
import { PlatformProvider } from '@orca/platform-contract';
import { createBrowserAdapter } from './browserAdapter';
import { detectWebCapabilities } from './capabilities';
import './styles.css';

function message(text: string, detail: string) {
  document.getElementById('root')!.innerHTML = `<main class="web-startup"><h1>OrcaSlicerNeo</h1><h2>${text}</h2><p>${detail}</p><a href="https://github.com/Noisyfox/OrcaSlicerNeo" target="_blank" rel="noreferrer">AGPL-3.0 source</a></main>`;
}

async function start() {
  const capabilities = detectWebCapabilities();
  if (!capabilities.webgl2 || !capabilities.wasm64) { message('Unsupported environment', 'OrcaSlicerNeo Web requires WebGL 2 and wasm64 (Chrome 133 or later).'); return; }
  if (!crossOriginIsolated) console.info('Threaded WASM unavailable; using serial fallback.');
  // Deliberately import the runtime only after capability gating: importing it
  // constructs the Worker-backed client.
  const { slicerClient } = await import('@orca/slicer-runtime');
  THREE.Object3D.DEFAULT_UP = new THREE.Vector3(0, 0, 1);
  createRoot(document.getElementById('root')!).render(<React.StrictMode><PlatformProvider value={createBrowserAdapter(slicerClient)}><App /></PlatformProvider></React.StrictMode>);
}
start().catch((error) => message('Startup failed', String(error)));
