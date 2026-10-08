import test from "node:test";
import assert from "node:assert/strict";
import { deriveOperation, summarizeSdkOutput } from "../bridge/agent-runner.mjs";

const task = { product: "Shape", environment: "beta", request: "read the beta schema", ticket: "MAKE-123" };

test("schema reads are classified as safe tenant reads with a normalized product slug", () => {
  const operation = deriveOperation(task);
  assert.equal(operation.kind, "tenant-read");
  assert.equal(operation.liveWrites, false);
  assert.deepEqual(operation.sdkArgs, ["--env", "beta", "--json", "schema", "full", "shape", "--type", "policy"]);
});

test("change requests remain approval-gated mutations", () => {
  assert.equal(deriveOperation(task, "add a required field and push it").kind, "mutation");
});

test("schema results become plain-language findings", () => {
  const operation = deriveOperation(task);
  const output = summarizeSdkOutput(task, operation, JSON.stringify({
    scheme: { properties: { customer: { type: "object", required: ["name"], properties: { name: { type: "string" }, kind: { type: "string", enum: ["person", "company"] } } } }, definitions: { address: { type: "object" } } },
    ui: { customer: { name: { "ui:widget": "hidden" } } },
  }), "v12 -> mirror/full.json");
  assert.match(output, /Schema version: 12/);
  assert.match(output, /Fields discovered: 3/);
  assert.match(output, /customer\.name/);
  assert.match(output, /No tenant configuration was changed/);
});
