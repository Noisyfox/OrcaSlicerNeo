/** Apply slicer isolation only to the application's own HTTP origin. */
export function rendererIsolationHeaders(
  requestUrl: string,
  rendererUrl: string,
  headers: Record<string, string[]> = {},
): Record<string, string[]> {
  try {
    const request = new URL(requestUrl);
    const renderer = new URL(rendererUrl);
    if (!['http:', 'https:'].includes(renderer.protocol) || request.origin !== renderer.origin) return headers;
  } catch {
    return headers;
  }
  const result = { ...headers };
  for (const name of Object.keys(result)) {
    if (['cross-origin-opener-policy', 'cross-origin-embedder-policy'].includes(name.toLowerCase())) delete result[name];
  }
  return {
    ...result,
    'Cross-Origin-Opener-Policy': ['same-origin'],
    'Cross-Origin-Embedder-Policy': ['require-corp'],
  };
}
