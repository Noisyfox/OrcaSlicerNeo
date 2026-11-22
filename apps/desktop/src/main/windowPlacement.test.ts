import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadWindowPlacement } from './windowPlacement';

const primary = { x: 0, y: 30, width: 1280, height: 770 };
const secondary = { x: -1440, y: 0, width: 1440, height: 900 };
let directory: string;
let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'neo-window-placement-'));
  path = join(directory, 'window-placement.json');
});
afterEach(() => rmSync(directory, { recursive: true }));

it('preserves a window spanning the secondary and primary displays', () => {
  const placement = { bounds: { x: -480, y: 50, width: 1600, height: 700 }, maximized: false };
  writeFileSync(path, JSON.stringify(placement));
  expect(loadWindowPlacement(path, [primary, secondary], primary)).toEqual(placement);
});

it('recovers a window from a disconnected display, fitting it to the current work area', () => {
  const placement = { bounds: { x: -1440, y: 0, width: 1440, height: 600 }, maximized: true };
  writeFileSync(path, JSON.stringify(placement));
  expect(loadWindowPlacement(path, [primary, secondary], primary)).toEqual(placement);
  expect(loadWindowPlacement(path, [primary], primary)).toEqual({
    bounds: { x: 0, y: 115, width: 1280, height: 600 }, maximized: true,
  });
});

it('uses the launch defaults for missing, malformed or invalid records', () => {
  expect(loadWindowPlacement(path, [primary], primary)).toBeUndefined();
  for (const raw of ['{', 'null', JSON.stringify({ bounds: primary, maximized: 'false' }),
    JSON.stringify({ bounds: { ...primary, width: -1 }, maximized: false })]) {
    writeFileSync(path, raw);
    expect(loadWindowPlacement(path, [primary], primary)).toBeUndefined();
  }
});
