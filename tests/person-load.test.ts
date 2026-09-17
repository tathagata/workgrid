import assert from "node:assert/strict";
import test from "node:test";
import { calculatePersonLoads, DEFAULT_PERSON_LOAD_POLICY } from "../lib/person-load";

const people = [{ id: "p1" }, { id: "p2" }, { id: "p3" }];
const tasks = [
  { id: "t1", workflow: { state: "focused" as const, changedAt: "" } },
  { id: "t2", workflow: { state: "unfocused" as const, changedAt: "" } },
  { id: "t3", workflow: { state: "archived" as const, changedAt: "" } },
];

test("calculates raw counts, weighted scores, and inclusive thresholds", () => {
  const metrics = calculatePersonLoads(people, tasks, [
    { personId: "p1", taskId: "t1", focus: "primary" },
    { personId: "p1", taskId: "t2", focus: "secondary" },
    { personId: "p1", taskId: "t3", focus: "primary" },
    { personId: "p2", taskId: "t1", focus: "tertiary" },
  ]);
  assert.deepEqual(metrics.get("p1"), { calculationVersion: 1, score: 1.5, state: "balanced", activeAssignmentCount: 2, counts: { primary: 1, secondary: 1, tertiary: 0 } });
  assert.equal(metrics.get("p2")?.state, "low");
  assert.equal(metrics.get("p3")?.score, 0);
});

test("classifies exactly 1 and 2.5 as balanced and values above 2.5 as overloaded", () => {
  const active = Array.from({ length: 4 }, (_, index) => ({ id: `t${index}`, workflow: { state: "focused" as const, changedAt: "" } }));
  const atMinimum = calculatePersonLoads([{ id: "p" }], active, [{ personId: "p", taskId: "t0", focus: "primary" }]);
  const atMaximum = calculatePersonLoads([{ id: "p" }], active, [
    { personId: "p", taskId: "t0", focus: "primary" }, { personId: "p", taskId: "t1", focus: "primary" }, { personId: "p", taskId: "t2", focus: "secondary" },
  ]);
  const aboveMaximum = calculatePersonLoads([{ id: "p" }], active, [
    { personId: "p", taskId: "t0", focus: "primary" }, { personId: "p", taskId: "t1", focus: "primary" }, { personId: "p", taskId: "t2", focus: "primary" },
  ]);
  assert.equal(atMinimum.get("p")?.state, "balanced");
  assert.equal(atMaximum.get("p")?.state, "balanced");
  assert.equal(aboveMaximum.get("p")?.state, "overloaded");
  assert.equal(DEFAULT_PERSON_LOAD_POLICY.weights.tertiary, 0.25);
});
