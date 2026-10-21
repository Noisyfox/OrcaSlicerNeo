/** Native printer Web UI access, independent of control-session connectivity. */
import type { Availability, Capability, Id, ReadOptions, Result, UnixMs } from './common';

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
  routeId: Id<'route'>;
  /** Reject removed/replaced entries rather than opening a different interface. */
  interfaceId: Id<'web-interface'>;
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
   * May use saved/configured provider information without connect(). A failed
   * printer control connection must not alone mark this capability unsupported.
   * Cached observations retain their original assessment time and stale marker.
   */
  describe(routeId: Id<'route'>, options?: ReadOptions): Promise<Result<WebInterfaceDescription>>;
  /**
   * Revalidate the route/entry and resolve current launch data, including temporary
   * authorization if needed. This does not open a page or require a control session.
   * Page login is independent of API authentication; errors use the shared Result.
   */
  resolve(request: ResolveWebInterfaceRequest, options?: ReadOptions): Promise<Result<WebInterfaceLaunch>>;
}
