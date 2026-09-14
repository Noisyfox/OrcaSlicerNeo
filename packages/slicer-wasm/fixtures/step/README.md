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
