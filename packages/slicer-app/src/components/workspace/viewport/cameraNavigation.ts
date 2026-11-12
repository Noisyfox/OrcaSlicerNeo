import * as THREE from 'three';
import type { OrbitControls } from 'three-stdlib';
import type { PlateSessionSnapshot } from '@slicer/client';
import type { PrintableAreaBounds } from './BedPlate';
import type { SceneInteractionController } from './SceneInteractionController';

export function cameraOrbitPivot(
  mode: 'prepare' | 'preview',
  selection: Pick<SceneInteractionController, 'selectionPivot'>,
  bounds: PrintableAreaBounds,
  session: PlateSessionSnapshot | null | undefined,
): THREE.Vector3 {
  const selected = mode === 'prepare' ? selection.selectionPivot() : null;
  if (selected && selected.toArray().every(Number.isFinite)) return selected;
  const origin = session?.plates.find(plate => plate.plateId === session.currentPlateId)?.origin ?? [0, 0, 0];
  return new THREE.Vector3(origin[0] + bounds.centerX, origin[1] + bounds.centerY, origin[2]);
}

/** Rotate the complete navigation pose, preserving the pivot's camera-space position. */
export function rotateCameraAroundPivot(camera: THREE.Camera, target: THREE.Vector3, pivot: THREE.Vector3, rotation: THREE.Quaternion): void {
  camera.position.sub(pivot).applyQuaternion(rotation).add(pivot);
  camera.quaternion.premultiply(rotation);
  target.sub(pivot).applyQuaternion(rotation).add(pivot);
}

export function rotateCameraFromPointer(camera: THREE.Camera, target: THREE.Vector3, pivot: THREE.Vector3, dx: number, dy: number, height: number): void {
  // Inverse of Orca's view rotation: world-Z azimuth and camera-right zenith.
  // Clamp using the view direction, which differs from the pivot offset after pan.
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const backward = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
  const polar = Math.acos(THREE.MathUtils.clamp(backward.z, -1, 1));
  const zenith = THREE.MathUtils.clamp(polar - 2 * Math.PI * dy / height, 1e-6, Math.PI - 1e-6) - polar;
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -2 * Math.PI * dx / height)
    .multiply(new THREE.Quaternion().setFromAxisAngle(right, zenith));
  rotateCameraAroundPivot(camera, target, pivot, rotation);
}

export function panCamera(camera: THREE.Camera, target: THREE.Vector3, dx: number, dy: number, height: number): void {
  const distance = camera.position.distanceTo(target);
  const fov = (camera as THREE.PerspectiveCamera).fov ?? 45;
  const factor = 2 * distance * Math.tan(fov * Math.PI / 360) / height;
  const delta = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(-dx * factor)
    .add(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).multiplyScalar(dy * factor));
  camera.position.add(delta); target.add(delta);
}

/**
 * Keep OrbitControls' input, polar limits, pan, zoom and damping. Rebase only its
 * applied rotation onto an independent pivot using the painting pose transform.
 * Install before public change listeners so they observe the final pose, and so
 * OrbitControls caches that corrected pose when its change dispatch returns.
 */
export function installCameraOrbitPivot(controls: OrbitControls, canvas: HTMLElement, resolvePivot: () => THREE.Vector3) {
  const camera = controls.object;
  const update = controls.update;
  const pointers = new Set<number>();
  let pendingPress = false;
  let pivot: THREE.Vector3 | null = null;
  let updating = false;
  let corrected = false;
  const beforePosition = new THREE.Vector3(), beforeTarget = new THREE.Vector3();
  const beforeQuaternion = new THREE.Quaternion(), rotation = new THREE.Quaternion();
  const residualPosition = new THREE.Vector3(), pan = new THREE.Vector3();

  const correctRotation = () => {
    if (!updating || corrected || !pivot) return;
    corrected = true;
    rotation.copy(beforeQuaternion).invert().premultiply(camera.quaternion).normalize();
    if (rotation.x * rotation.x + rotation.y * rotation.y + rotation.z * rotation.z < 1e-24) return;

    // Separate pan/dolly from the default rotation around beforeTarget, then
    // apply that same damped rotation around the frozen scene pivot instead.
    residualPosition.copy(beforePosition).sub(beforeTarget).applyQuaternion(rotation).add(beforeTarget);
    residualPosition.subVectors(camera.position, residualPosition);
    pan.copy(controls.target).sub(beforeTarget);
    camera.position.copy(beforePosition); camera.quaternion.copy(beforeQuaternion); controls.target.copy(beforeTarget);
    rotateCameraAroundPivot(camera, controls.target, pivot, rotation);
    camera.position.add(residualPosition); controls.target.add(pan);
    camera.updateMatrixWorld();
  };
  const wrappedUpdate: typeof update = (...args) => {
    beforePosition.copy(camera.position); beforeTarget.copy(controls.target); beforeQuaternion.copy(camera.quaternion);
    updating = true; corrected = false;
    try {
      const changed = update(...args);
      // Sub-threshold tails need the same pivot even when no change was emitted.
      correctRotation();
      return changed;
    } finally { updating = false; }
  };
  controls.update = wrappedUpdate;
  controls.addEventListener('change', correctRotation);

  const stop = () => {
    pivot = null; pendingPress = false;
    // OrbitControls has no public inertia reset. Consume pending deltas with
    // damping disabled, restore the displayed pose, then synchronize its cache.
    // Suppress intermediate change notifications so observers never see a jump.
    const position = camera.position.clone(), target = controls.target.clone(), quaternion = camera.quaternion.clone();
    const damping = controls.enableDamping, autoRotate = controls.autoRotate, dispatch = controls.dispatchEvent;
    controls.enableDamping = false; controls.autoRotate = false;
    controls.dispatchEvent = event => { if (event.type !== 'change') dispatch.call(controls, event); };
    try {
      update();
      camera.position.copy(position); camera.quaternion.copy(quaternion); controls.target.copy(target);
      update();
      camera.updateMatrixWorld();
    } finally {
      controls.enableDamping = damping; controls.autoRotate = autoRotate; controls.dispatchEvent = dispatch;
    }
  };
  const down = (event: PointerEvent) => {
    if (pointers.size === 0) { stop(); pendingPress = true; }
    pointers.add(event.pointerId);
  };
  const up = (event: PointerEvent) => { pointers.delete(event.pointerId); if (pointers.size === 0) pendingPress = false; };
  const start = () => {
    // Body/gizmo presses veto OrbitControls before it emits start. Only an
    // admitted pointer gesture may choose a new pivot; a wheel during inertia
    // retains the current pivot rather than replacing it mid-rotation.
    if (pendingPress) { pivot = resolvePivot().clone(); pendingPress = false; }
  };
  const blur = () => { pointers.clear(); stop(); };
  controls.addEventListener('start', start);
  canvas.addEventListener('pointerdown', down, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  window.addEventListener('blur', blur);
  return {
    stop,
    dispose() {
      stop();
      controls.update = update;
      controls.removeEventListener('change', correctRotation);
      controls.removeEventListener('start', start);
      canvas.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', blur);
    },
  };
}
