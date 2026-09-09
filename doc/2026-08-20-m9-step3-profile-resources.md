# M9 Step 3 — portable profile resources and preferences

Step 3 moves profile delivery out of Emscripten preload data at the runtime
boundary. `@orca/profile-resources` deterministically partitions upstream's
`resources/profiles` tree into a core archive and one archive per top-level
vendor, emitting a versioned manifest. The Worker installs all packages into
the existing `/system` MEMFS layout before the first `orc_init()` call; core
failure blocks startup and vendor failure is logged and skipped.

The historical shared-app migration persisted selected profile names and UI
preferences. The current contract stores only Printer/Process names plus the
separate remembered multi-filament rack. Electron keeps its IPC transport, but
the legacy bridge AppConfig methods and single-filament compatibility surface
were removed before release; this note must not be used as an implementation
contract.
