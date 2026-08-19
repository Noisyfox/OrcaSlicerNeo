# M9 step 1 — platform contracts and Electron adapter

Date: 2026-08-19
Status: delivered

Step 1 of the Web–Electron migration defines the injected `PlatformCapabilities`
boundary for model import, G-code export, preferences, runtime, profiles, and
host chrome. The desktop renderer now obtains these capabilities from
`createElectronAdapter`; App, Toolbar, SettingsPanel, and TitleBar no longer
call `window.orca` directly. The adapter intentionally retains the existing
AppConfig IPC behavior and asset layout. Portable profile installation and the
shared preference schema remain step 3 work.

Verification target: desktop typecheck plus existing desktop unit/e2e tests;
the Electron preload API remains unchanged.
