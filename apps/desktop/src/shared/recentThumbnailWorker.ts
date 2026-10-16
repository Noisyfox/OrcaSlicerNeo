/** Internal main/Node Worker protocol. Paths never reach the renderer. */
export type RecentThumbnailRequest =
  | { type: 'retain'; paths: readonly string[] }
  | { type: 'read'; requestId: number; path: string };
export interface RecentThumbnailResponse {
  requestId: number;
  url: string | null;
}
