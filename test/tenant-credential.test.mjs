import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "workbench-keychain-test-"));
const configPath = path.join(root, "config.json");
const securityPath = path.join(root, "security-mock.mjs");
const markerPath = path.join(root, "called.txt");
await writeFile(configPath, JSON.stringify({ default_env: "beta", envs: { beta: { tenant: "test", base_url: "https://example.invalid", username: "test-account" } } }));
await writeFile(securityPath, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, process.argv[2] || "");\n`);
await chmod(securityPath, 0o700);
process.env.WORKBENCH_INSLY_CONFIG = configPath;
process.env.WORKBENCH_SECURITY_BIN = securityPath;

const { saveTenantCredential } = await import("../bridge/tenants.mjs");

test("tenant credentials are sent to the configured secure-store command", async () => {
  const result = await saveTenantCredential("beta", "test-only-password");
  assert.deepEqual(result, { saved: true, covers: ["beta"] });
  assert.equal(await readFile(markerPath, "utf8"), "add-generic-password");
});
