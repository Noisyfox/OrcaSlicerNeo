# M9 Step 3 — portable profile resources and preferences

Step 3 moves profile delivery out of Emscripten preload data at the runtime
boundary. `@orca/profile-resources` deterministically partitions upstream's
`resources/profiles` tree into a core archive and one archive per top-level
vendor, emitting a versioned manifest. The Worker installs all packages into
the existing `/system` MEMFS layout before the first `orc_init()` call; core
failure blocks startup and vendor failure is logged and skipped.

The shared app now persists only versioned selected profile names and UI
preferences. Electron keeps its existing IPC transport during this migration,
but its file is now the small preferences document; legacy bridge AppConfig
methods remain only as compatibility surface for the accepted M4 harnesses.
