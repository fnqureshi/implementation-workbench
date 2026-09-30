import path from "node:path";
import os from "node:os";

export const APP_ROOT = path.resolve(import.meta.dirname, "..");
export const DATA_DIR = process.env.WORKBENCH_DATA_DIR || path.join(APP_ROOT, "data");
export const SDK_ROOT = process.env.WORKBENCH_SDK_ROOT || path.join(os.homedir(), "Claude", "Projects", "Insly Onboarding", "implementation-sdk");
export const VAULT_ROOT = process.env.WORKBENCH_VAULT_ROOT || path.join(os.homedir(), "Claude", "Projects", "Insly Onboarding", "shape-vault");
export const INSLY_CONFIG_FILE = process.env.WORKBENCH_INSLY_CONFIG || path.join(os.homedir(), ".insly", "config.json");
export const KEYCHAIN_SERVICE = "com.implementation-workbench.insly";
export const PROVIDER_KEYCHAIN_SERVICE = "com.implementation-workbench.providers";
export const SECURITY_BIN = process.env.WORKBENCH_SECURITY_BIN || "/usr/bin/security";
export const LOCAL_AGENT_BIN = process.env.WORKBENCH_AGENT_BIN || "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
export const ACTOR_ID = process.env.WORKBENCH_ACTOR_ID || os.userInfo().username;
export const ACTOR_NAME = process.env.WORKBENCH_ACTOR_NAME || os.userInfo().username;
export const ACTOR_ROLE = process.env.WORKBENCH_ROLE || "admin";
export const REQUIRE_SEPARATE_REVIEW = process.env.WORKBENCH_REQUIRE_SEPARATE_REVIEW === "1";
export const BRIDGE_HOST = "127.0.0.1";
export const BRIDGE_PORT = Number(process.env.WORKBENCH_BRIDGE_PORT || 4319);

export const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
]);
