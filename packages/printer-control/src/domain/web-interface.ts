/** Native printer Web UI access, without a printer-control connection. */
import type { Availability, Capability, Id, ReadOptions, Result, UnixMs, PrinterTarget, TargetRequest } from './common';

export interface WebInterfaceEntry {
  id: Id<'web-interface'>;
  name: string;
}

/** Optional device capability; support does not promise iframe compatibility. */
export type WebInterfaceCapability = Capability<WebInterfaceEntry>;

export interface WebInterfaceDescription {
  printerId: Id<'printer'>;
  routeId: Id<'route'>;
  /** Same capability source as PrinterCapabilities.webInterface for this route. */
  capability: WebInterfaceCapability;
  /** Provider/route assessment, not a promise of reachability from the viewing host. */
  availability: Availability;
  assessedAtMs: UnixMs;
  freshness: 'fresh' | 'stale';
}

export interface ResolveWebInterfaceRequest {
  target: TargetRequest;
  /** Optional expected entry; omission resolves the configured native entry directly. */
  interfaceId?: Id<'web-interface'>;
}

/**
 * Ephemeral launch data, not persistent printer configuration. The host validates
 * the URL and chooses embedding or external opening; no arbitrary headers/scripts
 * are delivered to the shared UI. Temporary authorization must not be logged.
 */
export interface WebInterfaceLaunch {
  printerId: Id<'printer'>;
  routeId: Id<'route'>;
  interfaceId: Id<'web-interface'>;
  /** Absolute HTTP(S) URL; the type constrains the scheme, not full URL validity. */
  url: `http://${string}` | `https://${string}`;
  /** Null means no known expiry, not guaranteed perpetual access. */
  expiresAtMs: UnixMs | null;
}

export interface PrinterWebInterfaces {
  /**
   * Local-only type/configuration/cache projection. Never probes the printer.
   * An API failure must not alone mark this capability unsupported.
   * Cached observations retain their original assessment time and stale marker.
   */
  describe(target: PrinterTarget, options?: ReadOptions): Promise<Result<WebInterfaceDescription>>;
  /**
   * Revalidate the route/entry and resolve current launch data, including temporary
   * authorization if needed by this provider. Moonraker resolves from configuration
   * without device requests, preflight or capability discovery. This never opens a page.
   * Page login is independent of API authentication; errors use the shared Result.
   */
  resolve(request: ResolveWebInterfaceRequest, options?: ReadOptions): Promise<Result<WebInterfaceLaunch>>;
}
