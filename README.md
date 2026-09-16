# Work Distribution Grid

A private planning board for making team focus explicit. Tasks are initiatives that may have one primary owner and any number of secondary or tertiary contributors.

## MVP workflow

1. Add or edit people and tasks.
2. Drag a task from the inventory into a focus cell, or select it and click a cell.
3. Drag an assignment between focus cells to change it.
4. Drag an assignment back to the task inventory to remove it.
5. Select a task to highlight its full distribution across the team.
6. Put inactive work on hold or archive completed work.

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

## Assignment rules

- A task can have only one primary owner.
- A task can have multiple secondary and tertiary contributors.
- A person may own or contribute to multiple tasks.
- Moving a task to a new primary owner replaces its previous primary assignment.

## Keyboard shortcuts

- `N`: new task
- `Shift + N`: add a person
- `/`: search tasks
- `H`: hold or resume the selected task
- `A`: archive the selected task
- `Esc`: clear the selected task
- `?`: shortcut guide

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
