/** Read-only sensor definitions and observations, independent of controllable actuators. */
import type { Id, Reading, Revision } from './common';

/**
 * Extend through declaration merging of the public domain entrypoint.
 * Values must remain serializable; each added kind also needs adapter validation.
 * Generic numeric/binary definitions carry a stable, namespaced semanticType.
 */
export interface SensorTypeMap {
  temperature: {
    unit: 'celsius';
    value: number;
  };
  relativeHumidity: {
    unit: 'percent';
    value: number;
  };
  door: {
    unit: null;
    value: 'open' | 'closed';
  };
  filamentPresence: {
    unit: null;
    value: 'present' | 'absent';
  };
  acceleration: {
    unit: 'm/s²';
    value: {
      x: number;
      y: number;
      z: number;
    };
  };
  numeric: {
    unit: string | null;
    value: number;
  };
  binary: {
    unit: null;
    value: boolean;
  };
}
export type SensorKind = keyof SensorTypeMap;
export type SensorDefinitionOf<K extends SensorKind> = { [N in K]: {
  id: Id<'sensor'>;
  name: string;
  location: string | null;
  kind: N;
  unit: SensorTypeMap[N]['unit'];
} & (N extends 'numeric' | 'binary' ? {
  semanticType: string;
} : {}) }[K];
export type SensorDefinition = SensorDefinitionOf<SensorKind>;
export type SensorStateOf<K extends SensorKind> = { [N in K]: {
  sensorId: Id<'sensor'>;
  kind: N;
  reading: Reading<SensorTypeMap[N]['value']>;
} }[K];
export type SensorState = SensorStateOf<SensorKind>;

/**
 * Self-contained sensor-topic payload, independent of descriptor read support.
 * Definitions share the descriptor's authoritative source; they may come from
 * static configuration or cache without additional device discovery.
 * Adapters validate unique IDs and exactly one matching definition (including
 * kind) for each reading. TypeScript cannot enforce these cross-record checks.
 */
export interface SensorSnapshot {
  /** Scoped to target/configuration; changes with definitions, not sensor samples. */
  definitionRevision: Revision;
  definitions: readonly SensorDefinition[];
  readings: readonly SensorState[];
}
