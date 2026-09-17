# Workgrid application API v1

The application service is Workgrid's authoritative interface. Web, MCP, and future TUI adapters validate their transport envelopes and call the same `BoardService`; transport code must not contain SQL or business rules.

## Compatibility

Every board response includes `apiVersion: 1`, a stable `revision`, and an ISO-8601 `savedAt`. Additive optional DTO fields and new commands are backward compatible. Removing or changing a field, enum value, invariant, or error meaning requires a new major API version. Clients must ignore unknown response fields.

Stable IDs are opaque strings. Arrays are returned in their persisted deterministic order. Focus is one of `primary`, `secondary`, or `tertiary`. Workflow DTOs may expose `unfocused`, `focused`, or `archived`; legacy installations expose `status` until the workflow migration is installed.

Errors use `{ code, message, field?, details? }`. Codes are `INVALID_INPUT`, `NOT_FOUND`, `CONFLICT`, `FORBIDDEN_STATE`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED`, and `INTERNAL`. Messages never contain stack traces, local paths, SQL, or database details.

## Queries and commands

- `board.get` returns the complete board.
- `people.create`, `people.update`, and `people.delete` mutate people.
- `people.reorder` accepts `{ personId, beforePersonId?, afterPersonId?, position?: "first" | "last", expectedRevision? }`. Exactly one anchor or position is required. IDs, rather than array indexes, make the command stable across web, MCP, and future TUI clients. A stale `expectedRevision` returns `CONFLICT`.
- `tasks.create`, `tasks.update`, `tasks.delete`, and `tasks.setWorkflowState` mutate tasks.
- `assignments.assign` creates or changes focus; `assignments.unassign` removes it. Assigning a primary replaces the existing primary atomically.
- `tasks.reorder` accepts `{ taskId, state, beforeTaskId?, afterTaskId?, position?: "first" | "last", expectedRevision? }`. Exactly one same-list anchor or boundary is required; filtered clients must clear their filter before reordering. New tasks and workflow transitions append to their destination list.
- `settings.updateFocus` accepts `{ overfocusThreshold, expectedRevision? }` to tune focus assessment; see [Task focus assessment](#task-focus-assessment).
- `backup.create/list/verify/restore/delete` manage local database backups; see [Backups](#backups).

## Task lifecycle

Every task has a `workflow: { state, outcome?, changedAt }`. `state` is `unfocused`, `focused`, or `archived`; legacy installations expose `status` until migration `0001_task_workflow.sql` runs, which maps every prior status deterministically without inventing an outcome. `tasks.setWorkflowState` (`archiveTask`/`restoreTask` internally) moves a task to `archived` with an optional terminal `outcome` of `completed`, `cancelled`, or `superseded`, or restores it back to an active list. Restoring always clears `outcome`. Archived tasks are immutable to assignment changes: `assignments.assign`/`unassign` reject an archived `taskId` with `FORBIDDEN_STATE` until the task is restored. `expectedRevision` on either command returns `CONFLICT` against a stale board revision. Archiving or restoring appends the task to the end of its destination workflow list; use `tasks.reorder` afterward to reposition it.

## Task focus assessment

Every non-archived task in `board.get` carries a derived `focusAssessment: { version, state, primaryCount, secondaryCount, tertiaryCount, weightedLoad, threshold }`; archived tasks report `focusAssessment: null`. `state` is `unfocused` (no primary owner), `focused`, or `overfocused` when `weightedLoad` exceeds the configured `threshold`. Weighted load sums assignments as primary `1`, secondary `0.5`, and tertiary `0.25` — the same weights `people.loads` uses for person load, published once in `board.settings.weights` so clients never duplicate them. `settings.updateFocus { overfocusThreshold, expectedRevision? }` changes the threshold within `[0.25, 100]`; `settings.get` (or `board.get().settings`) reads the current `focusAssessmentVersion`, `overfocusThreshold`, and `weights`. Changing threshold semantics requires a new `focusAssessmentVersion`.

## Backups

Backups are transport-neutral: `backup.create({ reason })`, `backup.list()`, `backup.verify({ backupId })`, `backup.restore({ backupId, confirmation, expectedCurrentRevision? })`, and `backup.delete({ backupId })` share one implementation (`scripts/backup-manager.mjs`, invoked identically by the CLI and by MCP) so recovery still works when the web app cannot start. Backups are identified only by an opaque ID matching `BACKUP_ID_PATTERN`; no transport accepts filesystem paths.

A backup is not considered successful until its checksum and schema fingerprint are re-verified after the atomic write. Restore requires `confirmation` to equal exactly `RESTORE:<backupId>`, always takes a `pre-restore` safety backup first, and refuses to proceed if `expectedCurrentRevision` no longer matches the live database (`CONFLICT`). `delete` refuses to remove the last known-good backup (`FORBIDDEN_STATE`). Retention keeps a bounded number of daily/weekly generations plus the newest backup and never deletes the only remaining one. The container entrypoint takes a `pre-migration` backup and runs a post-migration integrity check before starting the app; a scheduled backup runs on a configurable interval. See the README for backup location, schedule, retention, and disaster-recovery procedures.

## Canonical people order

`people` is always returned in canonical persisted order. `sort_order` is an internal contiguous zero-based representation and is not a public mutation contract. Migration `0002_people_ordering.sql` repairs duplicate or gapped legacy values deterministically using the prior order, creation time, and ID. A reorder rewrites only ordering values in one transaction; person fields, timestamps, assignments, and task data are unchanged. Filtering or alternate client-side views must never persist their display order unless the user explicitly invokes `people.reorder`.

Every mutation advances the opaque board revision. Clients should read the latest revision, pass it as `expectedRevision`, and refresh after a conflict. Exports include the canonical people collection and revision, so import, backup, and restore paths preserve the same order.

Tasks are returned grouped by workflow (`unfocused`, `focused`, `archived`) and then by persisted `sortOrder`, `createdAt`, and `id`. Public mutations use opaque anchors rather than array indexes. Migration `0004_task_ordering.sql` backfills the prior newest-first display order without deleting tasks. Reordering changes only `sortOrder`; primary-owner or lifecycle changes place a task last in the destination workflow list.

Mutation results contain the updated board, its revision, and a `changed` entity reference. Payload limits are 16 KiB over HTTP and 64 KiB per MCP protocol message. Text, ID, color, and enum limits are defined once in `lib/domain/contracts.ts` and enforced again by `BoardService` invariants.

## Task colors

`appearance.get` returns `taskPalette` and `paletteVersion`. HTTP clients use `GET /api/board?appearance=1`; MCP clients may call the `appearance.get` tool or read `workgrid://appearance`. Clients should render the returned `value` and `foreground` instead of maintaining their own palette.

`tasks.create` accepts an optional `colorId`, an optional six-digit hex `color`, or both when they agree. If both are omitted, the service selects the least-used palette color among non-archived tasks; ties follow the published palette order. `tasks.update` preserves the existing color when both fields are omitted. Known colors are returned with stable `colorId`; preserved legacy/custom hex values are returned with `colorId: null`. Palette IDs, not hex values, are the stable identity. No workflow behavior depends on a color.

## People colors

`appearance.get` also returns at least twelve entries in `peoplePalette`, using the same `paletteVersion` compatibility marker. `people.create` and `people.update` accept `colorId` and/or a six-digit hex `color` under the same agreement rule as task colors. If create omits both, the application service selects the least-used people color; ties follow published palette order. Update preserves the existing value when both are omitted. This makes web, MCP, exports, and future TUI clients consistent without duplicating allocation logic.

Known colors are returned as `{ colorId, color }`. Legacy/custom hex values are preserved with `colorId: null`; arbitrary CSS expressions are never accepted. The complete board export includes each person's color identity and `appearance.paletteVersion`, and database backups preserve both `color` and `color_id`. Color is presentation metadata only: it never changes ordering, assignment, focus, workflow, or load calculations, and clients must continue to show a person's name or initials rather than relying on color alone.

## Person load metrics

The application service, not an individual UI, calculates person load. Every person in `board.get` has a derived `load` object with `calculationVersion`, raw `counts` by focus, `activeAssignmentCount`, weighted `score`, and semantic `state`. The board also publishes the complete `workload` policy so web, MCP, exports, and future TUI clients can explain a result without reimplementing it.

Calculation version 1 weights primary assignments as `1`, secondary as `0.5`, and tertiary as `0.25`. Archived task assignments are retained for history but excluded. A score below `1` is `low`, from `1` through `2.5` inclusive is `balanced`, and above `2.5` is `overloaded`. Thresholds and weights may be configured when constructing the application service; changing their semantics requires a new calculation version.

`people.loads { state?, sort? }` returns the policy and load projection. `state` is `low`, `balanced`, or `overloaded`; `sort` is `canonical`, `highest`, or `lowest`. These are read-only projections. They never write `sortOrder` or change the canonical order returned by `people.list`. Visual clients must pair color with a text/icon label and expose the numeric score and raw counts to assistive technology.

## MCP

The MCP server is stdio-only and discovers the single D1 SQLite file beneath the project's fixed `.wrangler/state` directory. It accepts no database path, raw SQL, backup destination, or network configuration; backups it creates are written beneath that same fixed directory (`.wrangler/state/workgrid-backups`), never to a client-supplied path. Start the web app once to initialize the database, stop it to avoid concurrent SQLite processes, then run:

```bash
npm run mcp
```

Example client configuration:

```json
{
  "mcpServers": {
    "workgrid": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/absolute/path/to/workgrid"
    }
  }
}
```

Resources are `workgrid://board`, `workgrid://people/{id}`, and `workgrid://tasks/{id}`. Every mutation is an MCP tool. Example arguments for `assignments.assign` are `{ "payload": { "taskId": "...", "personId": "...", "focus": "primary" } }`.

`backup.create`, `backup.list`, `backup.verify`, `backup.restore`, and `backup.delete` are also MCP tools, backed by the same `scripts/backup-manager.mjs` logic the CLI and container entrypoint use. Example arguments for `backup.restore` are `{ "backupId": "...", "confirmation": "RESTORE:<backupId>" }`; the confirmation string must match exactly. A tool result whose value is a list wraps the array as `{ "items": [...] }` in `structuredContent` (the `content` text is always the raw JSON).

## Client commands

`lib/commands.ts` defines every user-invokable command as a stable `{ id, label, group, help, defaultBindings, available(context), serviceAction? }` record; `COMMAND_CAPABILITY_MANIFEST` exports the ID, label, group, help text, and `serviceAction` (the `BoardCommand.action` it invokes, when it invokes one) for every command, so a TUI client can build an equivalent command surface without duplicating the web UI's key-handling code. Key bindings (`defaultBindings`, and any per-client override) are UI-only metadata — they are never sent to the application service and carry no API semantics. `available(context)` is a pure function of `{ hasTask, hasPerson, taskArchived, canMoveTaskUp, canMoveTaskDown, canMovePersonUp, canMovePersonDown, hasAssignment, searchActive }`, so any client can compute identical enable/disable state and the identical human-readable reason a command is unavailable.
