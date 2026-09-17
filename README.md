# Work Distribution Grid

A private planning board for making team focus explicit. Tasks are initiatives that may have one primary owner and any number of secondary or tertiary contributors.

## MVP workflow

1. Add or edit people and tasks.
2. Drag a task from the inventory into a focus cell, or select it and click a cell.
3. Drag an assignment between focus cells to change it.
4. Drag an assignment back to the task inventory to remove it.
5. Select a task to highlight its full distribution across the team.
6. Archive or complete finished work, and restore it later without losing assignment history.

Changes are stored in the application's database. A JSON snapshot can be downloaded from **Board → Export JSON**.

## Run locally with Docker

Docker Desktop is the only prerequisite. From this folder, run:

```bash
docker compose up --build
```

Then open [http://localhost:4173](http://localhost:4173).

The application is exposed only on your computer (`127.0.0.1`). Its database is stored in the named volume `work-grid-data`, so normal container restarts and rebuilds do not erase your work.

Useful commands:

```bash
# Start in the background
docker compose up --build -d

# View logs
docker compose logs -f work-grid

# Stop the app without deleting its data
docker compose down

# Restart it later
docker compose up -d
```

Do not add `--volumes` to `docker compose down` unless you intentionally want to delete the local database.

## Backups and recovery

The container creates and verifies a SQLite snapshot before every migration, then runs a post-migration integrity check before starting the app. It also creates a verified backup every 24 hours. Database and backups use separate Docker volumes (`work-grid-data` and `work-grid-backups`), so an explicitly configured bind mount can place backups on another local disk.

Defaults retain the newest backup plus 7 daily and 4 weekly generations. Protected generations are never removed merely to meet the 1 GiB budget, and the last verified backup cannot be deleted. Configure the schedule and policy with `WORKGRID_BACKUP_INTERVAL_SECONDS`, `WORKGRID_BACKUP_RETAIN_DAILY`, `WORKGRID_BACKUP_RETAIN_WEEKLY`, and `WORKGRID_BACKUP_MAX_BYTES`. Backup files and directories are owner-only where supported. Logs contain IDs and sizes, never board content.

The recovery CLI works even when the web app cannot start:

```bash
# Create, list, and verify (run inside the stopped service container)
docker compose run --rm --entrypoint node work-grid /app/scripts/backup-manager.mjs create manual
docker compose run --rm --entrypoint node work-grid /app/scripts/backup-manager.mjs list
docker compose run --rm --entrypoint node work-grid /app/scripts/backup-manager.mjs verify BACKUP_ID

# Stop the app before restore. The exact confirmation prevents accidental restore.
docker compose stop work-grid
docker compose run --rm --entrypoint node work-grid /app/scripts/backup-manager.mjs restore BACKUP_ID RESTORE:BACKUP_ID
docker compose up -d
```

Restore verifies checksum, SQLite integrity, schema metadata, and application compatibility before changing the live database. It also creates a verified `pre-restore` safety backup and replaces the database atomically. Operations accept opaque IDs only, not paths. If an upgrade fails, leave the container stopped, list and verify the latest `pre-migration` backup, restore it with the guarded command above, then run the prior application image. Never delete both Docker volumes during recovery.

Before releasing a schema migration, populate all supported entity/state fields, create and verify a pre-migration backup, apply the migration, restore the backup into an isolated database, and exercise the prior release. Record this restore drill in the release checklist.

## Local MCP server

Workgrid's web API and MCP server use the same typed application service and domain rules. The MCP process communicates over stdio, opens no network listener, and only discovers the single database beneath this project's fixed `.wrangler/state` directory. Start the web app once so its local database and migrations exist, then stop the app before starting MCP:

```bash
npm run mcp
```

MCP exposes the board plus individual people/tasks as resources, and provides tools for every board mutation. It also exposes `backup.create/list/verify/restore/delete`, backed by the same `scripts/backup-manager.mjs` logic as the CLI above; backups it creates are written beneath `.wrangler/state/workgrid-backups`. See [the versioned application/MCP contract](docs/application-api.md) for schemas, error codes, client configuration, compatibility rules, and examples. The current local SQLite adapter should not run concurrently with the web development server.

## Assignment rules

- A task can have only one primary owner.
- A task can have multiple secondary and tertiary contributors.
- A person may own or contribute to multiple tasks.
- Moving a task to a new primary owner replaces its previous primary assignment.
- Archived/completed tasks retain assignments for history but reject assignment changes until restored.

## Person load

Each team row shows a labeled low, balanced, or overloaded indicator plus its weighted score. Active primary, secondary, and tertiary assignments contribute `1`, `0.5`, and `0.25`; archived work contributes nothing. Low means below `1`, balanced includes `1` through `2.5`, and overloaded means above `2.5`. Filters and alternate load sorts are view-only and never change the saved team order. The versioned policy, raw focus counts, score, and state are part of the shared application API for web, MCP, exports, and future TUI clients.

## Task workflow and API contract

The version 1 task DTO exposes `workflow: { state, outcome?, changedAt }`. Clients must use this field rather than infer state themselves:

```text
                         archive / complete
unfocused ── primary ──> focused ─────────────> archived
    ^                       |                       |
    └── remove primary ─────┘<────── restore ──────┘
```

`unfocused` and `focused` are derived states: an active task is focused if and only if it has exactly one primary assignment. `archived` is persisted, and may carry a terminal `outcome` of `completed`, `cancelled`, or `superseded`. Archiving preserves assignments as historical context; restoring therefore returns to focused when a valid primary remains, or unfocused otherwise.

| Command | Valid from | Result | Error cases |
| --- | --- | --- | --- |
| `archiveTask { id, outcome?, expectedRevision? }` | Unfocused, focused | Archived; assignments preserved | invalid outcome, missing task, revision conflict |
| `restoreTask { id, expectedRevision? }` | Archived | Focused when a primary remains; otherwise unfocused | missing task, revision conflict |
| `assign { taskId, personId, focus }` | Unfocused, focused | Primary assignment focuses atomically; replacing it retains exactly one primary | archived task, invalid IDs/focus |
| `unassign { taskId, personId }` | Unfocused, focused | Removing the primary makes the task unfocused atomically | archived task, invalid IDs |

Conflicts return HTTP `409` with code `CONFLICT`; archived-state and input errors return HTTP `400` with stable `FORBIDDEN_STATE` or `INVALID_INPUT` codes. The same application-service commands and versioned DTO are the contract for the web UI, MCP, exports, and future TUI clients.

### Migration and rollback

Migration `0001_task_workflow.sql` preserves every task and assignment. Legacy `active` tasks remain active, legacy `hold` tasks become active, and either resolves to focused only when it has a primary owner. Legacy `archived` remains archived. The original value remains in `legacy_status`, making the mapping auditable and reversible.

A verified database backup is required before applying this migration. To roll back, restore that backup (preferred), or reconstruct the old `status` from `legacy_status`; do not reverse by guessing from the derived workflow state.

## Keyboard shortcuts

- `N`: new task
- `Shift + N`: add a person
- `/`: search tasks
- `A`: archive the selected task
- `C`: complete the selected task
- `R`: restore the selected archived task
- `Esc`: clear the selected task
- `?`: shortcut guide

## Task colors

Tasks use a versioned 12-color accessible palette. When no color is supplied, the application service chooses the least-used color among active tasks, resolving ties by the published palette order. Explicit palette IDs are stable across palette evolution; existing custom hex colors remain intact with a `null` palette ID. Web, MCP, and future TUI clients discover the palette through `appearance.get` rather than defining their own. Color is presentation metadata only and never controls task workflow.

## Planned extensions

The MVP keeps task and assignment records independent so later releases can add:

- Jira issue links across multiple Jira projects, aggregated under one task/initiative;
- workload calculations based on Jira effort and assignment share; and
- calendar-derived availability, planned time away, and meeting load.

## Development

Requires Node.js `>=22.13.0`.

```bash
npm run dev
npm run lint
npm run build
npm run db:generate
```

Database schema changes live in `db/schema.ts`; generated migrations live in `drizzle/`.
