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
- Backup commands are a reserved extension point and must be added to the shared contract before any transport exposes them.

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

The MCP server is stdio-only and discovers the single D1 SQLite file beneath the project's fixed `.wrangler/state` directory. It accepts no database path, raw SQL, backup destination, or network configuration. Start the web app once to initialize the database, stop it to avoid concurrent SQLite processes, then run:

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
