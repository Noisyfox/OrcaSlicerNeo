/** Desktop media URLs are scoped by opaque grants issued by their provider. */
export const printerMediaScheme = 'orca-printer-media';
export const printerMediaCsp = `media-src 'self' blob: ${printerMediaScheme}:;`;
