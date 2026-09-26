# Project lifecycle E2E import wait

**Date:** 2026-09-26
**Status:** Pull-request validation

The mock Electron E2E that checks close confirmation intermittently failed
after opening a project through the File menu. Its import helper waited for
the Save Project As menu item to be attached, although opening the project
closes that menu. A hosted run showed the imported `picked-project.3mf` object
already present while the menu item was absent.

Wait for the imported object row to become visible before continuing with
close-confirmation assertions. This directly proves the operation required by
the test and does not depend on menu animation timing.
