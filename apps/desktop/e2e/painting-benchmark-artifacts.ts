import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Disk identity is captured before the journey/memory sampling window. This
// records the actual host bundle rather than inferring it from source files.
export function capturePaintingBenchmarkArtifacts(rendererRoot: string, activeVariant: 'serial' | 'threaded') {
  const fingerprint = (path: string) => {
    const bytes = readFileSync(path);
    return { path: relative(rendererRoot, path).replaceAll('\\', '/'), bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const assets: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) assets.push(path);
    }
  };
  visit(join(rendererRoot, 'assets'));
  const html = readdirSync(rendererRoot).filter(name => name.endsWith('.html') && statSync(join(rendererRoot, name)).isFile());
  if (html.length === 0 || assets.length === 0) throw new Error(`missing benchmark renderer artifacts: ${rendererRoot}`);
  return {
    rendererRoot, capturedAt: new Date().toISOString(),
    captureSemantics: 'SHA256 of actual disk HTML/assets and selected native files before journey and memory sampling',
    activeVariant,
    variantSelectionAuthority: 'benchmark runner scoped runtime gate; variant fixed for the whole host run',
    rendererFiles: [...html.map(name => join(rendererRoot, name)), ...assets].sort().map(fingerprint),
    nativeFiles: ['orca_slice.js', 'orca_slice.wasm', 'orca_slice.data']
      .map(name => fingerprint(join(rendererRoot, 'wasm', activeVariant, name))),
  };
}
