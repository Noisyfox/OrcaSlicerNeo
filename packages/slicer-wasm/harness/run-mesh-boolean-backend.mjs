// Execute the synchronous backend suite inside a Node or browser Worker.
// Usage: node harness/run-mesh-boolean-backend.mjs <module.mjs> [--browser]
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

async function run(create) {
  const output = [];
  const record = (line, stderr = false) => {
    output.push(line);
    if (stderr || line.startsWith('{"kind":')) parentPort.postMessage({ progress: line, stderr });
  };
  parentPort.postMessage({ progress: '[mesh-boolean-backend] Initializing Node module' });
  const module = await create({ print: record, printErr: line => record(line, true) });
  const code = module._neo_test_mesh_boolean();
  return { code, shared: module.HEAPU8.buffer instanceof SharedArrayBuffer, output };
}
if (!isMainThread) {
  try {
    parentPort.postMessage({ progress: '[mesh-boolean-backend] Importing Node module' });
    const { default: create } = await import(workerData);
    parentPort.postMessage(await run(create));
  } catch (error) { parentPort.postMessage({ error: String(error), code: -1 }); }
} else {
  const path = resolve(process.argv[2]);
  const threaded = /threaded/.test(path);
  const check = (result, host) => {
    if (result.code !== 0) console.error({ ...result, output: result.output?.slice(-20) });
    assert.equal(result.code, 0, `${host}: numerical/wrapper suite failed`);
    assert.equal(result.shared, threaded, `${host}: unexpected heap sharing`);
    assert.ok(result.output.some(line => line.includes('"kind":"mesh-boolean-backend","passed":true')));
    console.log(JSON.stringify({ host, module: path, passed: true, shared: result.shared, nestedWorkers: result.nestedWorkers }));
  };
  const worker = new Worker(new URL(import.meta.url), { workerData: pathToFileURL(path).href });
  try {
    const result = await new Promise((resolveResult, reject) => {
      worker.on('message', result => {
        if (typeof result.progress === 'string') {
          if (result.stderr) console.error('[node-worker stderr]', result.progress);
          else console.log(result.progress);
        } else resolveResult(result);
      });
      worker.once('error', reject);
      worker.once('exit', code => reject(new Error(`Test Worker exited before reporting (${code})`)));
      setTimeout(() => reject(new Error('Backend test timed out')), 120_000).unref();
    });
    check(result, 'node-worker');
  } finally { await worker.terminate(); }

  if (process.argv.includes('--browser')) {
    const browserWorker = `
      const output=[]; let nestedWorkers=0;
      const record=(s,stderr=false)=>{output.push(s); if(stderr) console.error('[mesh-boolean-backend stderr]',s); else if(s.startsWith('{"kind":')) console.log(s)};
      if(globalThis.Worker) globalThis.Worker=new Proxy(globalThis.Worker,{construct(t,a,n){nestedWorkers++; return Reflect.construct(t,a,n)}});
      try {
        console.log('[mesh-boolean-backend] Importing browser module');
        const {default:create}=await import('./${basename(path)}');
        console.log('[mesh-boolean-backend] Initializing browser module');
        const m=await create({print:record,printErr:s=>record(s,true)});
        const code=m._neo_test_mesh_boolean();
        postMessage({code,output,nestedWorkers,shared:typeof SharedArrayBuffer!=='undefined' && m.HEAPU8.buffer instanceof SharedArrayBuffer,crossOriginIsolated,sharedArrayBufferAvailable:typeof SharedArrayBuffer!=='undefined'});
      } catch(e){postMessage({code:-1,error:String(e),output,nestedWorkers})}`;
    const server = createServer(async (req, res) => {
      try {
        if (threaded) {
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
          res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        }
        const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(1));
        if (!name) { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Mesh Boolean backend</title>'); return; }
        if (name === 'worker.mjs') { res.setHeader('Content-Type', 'text/javascript'); res.end(browserWorker); return; }
        if (basename(name) !== name) throw new Error('Invalid path');
        res.setHeader('Content-Type', extname(name) === '.wasm' ? 'application/wasm' : 'text/javascript');
        res.end(await readFile(join(dirname(path), name)));
      } catch (error) { res.statusCode = 404; res.end(String(error)); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const require = createRequire(new URL('../../../apps/desktop/package.json', import.meta.url));
    const { chromium } = require('@playwright/test');
    let browser;
    try {
      browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
      const page = await browser.newPage();
      page.on('console', message => {
        const text = message.text();
        if (text.startsWith('[mesh-boolean-backend stderr]')) console.error('[browser]', text);
        else if (text.startsWith('{"kind":') || text.startsWith('[mesh-boolean-backend]'))
          console.log('[browser]', text);
      });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const result = await page.evaluate(() => new Promise((resolveResult, reject) => {
        const worker = new Worker('/worker.mjs', { type: 'module' });
        const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Browser backend timed out')); }, 120_000);
        worker.onmessage = event => { clearTimeout(timeout); worker.terminate(); resolveResult(event.data); };
        worker.onerror = event => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message)); };
      }));
      check(result, 'browser-worker');
      assert.equal(result.crossOriginIsolated, threaded);
      if (!threaded) {
        assert.equal(result.sharedArrayBufferAvailable, false, 'Serial qualification requires a browser without SharedArrayBuffer');
        assert.equal(result.nestedWorkers, 0, 'Serial backend created an internal Worker');
      }
    } finally { await browser?.close(); await new Promise(r => server.close(r)); }
  }
}
