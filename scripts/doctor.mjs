import { access, constants } from "node:fs/promises";
import process from "node:process";
import { DATA_DIR, SDK_ROOT, VAULT_ROOT } from "../bridge/config.mjs";

const checks = [];
async function check(label, action, required = true) {
  try { await action(); checks.push({ label, ok: true, required }); }
  catch (error) { checks.push({ label, ok: false, required, detail: String(error.message || error) }); }
}

await check("Node.js 22.13 or newer", async () => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error(`found ${process.versions.node}`);
});
await check("Implementation SDK readable", () => access(SDK_ROOT, constants.R_OK), false);
await check("Client vault writable", () => access(VAULT_ROOT, constants.R_OK | constants.W_OK), false);
await check("Local data directory writable", () => access(DATA_DIR, constants.R_OK | constants.W_OK));
await check("macOS Keychain command available", () => access("/usr/bin/security", constants.X_OK));

for (const item of checks) process.stdout.write(`${item.ok ? "✓" : item.required ? "✗" : "!"} ${item.label}${item.detail ? ` — ${item.detail}` : ""}\n`);
const failed = checks.filter((item) => item.required && !item.ok);
if (failed.length) process.exitCode = 1;
else process.stdout.write("\nWorkbench foundation is ready. Optional SDK/vault warnings can be configured per teammate.\n");
