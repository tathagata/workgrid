import { readdirSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

type Row = Record<string, unknown>;

class SqliteStatement {
  private values: SQLInputValue[] = [];
  constructor(private readonly statement: StatementSync) {}
  bind(...values: unknown[]) { this.values = values as SQLInputValue[]; return this; }
  async run() { const result = this.statement.run(...this.values); return { meta: { changes: Number(result.changes) } }; }
  async first<T>() { return (this.statement.get(...this.values) as T | undefined) ?? null; }
  all<T>() { return this.statement.all(...this.values) as T[]; }
  execute<T>() {
    if (this.statement.columns().length) return { results: this.all<T>() };
    const result = this.statement.run(...this.values);
    return { results: [] as T[], changes: result.changes };
  }
}

export class SqliteDatabaseAdapter {
  constructor(private readonly database: DatabaseSync) {
    database.exec("PRAGMA foreign_keys = ON");
  }
  prepare(sql: string) { return new SqliteStatement(this.database.prepare(sql)); }
  async batch<T = Row>(statements: SqliteStatement[]) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute<T>());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  close() { this.database.close(); }
}

export function openLocalDatabase(root = process.cwd()) {
  const stateRoot = realpathSync(resolve(root, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject"));
  const candidates = readdirSync(stateRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite"))
    .map((entry) => realpathSync(resolve(entry.parentPath, entry.name)))
    .filter((path) => path.startsWith(`${stateRoot}${sep}`));
  if (candidates.length !== 1) throw new Error(`Expected exactly one local Workgrid database; found ${candidates.length}. Start the web app once before MCP.`);
  return new SqliteDatabaseAdapter(new DatabaseSync(candidates[0]));
}
