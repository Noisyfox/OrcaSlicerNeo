# E2E Primary Canvas Locator

Date: 2026-08-18  
Status: Implemented  
Scope: Electron e2e viewport assertions

## Problem

The desktop e2e tests selected the viewport's `canvas` element without a
qualifier. After the Drei performance statistics overlay was enabled, the
viewport also contained three 80×48 statistics canvases. Playwright therefore
reported a strict-mode violation when `boundingBox()` was called on the
locator.

## Fix

The tests now select the React Three Fiber canvas using its stable
`data-engine` attribute beginning with `three.js`. The statistics canvases remain available
for the overlay but cannot be mistaken for the main render surface.

## Verification

Run `pnpm --filter desktop test:e2e` from the repository root. The two affected
viewport tests should proceed past canvas lookup; the select-scroll regression
test remains covered in the same command.
