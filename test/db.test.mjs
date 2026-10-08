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

test("tasks preserve review and autopilot execution choices", () => {
  const client = store.bootstrap().clients[0];
  const review = store.createTask({ clientId: client.id, ticket: "MAKE-200", title: "Review", request: "Review first", product: "car", environment: "beta", executionMode: "review" });
  const autopilot = store.createTask({ clientId: client.id, ticket: "MAKE-201", title: "Autopilot", request: "Continue locally", product: "car", environment: "beta", executionMode: "autopilot" });
  assert.equal(review.execution_mode, "review");
  assert.equal(autopilot.execution_mode, "autopilot");
  assert.equal(store.bootstrap().events.some((event) => event.task_id === autopilot.id && event.title === "Autopilot authorized"), true);
});

test("provider default model can be changed in settings", () => {
  const profile = store.createProviderProfile({ provider: "connector-a", label: "OpenAI", model: "gpt-initial", scope: "personal" });
  assert.equal(store.setProviderModel(profile.id, "gpt-selected").model, "gpt-selected");
});

test("task conversations persist follow-ups and per-task settings", () => {
  const client = store.bootstrap().clients[0];
  const task = store.createTask({ clientId: client.id, ticket: "MAKE-300", title: "Read schema", request: "Read the beta schema", product: "Shape", environment: "beta", executionMode: "review" });
  store.addMessage({ taskId: task.id, role: "assistant", kind: "result", content: "Schema read complete", sources: ["Implementation SDK"] });
  const messages = store.messagesForTask(task.id);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[1].content, "Schema read complete");
  assert.deepEqual(messages[1].sources, ["Implementation SDK"]);
  assert.equal(store.setTaskSettings(task.id, { executionMode: "autopilot" }).execution_mode, "autopilot");
});
