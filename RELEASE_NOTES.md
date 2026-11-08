# Release notes

## Unreleased

- Added the `workgrid` CLI (`work-distribution-grid-cli`), a zero-dependency client for the HTTP application service covering board, people, workload, tasks, assignments, settings, and atomic idempotent bulk capture.
  - It renders tables on a terminal and JSON envelopes when piped or with `--json`.
  - Help is available at every level, mistyped commands get suggestions, and `doctor` checks setup.
  - It provides bash, zsh, and fish completions, and exit codes are stable.
  - Security:
    - Remote plaintext HTTP, redirects, and URL credentials are refused, and the token is accepted only from the environment.
    - Terminal escape and bidi sequences in board content are neutralized.
    - Responses and inputs are bounded, and destructive deletes require `--yes`.
- Added the `workgrid` Agent Skill for OpenAI Codex, GitHub Copilot, and Claude Code.
  - It ships inside the npm package and in `.agents/skills/workgrid/`.
  - `workgrid skill install|status|uninstall` manages it. Installs are atomic and refuse symbolic links, and a skill file the CLI did not write is replaced only with `--force`.
- Added CLI CI on Linux, macOS, and Windows with Node 22 and 24.
- Added a tag-driven GitHub Release for the CLI. Nothing is published to the npm registry.
  - Each release attaches an npm-installable `workgrid-cli.tgz`, a `SHA256SUMS` file, and a signed build-provenance attestation.
  - Releases are built only from `main` and run in the `release` environment.
  - Actions are pinned to commit SHAs, and Dependabot updates them after a 7-day cooldown.
  - The tarball is checked against an exact file allowlist, must have zero dependencies, and stays `private` so `npm publish` refuses it.
- Added the version 1 transport-neutral application-service contract used by the web API, MCP, and future clients.
- Added a local stdio MCP server with board/person/task resources, mutation tools, bounded messages, sanitized errors, and one-command startup.
- Web mutations now return a changed-entity reference and board revision in addition to the updated board.
- Added application-service and MCP protocol contract tests plus a standalone typecheck command.
- Added `backup.create/list/verify/restore/delete` to the shared application service and exposed them as MCP tools, reusing the existing CLI backup logic so recovery still works when the web app cannot start.
- Wired the command registry (`lib/commands.ts`) into the board UI: a searchable `⌘K` command palette, a shortcut-help dialog generated from the same registry, two-key sequence support with a cancelable timeout, keyboard person selection so focus assignment (`⌘1`/`⌘2`/`⌘3`/`⌘0`) works end-to-end, and per-browser configurable bindings (export/import/reset) with prototype-pollution-safe validation.
- Added bulk task capture: a distraction-free dialog (`B`, command palette, or the Bulk capture button) that parses a pasted list into previewable tasks and creates them atomically via new `tasks.parseBulk`/`tasks.createBulk` application-service methods, shared identically by web and MCP. Idempotency-keyed retries never duplicate tasks; drafts persist locally across accidental dismissal. Adds migration `0007_bulk_capture_idempotency.sql`.
- Fixed local database auto-discovery (used by the backup CLI's `create pre-migration` at container startup, and by the MCP server) to ignore Miniflare's own `metadata.sqlite` registry files. A long-lived data volume that had ever used the Cache API accumulated a second `metadata.sqlite` outside the D1 directory, which made discovery find 2–3 candidates instead of one and crash-loop the container on every subsequent restart. This shipped in `main` for a while before being caught by an actual restart against real data; the fix is regression-tested against a realistic multi-subsystem Miniflare layout, not just the single-database fixture the existing tests used.

Release checklist: run `npm run lint`, `npm run typecheck`, `npm run test:contracts`, `npm test`, and `npm audit --omit=dev`; verify MCP startup/shutdown against a migrated copy of local data; complete the documented backup/restore migration drill; and confirm Docker remains bound to `127.0.0.1`.
