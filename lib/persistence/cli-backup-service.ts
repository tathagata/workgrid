import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ApplicationError, type ErrorCode } from "@/lib/domain/contracts";
import { BACKUP_ID_PATTERN, type BackupReason, type BackupRecord, type BackupService } from "@/lib/backup-service";

const SCRIPT_PATH = fileURLToPath(new URL("../../scripts/backup-manager.mjs", import.meta.url));

const ERROR_CODE_BY_MESSAGE: [RegExp, ErrorCode][] = [
  [/maintenance operation is active/, "CONFLICT"],
  [/revision changed/, "CONFLICT"],
  [/Cannot delete the last known-good backup/, "FORBIDDEN_STATE"],
  [/Expected exactly one local SQLite database/, "UNSUPPORTED"],
];

/** Reuses the CLI's own tested backup logic as a subprocess so recovery still works when the app cannot start. */
export interface CliBackupServiceOptions {
  /** Absolute path to the single local SQLite database file. */
  databasePath: string;
  /** Directory used for the maintenance lock; must exist and be writable. */
  dataRoot: string;
  /** Directory backups are written to. Defaults to `<dataRoot>/backups`. */
  backupPath?: string;
}

export class CliBackupService implements BackupService {
  constructor(private readonly options: CliBackupServiceOptions) {}

  async create(input: { reason: BackupReason | string }): Promise<{ backupId: string }> {
    const result = this.run(["create", input.reason]);
    const line = parseLines(result.stdout).find((entry) => entry.event === "created" || entry.event === "skipped");
    if (!line || line.event === "skipped") throw new ApplicationError("UNSUPPORTED", "No local database is available to back up.");
    return { backupId: line.backupId as string };
  }

  async list(): Promise<BackupRecord[]> {
    const result = this.run(["list"]);
    return result.stdout.trim() ? JSON.parse(result.stdout) : [];
  }

  async verify(input: { backupId: string }): Promise<BackupRecord> {
    this.assertBackupId(input.backupId);
    this.run(["verify", input.backupId]);
    const record = (await this.list()).find((item) => item.id === input.backupId);
    if (!record) throw new ApplicationError("NOT_FOUND", "Backup not found.", "backupId");
    return record;
  }

  async restore(input: { backupId: string; confirmation: string; expectedCurrentRevision?: string }): Promise<void> {
    this.assertBackupId(input.backupId);
    const args = ["restore", input.backupId, input.confirmation];
    if (input.expectedCurrentRevision) args.push(input.expectedCurrentRevision);
    this.run(args);
  }

  async delete(input: { backupId: string }): Promise<void> {
    this.assertBackupId(input.backupId);
    this.run(["delete", input.backupId]);
  }

  private assertBackupId(id: string) {
    if (!BACKUP_ID_PATTERN.test(id)) throw new ApplicationError("INVALID_INPUT", "Invalid backup ID.", "backupId");
  }

  private run(args: string[]) {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        LOCAL_DATA_PATH: this.options.dataRoot,
        WORKGRID_DB_PATH: this.options.databasePath,
        ...(this.options.backupPath ? { WORKGRID_BACKUP_PATH: this.options.backupPath } : {}),
      },
    });
    if (result.status !== 0) throw new ApplicationError(this.classify(result.stderr), this.extractMessage(result.stderr) ?? "The backup operation failed.");
    return result;
  }

  private classify(stderr: string): ErrorCode {
    const message = this.extractMessage(stderr) ?? "";
    return ERROR_CODE_BY_MESSAGE.find(([pattern]) => pattern.test(message))?.[1] ?? "INVALID_INPUT";
  }

  private extractMessage(stderr: string) {
    return [...parseLines(stderr)].reverse().find((entry) => entry.event === "error")?.message as string | undefined;
  }
}

function parseLines(output: string): Array<Record<string, unknown>> {
  return output.trim().split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return {}; } });
}
