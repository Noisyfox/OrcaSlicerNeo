import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { manifest } from '../scripts/acquire.mjs';
import { prepareRuntime, stageRuntime } from '../scripts/stage.mjs';

test('stages the addon, complete pinned plugin directory and required certificate without stale resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'neo-bambu-stage-'));
  try {
    for (const [target, artifact] of Object.entries(manifest.artifacts)) {
      const source = join(directory, target);
      const pluginDirectory = join(source, 'plugin');
      const certificateDirectory = join(source, 'cert');
      const addonPath = join(source, 'bambu.node');
      const destination = join(directory, 'runtime');
      await mkdir(pluginDirectory, { recursive: true });
      await mkdir(certificateDirectory);
      await writeFile(addonPath, `addon-${target}`);
      await writeFile(join(source, 'fixture_plugin.dll'), 'must not ship');
      await writeFile(join(pluginDirectory, artifact.library), `plugin-${target}`);
      await writeFile(join(pluginDirectory, 'side-library'), 'dependency');
      await writeFile(join(pluginDirectory, 'neo-artifact.json'), JSON.stringify({ target, release: manifest.release, sha256: artifact.sha256 }));
      await writeFile(join(certificateDirectory, 'slicer_base64.cer'), 'certificate');
      await writeFile(join(certificateDirectory, 'printer.cer'), 'printer certificate');
      await stageRuntime({ target, addonPath, pluginDirectory, certificateDirectory, destination });
      assert.deepEqual((await readdir(destination)).sort(), ['bambu.node', 'cert', 'plugin']);
      assert.equal(await readFile(join(destination, 'bambu.node'), 'utf8'), `addon-${target}`);
      assert.equal(await readFile(join(destination, 'plugin', artifact.library), 'utf8'), `plugin-${target}`);
      assert.equal(await readFile(join(destination, 'plugin/side-library'), 'utf8'), 'dependency');
      assert.equal(await readFile(join(destination, 'cert/slicer_base64.cer'), 'utf8'), 'certificate');
      assert.equal(await readFile(join(destination, 'cert/printer.cer'), 'utf8'), 'printer certificate');
      assert.deepEqual((await readdir(join(destination, 'plugin'))).sort(), [artifact.library, 'neo-artifact.json', 'side-library'].sort());
      await writeFile(join(destination, 'obsolete'), 'old');
      await rm(join(certificateDirectory, 'printer.cer'));
      await assert.rejects(stageRuntime({ target, addonPath, pluginDirectory, certificateDirectory, destination }), /ENOENT/);
      await access(join(destination, 'obsolete')); // Missing required input cannot replace a valid tree.
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('refuses a packaging target that cannot use the host addon', async () => {
  await assert.rejects(prepareRuntime(process.arch === 'arm64' ? `${process.platform}-x64` : `${process.platform}-arm64`), /host/);
  await assert.rejects(stageRuntime({ target: 'unknown', destination: '/unused' }), /No pinned/);
});
