/** Transport-neutral backup contract for local adapters (CLI, MCP, and future TUI). */
export type BackupReason = "manual" | "scheduled" | "pre-migration" | "pre-restore";

export interface BackupRecord {
  id: string;
  createdAt: string;
  reason: BackupReason | string;
  appVersion: string;
  schemaVersion: number;
  sizeBytes: number;
  sha256: string;
}

export interface BackupService {
  create(input: { reason: BackupReason | string }): Promise<{ backupId: string }>;
  list(): Promise<BackupRecord[]>;
  verify(input: { backupId: string }): Promise<BackupRecord>;
  restore(input: {
    backupId: string;
    confirmation: string;
    expectedCurrentRevision?: string;
  }): Promise<void>;
  delete(input: { backupId: string }): Promise<void>;
}

/** Protocol adapters must accept only backup IDs, never filesystem paths. */
export const BACKUP_ID_PATTERN = /^\d{8}T\d{6}Z-[a-z0-9-]{1,32}-[a-f0-9]{8}$/;
