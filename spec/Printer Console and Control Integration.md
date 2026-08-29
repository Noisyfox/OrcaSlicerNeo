# Printer Console and Control Integration

**Date:** 2026-08-30

**Status:** Approved

**Scope:** Final user experience for embedding a user's printer console and
controlling the printer from OrcaSlicerNeo.

The complete product experience is documented in
[Printer console and G-code control experience](../doc/2026-08-30-printer-console-and-control-ux.md).
That document is the single detailed record for this feature. This approved
spec intentionally does not duplicate implementation details, platform
contracts, security mechanics, or verification plans.

The feature has two user-visible outcomes:

- A top-level Device page displays a selected printer's Web console beside a
  manageable list of saved printer configurations.
- After slicing, Send uploads G-code and Send & Print uploads then starts a
  print through the configured Moonraker API.

Electron can reuse a configured Moonraker API key in the embedded console.
Web displays the console in an iframe and uses the key only for the
application's direct printer API operations. Console embedding and direct
printer control are independent and both remain best effort on the Web.
