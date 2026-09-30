import test from "node:test";
import assert from "node:assert/strict";
import { assertRole, redactSecrets, snapshotHash } from "../bridge/policy.mjs";

test("snapshot hashes are stable across object key order", () => {
  assert.equal(snapshotHash({ b: 2, a: { d: 4, c: 3 } }), snapshotHash({ a: { c: 3, d: 4 }, b: 2 }));
  assert.notEqual(snapshotHash({ a: 1 }), snapshotHash({ a: 2 }));
});

test("role boundaries prevent implementation users from managing credentials", () => {
  assert.doesNotThrow(() => assertRole("implementer", "create_task"));
  assert.throws(() => assertRole("implementer", "manage_providers"), /not allowed/);
  assert.doesNotThrow(() => assertRole("reviewer", "resolve_approval"));
});

test("provider and bearer credentials are redacted from stored output", () => {
  const redacted = redactSecrets("sk-ant-test_abcdefghijklmnop Bearer test.token.value");
  assert.equal(redacted.includes("sk-ant"), false);
  assert.equal(redacted.includes("abc.def.ghi"), false);
});
