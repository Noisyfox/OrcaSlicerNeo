import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { downloadDependency } from './download-dependency.mjs';

const bytes = Buffer.from('complete dependency archive');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const options = { retryDelayMs: 1 };

async function fixture(t, handle) {
  const root = await mkdtemp(join(tmpdir(), 'orca-download-'));
  const archive = join(root, 'archive with spaces.zip');
  let requests = 0;
  const server = createServer((req, res) => handle(req, res, ++requests));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, archive, url: `http://127.0.0.1:${server.address().port}/source`, requests: () => requests };
}

test('retries HTTP errors and follows redirects before publishing a verified archive', async t => {
  const f = await fixture(t, (req, res, count) => {
    if (count === 1) res.writeHead(504).end('gateway error');
    else if (req.url === '/source') res.writeHead(302, { Location: '/archive' }).end();
    else res.end(bytes);
  });
  await downloadDependency(f.url, f.archive, { ...options, sha256 });
  assert.deepEqual(await readFile(f.archive), bytes);
  assert.equal(f.requests(), 3);
  await downloadDependency(f.url, f.archive, { ...options, sha256 });
  assert.equal(f.requests(), 3, 'verified cached archives need no request');
});

for (const failure of ['HTTP error', 'checksum mismatch', 'truncated body', 'timeout']) {
  test(`${failure} exhausts bounded retries, cleans partial files and preserves the old archive`, async t => {
    const f = await fixture(t, (_req, res) => {
      if (failure === 'HTTP error') res.writeHead(504).end('gateway error');
      if (failure === 'checksum mismatch') res.end('corrupt archive');
      if (failure === 'truncated body') {
        res.writeHead(200, { 'Content-Length': 100 });
        res.write('partial');
        setImmediate(() => res.destroy());
      }
      if (failure === 'timeout') { res.writeHead(200); res.write('partial'); }
    });
    await writeFile(f.archive, 'previous cache');
    await assert.rejects(downloadDependency(f.url, f.archive, {
      ...options, sha256, timeoutMs: failure === 'timeout' ? 100 : 2000,
    }), /Download failed after 3 attempts/);
    assert.equal(f.requests(), 3);
    assert.equal(await readFile(f.archive, 'utf8'), 'previous cache');
    assert.deepEqual(await readdir(f.root), ['archive with spaces.zip']);
  });
}

test('an unverified cache is replaced; a failed cold download leaves no archive', async t => {
  let fail = false;
  const f = await fixture(t, (_req, res) => fail ? res.writeHead(503).end() : res.end(bytes));
  await writeFile(f.archive, 'unverified cache');
  await downloadDependency(f.url, f.archive, options);
  assert.deepEqual(await readFile(f.archive), bytes);
  await rm(f.archive);
  fail = true;
  await assert.rejects(downloadDependency(f.url, f.archive, options), /HTTP 503/);
  assert.deepEqual(await readdir(f.root), []);
});

test('CLI accepts paths with spaces and exits nonzero on HTTP failures', async t => {
  let fail = false;
  const f = await fixture(t, (_req, res) => fail ? res.writeHead(504).end() : res.end(bytes));
  const cli = fileURLToPath(new URL('./download-dependency.mjs', import.meta.url));
  const run = promisify(execFile);
  await run(process.execPath, [cli, f.url, f.archive, sha256]);
  assert.deepEqual(await readFile(f.archive), bytes);
  fail = true;
  await assert.rejects(run(process.execPath, [cli, f.url, f.archive]), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Download failed after 3 attempts:.*HTTP 504/);
    return true;
  });
});
