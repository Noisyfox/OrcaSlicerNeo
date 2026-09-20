# Scoped configuration interoperability fixture

`scoped-config-interoperability.mjs` creates a temporary native BBS 3MF golden
from the real WASM bridge. It intentionally exercises the native locations used
by OrcaSlicer:

- Project configuration, including a recognized value that the initial Neo UI
  does not edit;
- two native Plate records. The interoperable per-plate assertion is limited to
  the values that survive a native reopen in this harness:
  `curr_bed_type`, `print_sequence`, and `spiral_mode`;
- one ModelObject configuration;
- a normal part, parameter modifier, negative volume, and support blocker; and
- `Metadata/layer_config_ranges.xml` as preserved inaccessible project data.

The archive is generated below the system temporary directory and is removed at
the end of the run. No binary fixture is checked in and no user project is
opened for write.

Run the self-contained native save/open and negative coverage through the named
package scripts:

```powershell
pnpm --filter @orca/slicer-wasm scoped-config-interoperability
pnpm --filter @orca/slicer-wasm scoped-config-interoperability:threaded
```

The normal Neo → OrcaSlicer → Neo stage requires a fixed OrcaSlicer archive
provided by the test operator; the harness never downloads, fabricates, or
modifies one. Provision it as follows:

1. Run the serial script once with `--keep-temp` and read the `golden_path`
   field from its final JSON line:

   ```powershell
   pnpm --filter @orca/slicer-wasm scoped-config-interoperability -- --keep-temp
   ```

2. Open that temporary `golden_path` in the pinned native core named by
   `manifest.json` (`Noisyfox/OrcaSlicer`, commit
   `b97ca3c0ace8cb04eb520d86417fbe13b7ddde`) and use OrcaSlicer **Save As** to
   create a separate fixed artifact, for example
   `C:\orca-step7\scoped-config-orca.3mf`. The source golden and this saved
   artifact are both disposable test inputs; neither is the Odyssey fixture.

3. Supply that path explicitly. `--require-orca` makes the stage strict: a
   missing path, unreadable archive, or failed native assertion exits non-zero.
   The source path is copied to a temporary path before opening, so it is never
   written in place:

```powershell
pnpm --filter @orca/slicer-wasm scoped-config-interoperability -- `
  --orca-project C:\orca-step7\scoped-config-orca.3mf `
  --require-orca
```

Repeat with the threaded script when validating the threaded module.

The test compares normalized native maps by object, volume, and plate display
order. It does not compare runtime IDs or ZIP/XML byte order. A genuinely
unknown project option is reported as an explicit compatibility fallback and
is not counted as a native round trip. The removed
`Metadata/orca_neo_config_overlay_v1.json` entry is checked on both open and
save.

The primary Odyssey project remains governed by the fixture-copy profile from
Step 1; this Step 7 harness accepts a separately provisioned Orca output and
never modifies its source path.
