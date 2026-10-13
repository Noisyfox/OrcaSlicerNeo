import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import type { PlateSessionSnapshot } from '@slicer/client';
import { BED_SIZE, type PrintableAreaBounds } from './BedPlate';

const CAMERA_DISTANCE_PER_BED_MM = 450 / BED_SIZE;

/** Initialize or resize framing around the current plate, retaining ordinary navigation. */
export function CameraFraming({
  bounds,
  mode,
  plateSession,
  previewFrameRequest,
}: {
  bounds: PrintableAreaBounds;
  mode: 'prepare' | 'preview';
  plateSession?: PlateSessionSnapshot | null;
  previewFrameRequest?: { plateId: string; token: number } | null;
}) {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls as unknown as {
    target: THREE.Vector3;
    update: () => void;
  } | undefined);
  const appliedFramingRef = useRef<{ key: string; camera: typeof camera; controls: typeof controls } | null>(null);
  const appliedPreviewFrameTokenRef = useRef<number | null>(null);

  useEffect(() => {
    // Profile snapshots replace arrays even when the bed is unchanged. Only
    // changed framing dimensions may overwrite the user's orbit/pan/zoom.
    const key = [bounds.width, bounds.depth, bounds.centerX, bounds.centerY].join(',');
    const applied = appliedFramingRef.current;
    if (applied?.key === key && applied.camera === camera && applied.controls === controls) return;
    const plate = plateSession?.plates.find((candidate) => candidate.plateId === plateSession.currentPlateId);
    const origin = plate?.origin ?? [0, 0, 0];
    const distance = Math.max(300, Math.max(bounds.width, bounds.depth) * CAMERA_DISTANCE_PER_BED_MM);
    const target = new THREE.Vector3(origin[0] + bounds.centerX, origin[1] + bounds.centerY, origin[2]);
    camera.position.set(
      target.x,
      target.y - distance / Math.SQRT2,
      target.z + distance / Math.SQRT2,
    );
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    if (controls) {
      controls.target.copy(target);
      controls.update();
    }
    appliedFramingRef.current = { key, camera, controls };
  }, [bounds, camera, controls, plateSession]);

  useEffect(() => {
    if (mode !== 'preview' || !previewFrameRequest || appliedPreviewFrameTokenRef.current === previewFrameRequest.token) return;
    const plate = plateSession?.plates.find((candidate) => candidate.plateId === previewFrameRequest.plateId);
    if (!plate) return;

    const target = new THREE.Vector3(
      plate.origin[0] + bounds.centerX,
      plate.origin[1] + bounds.centerY,
      plate.origin[2],
    );
    const previousTarget = controls?.target?.clone() ?? new THREE.Vector3(bounds.centerX, bounds.centerY, 0);
    const cameraOffset = camera.position.clone().sub(previousTarget);
    camera.position.copy(target).add(cameraOffset);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    if (controls) {
      controls.target.copy(target);
      controls.update();
    }
    appliedPreviewFrameTokenRef.current = previewFrameRequest.token;
  }, [bounds, camera, controls, mode, plateSession, previewFrameRequest]);

  return null;
}
