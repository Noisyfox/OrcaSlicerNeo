/** Safe main/utility catalogue projection. Account association and credentials stay in the utility. */
export interface BambuCloudRoute { channel: 'cloud'; revision: string }
export interface BambuLanRoute { channel: 'lan'; revision: string; address: string }
export interface BambuDevice {
  deviceId: string;
  name: string;
  model: string | null;
  routes: readonly (BambuCloudRoute | BambuLanRoute)[];
}
export function isBambuDevice(value: unknown): value is BambuDevice {
  if (!value || typeof value !== 'object') return false;
  const device = value as BambuDevice;
  if (typeof device.deviceId !== 'string' || !device.deviceId || typeof device.name !== 'string' || (device.model !== null && typeof device.model !== 'string')
    || Object.keys(device).some(key => !['deviceId', 'name', 'model', 'routes'].includes(key)) || !Array.isArray(device.routes) || !device.routes.length) return false;
  const channels = new Set<string>();
  return device.routes.every(route => {
    if (!route || typeof route !== 'object' || !['cloud', 'lan'].includes(route.channel) || typeof route.revision !== 'string' || !route.revision || channels.has(route.channel)) return false;
    channels.add(route.channel);
    return route.channel === 'cloud' ? Object.keys(route).every(key => key === 'channel' || key === 'revision')
      : typeof route.address === 'string' && Object.keys(route).every(key => ['channel', 'revision', 'address'].includes(key));
  });
}
