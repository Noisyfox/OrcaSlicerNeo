import * as THREE from 'three';

// Z-up is the slicer convention (doc/2026-08-15-viewport-z-up-convention.md).
// Object3D.DEFAULT_UP is the up vector every Object3D — cameras included — is
// born with. Setting it here makes Z-up global for every host that imports
// this package: no per-camera `up` wiring anywhere (fiber's default camera is
// constructed with this up and its lookAt(0,0,0) uses it). This module must be
// the FIRST import of the package entry — anything constructed before it runs
// keeps the three.js Y-up default.
THREE.Object3D.DEFAULT_UP = new THREE.Vector3(0, 0, 1);
