import { _electron as electron } from '@playwright/test';
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MOCK_PROFILE_ACTIVATION } from '../../../packages/slicer-wasm/src/client/testing/mock-module';
import { fixtureProfileActivation } from '../../../packages/slicer-wasm/harness/profile-installer.mjs';

/** Explicit configured fixture state, shared by every ordinary Electron suite.
 * First-use tests opt out and exercise the unchanged production startup gate. */
export function configuredFixtureActivation(real: boolean) {
  if (!real) return structuredClone(MOCK_PROFILE_ACTIVATION);
  const profiles = resolve(__dirname, '../../../packages/slicer-wasm/cpp/resources/profiles');
  const nativePath = (path: string) => join(profiles, path.replace(/^\/(?:system|profiles)\/?/, ''));
  return fixtureProfileActivation({ FS: {
    readdir: (path: string) => path === '/system' ? [] : readdirSync(nativePath(path)),
    readFile: (path: string) => readFileSync(nativePath(path)), unlink() {}, symlink() {},
  } });
}
export const _electron = {
  async launch(options: NonNullable<Parameters<typeof electron.launch>[0]>) {
    const env = { ...options.env };
    if (env.ORCA_E2E === '1' && env.ORCA_E2E_FIRST_USE !== '1') {
      const path = env.ORCA_E2E_PREFERENCES || join(mkdtempSync(join(tmpdir(), 'orca-configured-e2e-')), 'preferences.json');
      const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, selectedProfiles: {}, ui: {} };
      if (!current.profileActivation) {
        current.profileActivation = configuredFixtureActivation(env.ORCA_E2E_REAL === '1');
        writeFileSync(path, JSON.stringify(current));
      }
      env.ORCA_E2E_PREFERENCES = path;
    }
    return electron.launch({ ...options, env });
  },
};
