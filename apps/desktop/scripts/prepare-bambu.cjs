// electron-builder supplies the target before collecting extraResources.
const { Arch } = require('electron-builder');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');
module.exports = async context => {
  const { prepareRuntime } = await import(pathToFileURL(resolve(__dirname, '../../../packages/bambu-native/scripts/stage.mjs')).href);
  await prepareRuntime(`${context.electronPlatformName}-${Arch[context.arch]}`);
};
