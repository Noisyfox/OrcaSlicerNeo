import type { MdnsService } from '@orca/network-discovery';

/** Serializable snapshot binding; each browse belongs to the calling main-frame renderer. */
export interface MdnsBridge {
  start(id: string, serviceType: string): Promise<void>;
  snapshot(id: string): Promise<readonly MdnsService[]>;
  stop(id: string): Promise<void>;
}
