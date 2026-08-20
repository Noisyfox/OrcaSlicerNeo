# M9 Step 8 — Electron shared runtime startup

Electron and the static Web host now enter the shared application through the
same startup gate. The UI remains inert while the worker initializes the WASM
module, installs the core and vendor profile packages, restores selections, and
loads metadata. A core/profile failure is shown on the shared startup screen;
vendor package failures continue to be logged and skipped according to the
profile contract.

Profile installation emits structured console events (`install-start`,
`fetch-complete`, `package-installed`, and `install-complete`) including package
counts, byte sizes, entry counts, and elapsed milliseconds. This makes a long
full-profile boot distinguishable from a stalled or missing package without
adding host-specific boot code.

Verification: slicer-app tests (39), slicer-runtime tests (16), and typechecks
for slicer-app, slicer-runtime, and desktop pass on 2026-08-20.
