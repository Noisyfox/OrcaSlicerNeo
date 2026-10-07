import { Box, Circle, Cone, Cylinder, Disc3, Donut, type LucideIcon } from 'lucide-react';
import type { PrimitiveType } from './actions/sceneActions';

export const PRIMITIVE_ICONS: Record<PrimitiveType, LucideIcon> = {
  Cube: Box,
  Cylinder,
  Sphere: Circle,
  Cone,
  Disc: Disc3,
  Torus: Donut,
};
