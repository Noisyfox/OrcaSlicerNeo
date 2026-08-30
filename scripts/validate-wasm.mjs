// Validate a finished WebAssembly module before it becomes a reusable build
// output. Emscripten can leave partial .js/.wasm files behind when a link-time
// Binaryen pass fails; Ninja then sees its declared .js output and may decide
// that there is no work to do on the next invocation.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export async function assertValidWasm(path) {
  const bytes = await readFile(path);
  try {
    await WebAssembly.compile(bytes);
  } catch (error) {
    throw new Error(`invalid WebAssembly artifact ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error('usage: node scripts/validate-wasm.mjs <module.wasm> [...]');
    process.exitCode = 2;
  } else {
    for (const path of paths) {
      try {
        await assertValidWasm(path);
        console.log(`[validate-wasm] valid ${path}`);
      } catch (error) {
        console.error(`[validate-wasm] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    }
  }
}
