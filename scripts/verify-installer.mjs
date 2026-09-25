// Guard the CI packaging matrix: each job must produce exactly one installer
// for its requested architecture before it uploads an artifact.
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const expectedSuffix = process.argv[2];
if (!expectedSuffix || !/^-(?:win|linux|mac)-(?:x64|x86_64|arm64)\.(?:exe|AppImage|dmg)$/.test(expectedSuffix)) {
  throw new Error('usage: node scripts/verify-installer.mjs -<os>-<arch>.<extension>');
}

const releaseDir = resolve('apps/desktop/release');
const extension = expectedSuffix.slice(expectedSuffix.lastIndexOf('.'));
const installers = (await readdir(releaseDir)).filter((name) => name.endsWith(extension));
if (installers.length !== 1 || !installers[0].startsWith('OrcaSlicerNeo-') || !installers[0].endsWith(expectedSuffix)) {
  throw new Error(`expected one *${expectedSuffix} installer in ${releaseDir}; found: ${installers.join(', ') || '(none)'}`);
}
console.log(`verified installer: ${installers[0]}`);
