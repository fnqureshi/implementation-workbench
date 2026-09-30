import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.WORKBENCH_DATA_DIR = await mkdtemp(path.join(tmpdir(), "workbench-test-"));
process.env.WORKBENCH_ACTOR_ID = "test-reviewer";
process.env.WORKBENCH_ACTOR_NAME = "Test Reviewer";
process.env.WORKBENCH_ROLE = "admin";
const { store } = await import("../bridge/db.mjs");

test("approval snapshot becomes stale when client memory changes", () => {
  const client = store.bootstrap().clients[0];
  const task = store.createTask({ clientId: client.id, ticket: "MAKE-100", title: "Test", request: "Add a field", product: "car", environment: "beta" });
  store.setTaskPlan(task.id, { summary: "Plan", risk: "low", steps: ["Prepare"], relevantMemory: [], note: "" });
  const approval = store.createApproval(task.id, "implement_local", { scope: "Ticket working copy only", liveWrites: false });
  assert.equal(store.taskSnapshot(task.id).hash, approval.snapshot_hash);
  store.createMemory({ clientId: client.id, title: "New rule", detail: "The field is mandatory" });
  assert.notEqual(store.taskSnapshot(task.id).hash, approval.snapshot_hash);
});

test("memory revisions preserve predecessor and increment the revision", () => {
  const client = store.bootstrap().clients[0];
  const first = store.createMemory({ clientId: client.id, title: "Format", detail: "Use A" });
  const second = store.createMemory({ clientId: client.id, title: "Format", detail: "Use B", supersedesId: first.id });
  assert.equal(second.revision, 2);
  assert.equal(store.memoriesForClient(client.id).some((item) => item.id === first.id), false);
});
