import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { INSLY_CONFIG_FILE, KEYCHAIN_SERVICE, SECURITY_BIN } from "./config.mjs";
import { runSdk } from "./sdk-adapter.mjs";

const execFileAsync = promisify(execFile);
const security = SECURITY_BIN;

function safeMessage(value = "") {
  return String(value)
    .replace(/password[^\n]*/gi, "credential rejected")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, "[redacted-jwt]")
    .slice(0, 700);
}

async function loadConfig() {
  const parsed = JSON.parse(await readFile(INSLY_CONFIG_FILE, "utf8"));
  return parsed;
}

async function keychainHas(account) {
  try {
    await execFileAsync(security, ["find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE], { timeout: 10_000 });
    return true;
  } catch { return false; }
}

async function keychainGet(account) {
  try {
    const { stdout } = await execFileAsync(security, ["find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-w"], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch { return ""; }
}

function envPasswordName(name) {
  return `INSLY_PASSWORD_${name.toUpperCase().replace(/-/g, "_")}`;
}

export async function listTenants(connections = []) {
  const config = await loadConfig();
  const connectionByEnv = new Map(connections.map((item) => [item.env_name, item]));
  const entries = Object.entries(config.envs || {});
  const accounts = [...new Set(entries.map(([, value]) => value.username).filter(Boolean))];
  const stored = new Map(await Promise.all(accounts.map(async (account) => [account, await keychainHas(account)])));
  return Promise.all(entries.map(async ([name, value]) => {
    const account = value.username || "";
    const credentialPresent = Boolean(process.env[envPasswordName(name)] || process.env.INSLY_PASSWORD || stored.get(account));
    return {
      name,
      tenant: value.tenant,
      baseUrl: value.base_url,
      username: account,
      protected: Boolean(value.protected),
      authFrom: value.auth_from || null,
      isDefault: config.default_env === name,
      credentialPresent,
      credentialSource: process.env[envPasswordName(name)] || process.env.INSLY_PASSWORD ? "process" : stored.get(account) ? "keychain" : null,
      connection: connectionByEnv.get(name) || null,
    };
  }));
}

export async function saveTenantCredential(envName, password) {
  const config = await loadConfig();
  const env = config.envs?.[envName];
  if (!env) throw new Error("Unknown configured environment");
  if (typeof password !== "string" || password.length < 1 || password.length > 4096) throw new Error("Enter a valid password");
  await execFileAsync(security, ["add-generic-password", "-U", "-a", env.username, "-s", KEYCHAIN_SERVICE, "-l", `Implementation Workbench · ${env.username}`, "-w", password], { timeout: 15_000 });
  return { saved: true, covers: Object.entries(config.envs).filter(([, item]) => item.username === env.username).map(([name]) => name) };
}

export async function testTenantConnection(envName) {
  const config = await loadConfig();
  const env = config.envs?.[envName];
  if (!env) throw new Error("Unknown configured environment");
  const sourceName = env.auth_from && config.envs?.[env.auth_from] ? env.auth_from : envName;
  const source = config.envs[sourceName];
  const password = process.env[envPasswordName(sourceName)] || process.env.INSLY_PASSWORD || await keychainGet(source.username);
  if (!password) throw new Error("No credential is connected for this login identity");
  try {
    const result = await runSdk(["--env", envName, "--json", "login", "--force"], { extraEnv: { [envPasswordName(sourceName)]: password, INSLY_PASSWORD: password }, timeout: 45_000 });
    let info = {};
    try { info = JSON.parse(result.stdout); } catch { /* SDK output can be human-readable on older builds */ }
    return { ok: true, source: sourceName, expiresInMinutes: info.expires_in_min ?? null, groups: Array.isArray(info.groups) ? info.groups.length : null };
  } catch (error) {
    throw new Error(safeMessage(error.stderr || error.stdout || error.message || error));
  }
}

export async function credentialEnvironment(envName) {
  const config = await loadConfig();
  const env = config.envs?.[envName];
  if (!env) throw new Error("Unknown configured environment");
  const sourceName = env.auth_from && config.envs?.[env.auth_from] ? env.auth_from : envName;
  const source = config.envs[sourceName];
  const password = process.env[envPasswordName(sourceName)] || process.env.INSLY_PASSWORD || await keychainGet(source.username);
  if (!password) throw new Error(`Connect ${envName} on the Tenants screen before local implementation`);
  return { [envPasswordName(sourceName)]: password, INSLY_PASSWORD: password };
}
