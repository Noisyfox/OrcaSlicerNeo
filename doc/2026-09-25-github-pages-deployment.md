# GitHub Pages deployment

**Date:** 2026-09-25
**Status:** Implemented locally; first CI deployment pending

The public project site is published from `main` by the existing
`.github/workflows/ci.yml` workflow at
`https://noisyfox.github.io/OrcaSlicerNeo/`. The repository's default branch
is `main`; it has no `master` branch. GitHub Pages must use **GitHub Actions**
as its publishing source. The existing `wasm` job builds the threaded artifact
and now also builds the serial artifact. The Pages job downloads both from that
same run, packages profiles, builds the Web host, checks its subpath behavior,
and uploads `apps/web/dist`. The deploy job runs only for pushes to `main`.

GitHub Pages serves HTTPS but does not provide the COOP/COEP response headers
required by threaded WASM. The runtime therefore selects the existing serial
wasm64 fallback. Chrome 133 or later and WebGL 2 remain required.

`scripts/prepare-web-pages.mjs` removes debug WASM, source maps, and profiling
artifacts copied from the shared desktop public directory. It verifies the
HTML, profile manifest, and six production WASM files, adds `.nojekyll`, and
rejects a site over the 1 GB Pages limit. The ordinary Web build still carries
both variants for hosts that provide cross-origin isolation.

The repository's Pages source must be set to GitHub Actions once. Thereafter,
each push to `main` publishes the current site after the WASM job and Web
tests/typecheck pass.

The first CI run reached the existing Linux WASM builder and found that the
OCCT helper was invoked directly despite lacking an executable Git file mode.
The builder now invokes that helper through `bash`, like its other helpers.
The next run compiled WASM, then found that the bridge smoke requires the
profile manifest. The existing profile-pack job now uploads its output once;
the WASM smoke and Pages build download that same artifact.
