import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
if (!process.argv[2]) throw new Error('usage: node system-filament-activation-native.mjs <standalone-test-module.js>');
const factory = await loadModuleFactory(resolve(process.argv[2]));
const module = await factory({ noInitialRun: true, print: console.log, printErr: console.error });
const result = module.callMain([]);
if (result !== 0) throw new Error(`native rule cases failed: ${result}`);
