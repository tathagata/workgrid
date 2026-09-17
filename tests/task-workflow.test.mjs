import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkflowError, archiveFacts, assertAssignable, migrateLegacyStatus, restoreFacts, workflowDto,
} from "../lib/task-workflow.ts";

const facts = (lifecycle = "active", outcome = null, revision = 3) => ({ lifecycle, outcome, revision, changedAt: "2026-01-01T00:00:00Z" });

test("every persisted lifecycle and valid primary count resolves to one workflow state", () => {
  assert.equal(workflowDto(facts(), 0).state, "unfocused");
  assert.equal(workflowDto(facts(), 1).state, "focused");
  assert.equal(workflowDto(facts("archived"), 0).state, "archived");
  assert.equal(workflowDto(facts("archived", "completed"), 1).state, "archived");
  assert.equal(workflowDto(facts("archived", "completed"), 1).outcome, "completed");
});

test("all legacy states migrate deterministically without inventing an outcome", () => {
  assert.deepEqual(migrateLegacyStatus("active"), { lifecycle: "active", outcome: null });
  assert.deepEqual(migrateLegacyStatus("hold"), { lifecycle: "active", outcome: null });
  assert.deepEqual(migrateLegacyStatus("archived"), { lifecycle: "archived", outcome: null });
});

test("archive and restore preserve optimistic concurrency and clear terminal outcome", () => {
  const archived = archiveFacts(facts(), "completed", "2026-02-01T00:00:00Z", 3);
  assert.deepEqual(archived, { lifecycle: "archived", outcome: "completed", changedAt: "2026-02-01T00:00:00Z", revision: 4 });
  assert.deepEqual(restoreFacts(archived, "2026-02-02T00:00:00Z", 4), { lifecycle: "active", outcome: null, changedAt: "2026-02-02T00:00:00Z", revision: 5 });
});

test("stale transitions fail with a stable conflict code", () => {
  assert.throws(() => archiveFacts(facts(), undefined, "now", 2), (error) => error instanceof WorkflowError && error.code === "REVISION_CONFLICT");
  assert.throws(() => restoreFacts(facts("archived"), "now", 2), (error) => error instanceof WorkflowError && error.code === "REVISION_CONFLICT");
});

test("archived assignments are immutable until restoration", () => {
  assert.doesNotThrow(() => assertAssignable("active"));
  assert.throws(() => assertAssignable("archived"), (error) => error instanceof WorkflowError && error.code === "TASK_ARCHIVED");
});
