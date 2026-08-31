// apps/desktop/e2e/select-scroll.e2e.ts — regression: a Select popup must not
// open "shifted up" covering the trigger once the sidebar is scrolled. The
// bug is in the app's Base UI 1.7.0 Select wrapper and only shows in the
// scrolled state.
//
// The reported symptom ("the popup of the select is shifted up as well, which
// wastes the bottom spaces"): Base UI 1.7.0's `alignItemWithTrigger` ("native
// select") mode is broken for short lists. SelectPopup's align effect takes
// the `isTopPositioned` branch whenever the list doesn't overflow
// (`scrollTop=0 >= maxScrollTop-2` with `maxScrollTop=0`), which collapses
// the positioner height to the list's natural height and pins the popup at
// the trigger's TOP line — a short strip COVERING the trigger, with the
// viewport space below it empty. Long lists take the bottom-anchored branch
// and fill correctly, which is why only short enums (e.g.
// sparse_infill_pattern in the mock) show it. Fix: `alignItemWithTrigger`
// defaults to false → the standard anchored dropdown (same as the preset
// Comboboxes): hangs 4px below the trigger and tracks it on container scroll.
//
// Note: the modal-backdrop wheel freeze (the sidebar not wheel-scrolling
// while a Select popup is open, from SelectRoot's `modal: true` default) was
// intentionally left as-is — a `modal={false}` fix existed but was reverted
// at the user's request. The tracking assertion below therefore scrolls the
// aside programmatically; wheel events over the sidebar are swallowed by the
// backdrop by design.
import { _electron, expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');
const MODEL_PATH = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/cube.stl');
const REAL = process.env.ORCA_E2E_REAL === '1';
const PRESET_READY_TIMEOUT = REAL ? 300_000 : 30_000;

async function launchApp() {
  const exportPath = resolve(DESKTOP_ROOT, 'e2e/out/select-scroll-out.gcode');
  const env = {
    ...process.env,
    ORCA_E2E: '1',
    ORCA_E2E_MODEL: MODEL_PATH,
    ORCA_E2E_EXPORT: exportPath,
    ORCA_E2E_PRINTER: 'Creality Ender-3 0.4 nozzle',
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  const page = await app.firstWindow();
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: PRESET_READY_TIMEOUT });
  await page.locator('#app-tab-prepare').click();
  // Short viewport so the sidebar actually scrolls (at 1280x800 its content
  // fits and nothing can be scrolled — the bug only shows in a scrolled
  // sidebar).
  await page.setViewportSize({ width: 1280, height: 600 });
  await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: PRESET_READY_TIMEOUT });
  return { app, page };
}

// Give the sidebar real scroll headroom and scroll a real enum row to mid-list.
// The compact mock calls this sparse_infill_pattern, while profile revisions
// may rename or omit that option; selecting the first actual process enum
// keeps the layout test tied to rendered controls rather than a fixture key.
// The scroll container is the aside's inner overflow-y-auto div — the aside
// itself is overflow-hidden so its border-radius clips the custom scrollbar
// to the card's rounded corners (see AppShell.tsx).
async function scrollRowToMidlist(page: Page) {
  const aside = page.locator('#app-panel-workspace aside');
  const scroller = aside.locator(':scope > div');
  // The real preset panel already has genuine scrollable content. Synthetic
  // spacer nodes are retained only for the compact mock fixture; injecting
  // nodes into the real React-owned scroll tree can invalidate Base UI's
  // anchor observer while the popup is opening.
  if (!REAL) {
    await scroller.evaluate((el) => {
      const mk = (h: number) => {
        const d = document.createElement('div');
        d.style.height = `${h}px`;
        return d;
      };
      el.insertBefore(mk(700), el.firstChild);
      el.appendChild(mk(600));
    });
  }
  await scroller.evaluate((el) => {
    const triggers = el.querySelectorAll('[data-slot="select-trigger"]');
    const trigger = triggers.item(triggers.length - 1);
    const row = trigger?.closest('div.space-y-4, div.flex');
    if (!row) throw new Error('real enum row not found');
    const rowTopInScroller = row.getBoundingClientRect().top - el.getBoundingClientRect().top;
    const target = Math.min(el.scrollHeight - el.clientHeight, Math.max(0, rowTopInScroller + el.scrollTop - 300));
    el.scrollTop = target;
  });
  await expect.poll(async () => (await scroller.evaluate((el) => el.scrollTop)) > 0).toBe(true);
  return { aside, scroller };
}

const sparseTrigger = (page: Page) => page.locator('#app-panel-workspace aside [data-slot="select-trigger"]').last();

test('select popup opens below the trigger and tracks it on sidebar scroll', async () => {
  const { app, page } = await launchApp();
  try {
    const { aside, scroller } = await scrollRowToMidlist(page);
    const trigger = sparseTrigger(page);
    const popup = page.locator('[data-slot="select-content"]');

    await trigger.click();
    await expect(popup).toBeVisible();

    // The popup must hang BELOW the trigger (sideOffset 4px), never covering
    // it — pre-fix (alignItemWithTrigger) it pinned to the trigger's top line
    // ("shifted up", the space below empty).
    const triggerBox = (await trigger.boundingBox())!;
    const popupBox = (await popup.boundingBox())!;
    expect(popupBox.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height - 1);

    // Scroll the sidebar while the popup is open (programmatically — the kept
    // modal backdrop swallows wheel events, see the header): the popup must
    // TRACK the trigger — the gap between trigger bottom and popup top stays
    // ≈4px while the scroller scrolls (pre-fix the align-mode popup was a
    // fixed one-shot snapshot that detached, drifting away from the trigger
    // by the scroll amount).
    const before = await scroller.evaluate((el) => el.scrollTop);
    await scroller.evaluate((el) => {
      el.scrollTop = Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + 120);
    });
    await expect
      .poll(async () => await scroller.evaluate((el) => el.scrollTop), { timeout: 5_000 })
      .toBeGreaterThan(before);

    await expect
      .poll(async () => {
        const t = (await trigger.boundingBox())!;
        const p = (await popup.boundingBox())!;
        return p.y - (t.y + t.height);
      }, { timeout: 5_000 })
      .toBeLessThan(12);

    // Still usable: picking an item closes the popup.
    await popup.locator('[data-slot="select-item"]').nth(1).click();
    await expect(popup).not.toBeVisible();
  } finally {
    await app.close();
  }
});
