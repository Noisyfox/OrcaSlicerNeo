# AGENTS.md Guidance Rationalization

Date: 2026-09-08
Status: Accepted

## Purpose

Keep `AGENTS.md` as a compact execution entry point for coding agents rather
than a second copy of the repository handbook. Duplicated architecture,
directory, command, and testing details drift when their authoritative
documents change.

## Accepted structure

`AGENTS.md` retains only guidance that must be visible while an agent is making
day-to-day decisions:

- project mission and non-negotiable architecture boundaries;
- the required reading order and authoritative-document map;
- branch, commit, package-manager, Windows, and reporting rules;
- high-risk path handling and bridge/runtime invariants;
- a short verification-policy summary; and
- the graph-first code exploration and review workflow.

## Referenced instead of duplicated

The following details are maintained only in their authoritative sources and
are linked from `AGENTS.md`:

| Detail | Authoritative source |
| --- | --- |
| Architecture, host responsibilities, and platform contracts | `spec/Web-Electron Shared Application Architecture.md` |
| Repository tree, ownership, engineering constraints, and documentation conventions | `project_structure_and_guidelines.md` |
| Current setup, build, development, smoke, and e2e commands | `README.md` and the platform driver's `help` output |
| WASM build recipes and troubleshooting | `doc/2026-08-12-wasm-build-notes.md` |
| Windows cmd build constraints | `doc/2026-08-15-cmd-build-pipeline.md` |
| DWARF debug builds | `doc/2026-08-20-wasm-dwarf-debug-build.md` |
| Verification levels, escalation triggers, and command matrix | `doc/2026-09-08-test-execution-strategy.md` |
| Roadmap and milestone completion | `doc/high_level_dev_plan.md` and `spec/Grand Plan.md` |

## Maintenance rule

When a referenced document changes, update its link or the short invariant in
`AGENTS.md` only if agent behavior changes. Do not copy expanded directory
trees, command catalogs, troubleshooting procedures, or test matrices back
into `AGENTS.md`.

## Verification

- `git diff --check`: passed
- changed local Markdown links: all resolved to existing workspace files
- retained rules: reviewed against their referenced authoritative sources
- product tests: not run because this change affects documentation only
