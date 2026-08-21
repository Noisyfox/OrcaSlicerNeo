// packages/slicer-runtime/src/slicer/errors.ts
// User-facing slicer error text. Bridge errors arrive as plain strings
// ({"error": "..."}); Toolbar wraps failures in Error for its control flow,
// and String(err) on an Error yields "Error: <msg>" — but the status bar
// already prefixes "Error", so the wrapper must be unwrapped before the
// text is stored (regression: status bar showed "Error Error: Errors").
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
