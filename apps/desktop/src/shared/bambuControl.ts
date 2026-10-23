/** Renderer-safe domain RPC. Native protocol JSON and credentials have no representation here. */
import type * as D from '@orca/printer-control/domain';
export interface BambuControlInputs {
  describe: D.PrinterTarget;
  read: D.ObservationRequest & { source: 'cache' | 'device' };
  observe: { target: D.PrinterTarget; token: string };
  release: { token: string };
}
export interface BambuControlResults {
  describe: D.Result<D.PrinterDescription>;
  read: D.Result<D.PrinterSnapshot>;
  observe: D.Result<null>;
  release: D.Result<null>;
}
export type BambuControlMethod = keyof BambuControlInputs;
export type BambuControlRequest = { [K in BambuControlMethod]: { method: K; input: BambuControlInputs[K] } }[BambuControlMethod];
export type BambuControlCall = <K extends BambuControlMethod>(method: K, input: BambuControlInputs[K]) => Promise<BambuControlResults[K]>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const string = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 512;
export function isBambuTarget(value: unknown): value is D.PrinterTarget {
  return object(value) && exact(value, ['printerId', 'routeId']) && string(value.printerId) && string(value.routeId);
}
const topics: readonly D.StateTopic[] = ['descriptor', 'status', 'firmware', 'thermal', 'motion', 'actuators', 'materials', 'sensors', 'alerts', 'cameras'];
export function isBambuControlRequest(value: unknown): value is BambuControlRequest {
  if (!object(value) || !exact(value, ['method', 'input']) || !object(value.input)) return false;
  const input = value.input;
  if (value.method === 'describe') return isBambuTarget(input);
  if (value.method === 'release') return exact(input, ['token']) && string(input.token);
  if (value.method === 'observe') return exact(input, ['target', 'token']) && isBambuTarget(input.target) && string(input.token);
  return value.method === 'read' && exact(input, ['target', 'topics', 'source']) && isBambuTarget(input.target)
    && (input.source === 'cache' || input.source === 'device') && Array.isArray(input.topics) && input.topics.length > 0 && input.topics.length <= topics.length
    && input.topics.every(topic => topics.includes(topic)) && new Set(input.topics).size === input.topics.length;
}
