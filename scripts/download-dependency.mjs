// Shared build-time archive download for shell, cmd and Node dependency recipes.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

async function checksum(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

export async function downloadDependency(url, archive, {
  sha256, headers, attempts = 3, timeoutMs = 600_000, retryDelayMs = 1000,
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('attempts must be a positive integer');
  if (sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid SHA-256 digest');
  await mkdir(dirname(archive), { recursive: true });
  // Only reuse a cached archive when its pinned digest can be verified.
  if (sha256) {
    try { if (await checksum(archive) === sha256) return; } catch { /* cold cache */ }
  }
  const temporary = `${archive}.${process.pid}.${randomUUID()}.part`;
  for (let attempt = 1; attempt <= attempts; ++attempt) {
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const response = await fetch(url, { headers, signal });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      await pipeline(response.body, createWriteStream(temporary), { signal });
      if (sha256 && await checksum(temporary) !== sha256) throw new Error('Checksum mismatch');
      await rename(temporary, archive);
      return;
    } catch (error) {
      await rm(temporary, { force: true });
      const reason = [error.message, error.cause?.message].filter(Boolean).join(': ');
      if (attempt === attempts) throw new Error(`Download failed after ${attempt} attempts: ${url}: ${reason}`, { cause: error });
      console.warn(`[deps] Download attempt ${attempt} failed for ${url}: ${reason}; retrying`);
      await delay(attempt * retryDelayMs);
    }
  }
}

// Resolve argv through directory links used by the generated wasm32 scaffold.
if (process.argv[1] && await realpath(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try {
    const [url, archive, sha256, ...extra] = process.argv.slice(2);
    if (!url || !archive || extra.length) throw new Error('Usage: download-dependency.mjs URL ARCHIVE [SHA256]');
    await downloadDependency(url, archive, { sha256 });
  } catch (error) {
    console.error(`[deps] ${error.message}`);
    process.exitCode = 1;
  }
}
