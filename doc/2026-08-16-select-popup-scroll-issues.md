# Select popup shifted up when the sidebar is scrolled

Date: 2026-08-16. Defect in the Base UI 1.7.0 Select wrapper, only visible in
a scrolled sidebar. The user report: "the select drop down (sparse infill
pattern option for example) doesn't work properly once the sidebar is scrolled
up"; clarified as: "when the sidebar is scrolled up, then the popup of the
select is shifted up as well, which wastes the bottom spaces".

## The bug — popup "shifted up", bottom space wasted

Symptom: with the sidebar scrolled, opening an option-field Select pinned the
popup to the trigger's **top** line — a short strip COVERING the trigger
("the popup of the select is shifted up as well [as the sidebar content]"),
with the viewport space below it empty ("wastes the bottom spaces"). Unscrolled
the same popup looked normal enough to be ignored.

Root cause: the app's `SelectContent` defaulted to `alignItemWithTrigger`
(Base UI's "native select" mode). In `SelectPopup.mjs` the align effect takes
the `isTopPositioned` branch whenever the list doesn't overflow
(`scrollTop = 0 >= maxScrollTop - 2` with `maxScrollTop = 0` for any list
shorter than the available space). That branch:

- collapses the positioner height to the list's natural height
  (`height = min(viewportHeight, positionerRect.height) - (scrollTop - maxScrollTop)`),
  and
- pins the top at `viewportHeight - idealHeight` ≈ the trigger's top.

The intended "fill the space below the trigger" height is discarded; the
popup becomes a content-height strip at the trigger's top, and the space
below it stays empty. Long lists take the bottom-anchored branch
(`positioner.style.bottom = '0'`) and fill correctly — which is why only
short enums (sparse_infill_pattern, and especially the 3-value mock) showed
it. Not fixed upstream: 1.7.0 is the latest `@base-ui/react`.

Fix: `alignItemWithTrigger` now defaults to `false` in
`apps/desktop/src/renderer/src/components/ui/select.tsx` — the standard
anchored dropdown, identical to the preset Comboboxes: hangs 4px below the
trigger, never covers it, and **tracks** the trigger on container scroll
(previously the align-mode popup was a fixed one-shot snapshot that detached
when the sidebar scrolled while open).

## Reverted: the modal-backdrop wheel-freeze fix

While reproducing, a second defect surfaced: with any option-field Select
open, the sidebar could not be wheel-scrolled. Root cause: `SelectRoot`
defaults `modal: true`, and `SelectPositioner` renders a full-viewport
`InternalBackdrop` (`position: fixed; inset: 0`, the topmost element over
the whole viewport) while a modal Select is open, so wheel events over the
sidebar hit it. A `modal={false}` default fixed it, but the user asked to
revert that fix — the sidebar-scroll behavior was explicitly **not** their
issue ("it's not about the side bar not scrollable") and the change was to
come back out. `select.tsx` is therefore back to the plain
`const Select = SelectPrimitive.Root` and the backdrop behavior is
unchanged: the sidebar is not wheel-scrollable while a Select popup is open.
Outside-click dismissal still works (the backdrop dismisses on click).

## Regression test

`apps/desktop/e2e/select-scroll.e2e.ts` (registered in `test:e2e` /
`test:e2e:real`), launches at 1280×600, injects scroll headroom (see lesson
below), scrolls sparse_infill_pattern to mid-list, and asserts the popup
opens **below** the trigger (`popup.top ≥ trigger.bottom`, sideOffset 4px)
and tracks it on sidebar scroll (gap stays ≈4px). The aside is scrolled
programmatically because the kept modal backdrop swallows wheel events.
Verified failing on the pre-fix build (popup top 399.9 vs trigger bottom
426.9 — covering it) and passing after.

## Lesson: two e2e false-failure traps

1. **Mock sidebar max-scroll clamp.** The mock settings panel almost fits at
   1280×600 (scrollHeight 569 vs clientHeight 496 → max scroll ≈ 73px), so a
   wheel near the bottom does nothing — looked like a scroll-revert bug, was
   just the clamp. The tests inject 700px above + 600px below the settings
   content so assertions have real headroom.
2. **Playwright click auto-scroll.** `locator.click()` scrolls the target
   into view when it is outside the viewport — it silently moved the trigger
   mid-list before opening, masking the "scrolled" state in probes. Open only
   triggers that are already fully visible, or scroll explicitly first.

Also: `locator.evaluate(fn, arg)` delivers the resolved DOM element as fn's
FIRST parameter (arg is the second) — destructuring the first param from the
arg shape silently makes every arg `undefined` (cost real debugging time
twice in this bug's investigation).
