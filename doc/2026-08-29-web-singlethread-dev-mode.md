# Web single-thread development mode

The normal Web development server keeps COOP/COEP response headers enabled so
the threaded wasm64 runtime is exercised. To manually exercise the serial
single-thread runtime, run:

```text
pnpm --filter @orca/web dev:singlethread
```

The script invokes Vite with `--mode singlethread`. Vite loads the tracked
`apps/web/.env.singlethread` file, whose unprefixed `ORCA_WEB_NO_ISOLATION=1`
setting removes the isolation headers from both the development server and
preview server. The normal `dev` command and explicit `ORCA_WEB_NO_ISOLATION`
process-environment override retain their existing behavior. The matching
pre-script stages the normal WASM assets before Vite starts; no custom Node or
shell launcher is involved.
