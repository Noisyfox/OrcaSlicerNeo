import { desktopLaunchOptions } from './electron-fixture';
import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

test('packaged screen-color addon loads in the shipped Electron without test fixtures', () => {
  test.skip(!process.env.ORCA_E2E_PACKAGED_ROOT, 'Requires package:dir and ORCA_E2E_PACKAGED_ROOT');
  const executable = desktopLaunchOptions().executablePath!;
  const resources = process.platform === 'darwin' ? resolve(dirname(executable), '../Resources') : join(dirname(executable), 'resources');
  const directory = join(resources, 'screen-color');
  expect(readdirSync(directory)).toEqual(['screen_color.node']);
  const addon = join(directory, 'screen_color.node');
  expect(readFileSync(addon).includes(Buffer.from('completeFixture'))).toBe(false);
  // Run the installed binary's Node-API host, without a debugger or renderer.
  // Actual main/preload requests are covered by screen-color.e2e.ts.
  const result = spawnSync(executable, ['-e', `
    const binding = require(process.argv[1]);
    console.log(JSON.stringify({ apiVersion: binding.apiVersion, available: binding.available,
      fixture: typeof binding.completeFixture, start: typeof binding.start, cancel: typeof binding.cancel }));
  `, addon], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 15000 });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toEqual({ apiVersion: 1, available: true, fixture: 'undefined', start: 'function', cancel: 'function' });
});
