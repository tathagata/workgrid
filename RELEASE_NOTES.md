# Release notes

## Unreleased

- Added the version 1 transport-neutral application-service contract used by the web API, MCP, and future clients.
- Added a local stdio MCP server with board/person/task resources, mutation tools, bounded messages, sanitized errors, and one-command startup.
- Web mutations now return a changed-entity reference and board revision in addition to the updated board.
- Added application-service and MCP protocol contract tests plus a standalone typecheck command.
- Added `backup.create/list/verify/restore/delete` to the shared application service and exposed them as MCP tools, reusing the existing CLI backup logic so recovery still works when the web app cannot start.
- Wired the command registry (`lib/commands.ts`) into the board UI: a searchable `⌘K` command palette, a shortcut-help dialog generated from the same registry, two-key sequence support with a cancelable timeout, keyboard person selection so focus assignment (`⌘1`/`⌘2`/`⌘3`/`⌘0`) works end-to-end, and per-browser configurable bindings (export/import/reset) with prototype-pollution-safe validation.
- Added bulk task capture: a distraction-free dialog (`B`, command palette, or the Bulk capture button) that parses a pasted list into previewable tasks and creates them atomically via new `tasks.parseBulk`/`tasks.createBulk` application-service methods, shared identically by web and MCP. Idempotency-keyed retries never duplicate tasks; drafts persist locally across accidental dismissal. Adds migration `0007_bulk_capture_idempotency.sql`.

Release checklist: run `npm run lint`, `npm run typecheck`, `npm run test:contracts`, `npm test`, and `npm audit --omit=dev`; verify MCP startup/shutdown against a migrated copy of local data; complete the documented backup/restore migration drill; and confirm Docker remains bound to `127.0.0.1`.
