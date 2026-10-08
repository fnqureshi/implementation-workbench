import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SDK_ROOT, VAULT_ROOT } from "./config.mjs";

const execFileAsync = promisify(execFile);
const sdkPythonCandidates = [
  process.env.WORKBENCH_SDK_PYTHON,
  path.join(os.homedir(), ".local", "bin", "python3.12"),
  path.join(os.homedir(), ".local", "bin", "python3.11"),
  path.join(os.homedir(), ".local", "bin", "python3.10"),
  path.join(SDK_ROOT, ".venv", "bin", "python"),
  "python3",
].filter(Boolean);

async function canAccess(target, mode) {
  try { await access(target, mode); return true; } catch { return false; }
}

async function resolveSdkPython() {
  for (const candidate of sdkPythonCandidates) {
    try {
      await execFileAsync(candidate, ["-c", "import sys"], { cwd: SDK_ROOT, timeout: 5_000 });
      return candidate;
    } catch {
      // Copied virtual environments can retain an executable launcher whose
      // embedded interpreter path no longer exists. Try the next candidate.
    }
  }
  return null;
}

export async function probeSdk() {
  const [repoReadable, resolvedPython, vaultReadable, vaultWritable] = await Promise.all([
    canAccess(SDK_ROOT, constants.R_OK), resolveSdkPython(),
    canAccess(VAULT_ROOT, constants.R_OK), canAccess(VAULT_ROOT, constants.W_OK),
  ]);
  return {
    repoReadable, launcherExecutable: Boolean(resolvedPython), vaultReadable, vaultWritable, sdkRoot: SDK_ROOT, vaultRoot: VAULT_ROOT,
    mode: vaultWritable ? "approval-gated" : "read-only",
    credentialsPresent: Boolean(process.env.INSLY_PASSWORD || process.env.INSLY_PASSWORD_BETA || process.env.INSLY_JWT),
  };
}

export async function runSdk(args, { write = false, approved = false, timeout = 120_000, extraEnv = {} } = {}) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string" || value.includes("\0"))) throw new Error("Invalid SDK arguments");
  if (write && !approved) throw new Error("SDK write is awaiting approval");
  if (write && !(await canAccess(VAULT_ROOT, constants.W_OK))) throw new Error("Client vault is not writable by this app");
  const sdkPython = await resolveSdkPython();
  if (!sdkPython) throw new Error("No working Python interpreter is available for the Implementation SDK");
  // Invoke the package through an interpreter instead of the generated
  // console script. Console scripts embed an absolute path and stop
  // working when a virtual environment is copied or its checkout is moved.
  const { stdout, stderr } = await execFileAsync(sdkPython, ["-m", "insly_sdk", ...args], {
    cwd: SDK_ROOT, env: { ...process.env, ...extraEnv, INSLY_VAULT: VAULT_ROOT }, timeout, maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout: redact(stdout), stderr: redact(stderr) };
}

function redact(value = "") {
  return value.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]").replace(/eyJ[A-Za-z0-9._-]{20,}/g, "[redacted-jwt]");
}
