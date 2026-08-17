import React from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import App from './App';
import './index.css';

// Z-up is the slicer convention (doc/2026-08-15-viewport-z-up-convention.md).
// Object3D.DEFAULT_UP is the up vector every Object3D — cameras included — is
// born with. Setting it before the Canvas mounts makes Z-up global: no
// per-camera `up` wiring anywhere (fiber's default camera is constructed with
// this up and its lookAt(0,0,0) uses it). Must stay at the top of the
// renderer entry — anything constructed before this line keeps the three.js
// Y-up default.
THREE.Object3D.DEFAULT_UP = new THREE.Vector3(0, 0, 1);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
