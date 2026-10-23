import type { NativeHttpResult } from '@orca/bambu-native';
import type { BambuDevice } from '../../shared/bambuDevices';
import type { BambuRepository } from './repository';
interface CloudDevice { deviceId: string; name: string; model: string | null; revision: string }
/** Transactional complete-list reconciliation; failed/incomplete lists never erase devices. */
export class BambuDevices {
  private cloud = new Map<string, CloudDevice>();
  private session = 0;
  private request = 0;
  private active = false;
  constructor(private readonly repository: BambuRepository, private readonly changed: () => void) {}
  activate() { this.clear(); this.active = true; return this.session; }
  clear() { ++this.session; ++this.request; this.active = false; if (this.cloud.size) { this.cloud.clear(); this.changed(); } }
  async refresh(fetch: () => Promise<NativeHttpResult>): Promise<boolean> {
    if (!this.active) return false;
    const session = this.session; const request = ++this.request;
    try {
      const response = await fetch();
      if (session !== this.session || request !== this.request || !this.active || response.result !== 0 || response.httpCode < 200 || response.httpCode >= 300) return false;
      const body: unknown = JSON.parse(response.body);
      if (!body || typeof body !== 'object' || !('devices' in body) || !Array.isArray(body.devices)) return false;
      const next = new Map<string, CloudDevice>();
      for (const value of body.devices) {
        if (!value || typeof value !== 'object' || typeof value.dev_id !== 'string' || !value.dev_id.trim()
          || (value.dev_name != null && typeof value.dev_name !== 'string')
          || (value.dev_model_name != null && typeof value.dev_model_name !== 'string') || next.has(value.dev_id)) return false;
        const deviceId = value.dev_id as string;
        const name = value.dev_name?.trim() || this.cloud.get(deviceId)?.name || deviceId;
        const model = value.dev_model_name ?? this.cloud.get(deviceId)?.model ?? null;
        // Retain the route revision when the complete visible projection is unchanged.
        const previous = this.cloud.get(deviceId);
        const revision = previous && previous.name === name && previous.model === model ? previous.revision : `cloud-${session}-${request}`;
        next.set(deviceId, { deviceId, name, model, revision });
      }
      const changed = JSON.stringify([...next.values()]) !== JSON.stringify([...this.cloud.values()]);
      this.cloud = next; if (changed) this.changed(); return true;
    } catch { return false; }
  }
  async list(): Promise<readonly BambuDevice[]> {
    const devices = new Map<string, BambuDevice>();
    for (const device of this.cloud.values()) devices.set(device.deviceId, {
      deviceId: device.deviceId, name: device.name, model: device.model, routes: [{ channel: 'cloud', revision: device.revision }],
    });
    // Only already-authorized host records contribute LAN routes. Cloud responses
    // never write these records or turn a returned dev_access_code into LAN access.
    for (const record of (await this.repository.read()).lan) {
      const previous = devices.get(record.deviceId);
      devices.set(record.deviceId, { deviceId: record.deviceId, name: previous?.name ?? record.name, model: previous?.model ?? record.model,
        routes: [...previous?.routes ?? [], { channel: 'lan', revision: `lan-${record.ip}`, address: record.ip }] });
    }
    return [...devices.values()];
  }
}
