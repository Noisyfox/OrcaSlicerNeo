/** Host networking contracts. No provider, UI, Node or Electron dependencies. */
export interface MdnsService {
  /** Case-normalized DNS instance FQDN; names may change after a collision. */
  id: string;
  serviceType: string;
  name: string;
  host: string;
  port: number;
  addresses: readonly string[];
  txt: Readonly<Record<string, string>>;
  expiresAtMs: number;
}
export type MdnsEvent = { type: 'upsert'; service: MdnsService } | { type: 'removed'; id: string };
export interface MdnsDiscovery {
  /** Explicit, read-only DNS-SD browsing (e.g. _http._tcp.local.). Abort/return releases resources. */
  browse(serviceType: string, options?: { signal?: AbortSignal }): AsyncIterable<MdnsEvent>;
}
