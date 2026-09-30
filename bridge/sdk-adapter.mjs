import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SDK_ROOT, VAULT_ROOT } from "./config.mjs";

const execFileAsync = promisify(execFile);
const launcher = path.join(SDK_ROOT, ".venv", "bin", "insly");

async function canAccess(target, mode) {
  try { await access(target, mode); return true; } catch { return false; }
}

export async function probeSdk() {
  const [repoReadable, launcherExecutable, vaultReadable, vaultWritable] = await Promise.all([
    canAccess(SDK_ROOT, constants.R_OK), canAccess(launcher, constants.X_OK),
    canAccess(VAULT_ROOT, constants.R_OK), canAccess(VAULT_ROOT, constants.W_OK),
  ]);
  return {
    repoReadable, launcherExecutable, vaultReadable, vaultWritable, sdkRoot: SDK_ROOT, vaultRoot: VAULT_ROOT,
    mode: vaultWritable ? "approval-gated" : "read-only",
    credentialsPresent: Boolean(process.env.INSLY_PASSWORD || process.env.INSLY_PASSWORD_BETA || process.env.INSLY_JWT),
  };
}

export async function runSdk(args, { write = false, approved = false, timeout = 120_000, extraEnv = {} } = {}) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string" || value.includes("\0"))) throw new Error("Invalid SDK arguments");
  if (write && !approved) throw new Error("SDK write is awaiting approval");
  if (write && !(await canAccess(VAULT_ROOT, constants.W_OK))) throw new Error("Client vault is not writable by this app");
  const { stdout, stderr } = await execFileAsync(launcher, args, {
    cwd: SDK_ROOT, env: { ...process.env, ...extraEnv, INSLY_VAULT: VAULT_ROOT }, timeout, maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout: redact(stdout), stderr: redact(stderr) };
}

function redact(value = "") {
  return value.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]").replace(/eyJ[A-Za-z0-9._-]{20,}/g, "[redacted-jwt]");
}
