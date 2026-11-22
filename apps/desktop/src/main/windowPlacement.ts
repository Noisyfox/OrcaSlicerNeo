import type { BrowserWindow, Rectangle } from 'electron';
import { readFileSync } from 'node:fs';
import { writeFileAtomically } from './atomicFile';

interface WindowPlacement {
  bounds: Rectangle;
  maximized: boolean;
}

function isValidBounds(bounds: unknown): bounds is Rectangle {
  if (!bounds || typeof bounds !== 'object') return false;
  const { x, y, width, height } = bounds as Rectangle;
  // Electron accepts signed 32-bit integers for native window bounds.
  return [x, y, width, height].every(n => Number.isInteger(n) && n >= -0x80000000 && n <= 0x7fffffff)
    && width > 0 && height > 0;
}

export function loadWindowPlacement(path: string, workAreas: Rectangle[], primary: Rectangle): WindowPlacement | undefined {
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    if (!isValidBounds(saved?.bounds) || typeof saved.maximized !== 'boolean') return;
    const { x, y, width, height } = saved.bounds;
    // Preserve intentional overhang and windows spanning multiple displays if
    // enough of the title bar is still accessible to drag the window.
    const reachable = workAreas.some(area => y >= area.y
      && y + Math.min(32, height) <= area.y + area.height
      && Math.min(x + width, area.x + area.width) - Math.max(x, area.x) >= Math.min(96, width));
    if (reachable) return { bounds: { x, y, width, height }, maximized: saved.maximized };

    const fittedWidth = Math.min(width, primary.width);
    const fittedHeight = Math.min(height, primary.height);
    return {
      bounds: {
        x: primary.x + Math.floor((primary.width - fittedWidth) / 2),
        y: primary.y + Math.floor((primary.height - fittedHeight) / 2),
        width: fittedWidth,
        height: fittedHeight,
      },
      maximized: saved.maximized,
    };
  } catch {
    // A missing or unreadable placement uses Electron's normal first launch.
    return undefined;
  }
}

export async function saveWindowPlacement(path: string, win: BrowserWindow): Promise<void> {
  try {
    const bounds = win.getNormalBounds();
    if (!isValidBounds(bounds)) return;
    const placement: WindowPlacement = { bounds, maximized: win.isMaximized() };
    await writeFileAtomically(path, Buffer.from(JSON.stringify(placement)));
  } catch (error) {
    console.warn('Could not save main window placement', error);
  }
}
