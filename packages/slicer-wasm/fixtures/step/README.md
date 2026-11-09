# STEP bridge fixtures

`step-box-20mm.step` is the compact 20 mm cube fixture used by the native
bridge harness. It was copied from the `cube.step` test asset in
[CNCKitchen/meshStep](https://github.com/CNCKitchen/meshStep/blob/a1a2841633bdb56a54cb91235800d87124af4091/cube.step),
whose repository and fixture are distributed under AGPL-3.0. The upstream file identifies its
generator as ST-Developer and declares millimetre units. The product label was
normalized from `(Unsaved)` to `Body1` so the bridge can assert native volume
naming; geometry and units are unchanged. The repository's AGPL-3.0 `LICENSE.txt`
applies to the fixture distribution in this tree.

`malformed.step` is an original, intentionally truncated ISO-10303 header
written for this repository's rejection/atomicity test. It contains no
copyrightable geometry and is released under the repository's AGPL-3.0 terms.

The harness also reads the pinned Orca submodule's existing fixtures directly:

- [cone_tilted_seam_pcurve.step](../../cpp/tests/data/cone_tilted_seam_pcurve.step)
  checks that the curved seam produces a closed indexed mesh.
- [surface_model_geometric_set.step](../../cpp/tests/data/surface_model_geometric_set.step)
  checks that both loose square faces survive triangulation in one part.
- [utf8_part_names.step](../../cpp/tests/data/utf8_part_names.step) checks all
  three part names and closed box meshes. An in-memory variant replaces the
  solid representation wrappers with shell-based surface representations to
  cover named shells without duplicating geometry files.

These checks follow [the upstream STEP tests](../../cpp/tests/libslic3r/test_step.cpp)
and add bridge geometry-buffer assertions. The bridge keeps compounds atomic;
the native tests own the optional split-compound path. The same harness accepts
serial and threaded WASM artifacts; passing one does not qualify the other.
