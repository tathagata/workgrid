# Release notes

## Unreleased

- Added the version 1 transport-neutral application-service contract used by the web API, MCP, and future clients.
- Added a local stdio MCP server with board/person/task resources, mutation tools, bounded messages, sanitized errors, and one-command startup.
- Web mutations now return a changed-entity reference and board revision in addition to the updated board.
- Added application-service and MCP protocol contract tests plus a standalone typecheck command.
- Added `backup.create/list/verify/restore/delete` to the shared application service and exposed them as MCP tools, reusing the existing CLI backup logic so recovery still works when the web app cannot start.

Release checklist: run `npm run lint`, `npm run typecheck`, `npm run test:contracts`, `npm test`, and `npm audit --omit=dev`; verify MCP startup/shutdown against a migrated copy of local data; complete the documented backup/restore migration drill; and confirm Docker remains bound to `127.0.0.1`.
