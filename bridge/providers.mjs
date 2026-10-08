import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PROVIDER_KEYCHAIN_SERVICE, SECURITY_BIN } from "./config.mjs";
import { PLAN_SCHEMA, PROVIDER_DEFINITIONS, extractJson, messagesOutputText, normalizePlan, responsesOutputText } from "./provider-core.mjs";
import { redactSecrets } from "./policy.mjs";

const execFileAsync = promisify(execFile);
const security = SECURITY_BIN;

async function keychainHas(account) {
  try { await execFileAsync(security, ["find-generic-password", "-a", account, "-s", PROVIDER_KEYCHAIN_SERVICE], { timeout: 10_000 }); return true; }
  catch { return false; }
}

async function keychainGet(account) {
  try { const { stdout } = await execFileAsync(security, ["find-generic-password", "-a", account, "-s", PROVIDER_KEYCHAIN_SERVICE, "-w"], { timeout: 10_000, maxBuffer: 32_000 }); return stdout.trim(); }
  catch { return ""; }
}

export async function saveProviderCredential(profileId, apiKey) {
  if (typeof apiKey !== "string" || apiKey.length < 12 || apiKey.length > 4096) throw new Error("Enter a valid API key");
  await execFileAsync(security, ["add-generic-password", "-U", "-a", profileId, "-s", PROVIDER_KEYCHAIN_SERVICE, "-l", `Implementation Workbench provider · ${profileId}`, "-w", apiKey], { timeout: 15_000 });
}

export async function publicProfiles(profiles) {
  return Promise.all(profiles.map(publicProfile));
}

export async function publicProfile(profile) {
  const definition = PROVIDER_DEFINITIONS[profile.provider];
  return {
    id: profile.id, provider: profile.provider, label: profile.label, model: profile.model, scope: profile.scope, status: profile.status,
    last_tested_at: profile.last_tested_at, last_error: profile.last_error,
    local: profile.provider === "local-agent",
    credentialPresent: profile.provider === "local-agent" || await keychainHas(profile.id),
    definition: definition ? { name: definition.name, capabilities: definition.capabilities } : { name: "Planning connector", capabilities: [] },
  };
}

export async function listProviderModels(profile) {
  if (profile.provider === "local-agent") return [{ id: "private", name: "Local implementation agent" }];
  const key = await providerKey(profile);
  if (profile.provider === "connector-a") {
    const headers = { authorization: `Bearer ${key}` };
    if (profile.project_id) headers["OpenAI-Project"] = profile.project_id;
    const { payload } = await requestJson("https://api.openai.com/v1/models", { headers });
    return (payload.data || [])
      .map((item) => ({ id: String(item.id || ""), name: String(item.id || "") }))
      .filter((item) => /^(gpt-|o\d|chatgpt-)/i.test(item.id))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  if (profile.provider === "connector-b") {
    const headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
    const { payload } = await requestJson("https://api.anthropic.com/v1/models?limit=100", { headers });
    return (payload.data || [])
      .map((item) => ({ id: String(item.id || ""), name: String(item.display_name || item.id || "") }))
      .filter((item) => item.id)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  throw new Error("Unsupported provider");
}

async function requestJson(url, options, timeout = 45_000) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const requestId = response.headers.get("x-request-id") || response.headers.get("request-id");
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(redactSecrets(payload?.error?.message || payload?.message || `Provider request failed (${response.status})`));
    return { payload, requestId };
  } finally { clearTimeout(timer); }
}

async function providerKey(profile) {
  const key = await keychainGet(profile.id);
  if (!key) throw new Error(`No API key is connected for '${profile.label}'`);
  return key;
}

export async function testProvider(profile) {
  if (profile.provider === "local-agent") return { ok: true, requestId: null };
  const key = await providerKey(profile);
  if (profile.provider === "connector-a") {
    const headers = { authorization: `Bearer ${key}` };
    if (profile.project_id) headers["OpenAI-Project"] = profile.project_id;
    const result = await requestJson("https://api.openai.com/v1/models", { headers });
    return { ok: true, requestId: result.requestId };
  }
  if (profile.provider === "connector-b") {
    const headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
    const result = await requestJson("https://api.anthropic.com/v1/models?limit=1", { headers });
    return { ok: true, requestId: result.requestId };
  }
  throw new Error("Unsupported provider");
}

export async function planWithProvider(profile, prompt) {
  const key = await providerKey(profile);
  if (profile.provider === "connector-a") {
    const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
    if (profile.project_id) headers["OpenAI-Project"] = profile.project_id;
    const { payload, requestId } = await requestJson("https://api.openai.com/v1/responses", {
      method: "POST", headers,
      body: JSON.stringify({ model: profile.model, input: prompt, store: false, text: { format: { type: "json_schema", name: "implementation_plan", strict: true, schema: PLAN_SCHEMA } } }),
    }, 120_000);
    return { plan: normalizePlan(extractJson(responsesOutputText(payload))), raw: JSON.stringify(payload), requestId, usage: payload.usage || null };
  }
  if (profile.provider === "connector-b") {
    const headers = { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" };
    const { payload, requestId } = await requestJson("https://api.anthropic.com/v1/messages", {
      method: "POST", headers,
      body: JSON.stringify({ model: profile.model, max_tokens: 1800, system: `Return only JSON matching this schema: ${JSON.stringify(PLAN_SCHEMA)}`, messages: [{ role: "user", content: prompt }] }),
    }, 120_000);
    return { plan: normalizePlan(extractJson(messagesOutputText(payload))), raw: JSON.stringify(payload), requestId, usage: payload.usage || null };
  }
  throw new Error("Unsupported API planning provider");
}

export async function respondWithProvider(profile, prompt) {
  const key = await providerKey(profile);
  if (profile.provider === "connector-a") {
    const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
    if (profile.project_id) headers["OpenAI-Project"] = profile.project_id;
    const { payload, requestId } = await requestJson("https://api.openai.com/v1/responses", {
      method: "POST", headers,
      body: JSON.stringify({ model: profile.model, input: prompt, store: false }),
    }, 120_000);
    return { text: responsesOutputText(payload).trim(), raw: JSON.stringify(payload), requestId, usage: payload.usage || null };
  }
  if (profile.provider === "connector-b") {
    const headers = { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" };
    const { payload, requestId } = await requestJson("https://api.anthropic.com/v1/messages", {
      method: "POST", headers,
      body: JSON.stringify({
        model: profile.model, max_tokens: 2600,
        system: "You are the Implementation Workbench assistant. Answer from the supplied task evidence. Be concise, state uncertainty, and never reveal credentials or tokens.",
        messages: [{ role: "user", content: prompt }],
      }),
    }, 120_000);
    return { text: messagesOutputText(payload).trim(), raw: JSON.stringify(payload), requestId, usage: payload.usage || null };
  }
  throw new Error("Unsupported API conversation provider");
}
