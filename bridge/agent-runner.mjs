import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DATA_DIR, LOCAL_AGENT_BIN, SDK_ROOT, VAULT_ROOT } from "./config.mjs";
import { runSdk } from "./sdk-adapter.mjs";
import { credentialEnvironment } from "./tenants.mjs";
import { planWithProvider, respondWithProvider } from "./providers.mjs";
import { redactSecrets } from "./policy.mjs";

async function executable(target) { try { await access(target, constants.X_OK); return true; } catch { return false; } }

function cleanStep(value) {
  return String(value || "").replace(/^\s*\d+[.)]\s*/, "").trim();
}

function fallbackPlan(task, memories, operation) {
  const isRead = operation.kind === "tenant-read";
  return {
    summary: isRead
      ? `Read ${task.product.toLowerCase()} from ${operation.environment} with the Implementation SDK and report the evidence.`
      : `Prepare ${task.ticket} for ${task.product} in ${task.environment}, using the existing SDK task workflow.`,
    risk: isRead ? "low" : task.environment === "beta" ? "medium" : "high",
    steps: isRead
      ? ["Confirm the documented SDK read command.", "Read the tenant data without changing server state.", "Analyze the response and report the findings with its source."]
      : ["Inspect the relevant SDK and client context.", "Prepare the change in the ticket working copy.", "Run the relevant checks.", "Present the result before any live write."],
    relevantMemory: memories.map((memory) => memory.title),
    note: isRead ? "This operation reads tenant data and never writes tenant configuration." : "Tenant writes, deployments, and destructive actions always require a separate approval.",
    operation,
  };
}

export function deriveOperation(task, request = task.request) {
  const text = String(request || "").toLowerCase();
  const product = String(task.product || "").toLowerCase();
  const environment = (text.match(/\b(beta|demo|production|prod)\b/)?.[1] || task.environment).replace("production", "prod");
  const mutation = /\b(add|build|change|configure|create|delete|deploy|edit|fix|implement|modify|push|remove|rename|rollback|set|update|upload|write)\b/;
  if (mutation.test(text)) return { kind: "mutation", label: "Prepare implementation", environment, liveWrites: true };
  const schemaRead = /\b(schema|scheme|fields?|properties|configuration)\b/.test(text)
    && /\b(read|show|inspect|check|find|fetch|get|tell|list|analyse|analyze|compare|what)\b/.test(text);
  if (schemaRead) {
    const type = text.includes("policy-data-change") ? "policy-data-change" : "policy";
    return {
      kind: "tenant-read", label: `Read ${product} ${type} schema`, environment, liveWrites: false,
      sdkArgs: ["--env", environment, "--json", "schema", "full", product, "--type", type],
      source: "Implementation SDK + tenant API", resultType: "schema", type,
    };
  }
  if (/\b(products?|catalog)\b/.test(text) && /\b(list|show|read|what|available)\b/.test(text)) {
    return { kind: "tenant-read", label: `List products in ${environment}`, environment, liveWrites: false, sdkArgs: ["--env", environment, "--json", "products"], source: "Implementation SDK + tenant API", resultType: "json" };
  }
  if (/\bfeatures?\b/.test(text) && /\b(list|show|read|what|available)\b/.test(text)) {
    return { kind: "tenant-read", label: `List ${product} features`, environment, liveWrites: false, sdkArgs: ["--env", environment, "--json", "feature", "list", product], source: "Implementation SDK + tenant API", resultType: "json" };
  }
  if (/\b(explain|summari[sz]e|why|what does|follow up|based on|from that|those findings)\b/.test(text)) {
    return { kind: "answer", label: "Answer from task evidence", environment, liveWrites: false };
  }
  return { kind: "mutation", label: "Prepare implementation", environment, liveWrites: true };
}

function makePrompt(task, memories, mode, query, operation, conversation = []) {
  const memoryText = memories.length ? memories.map((item) => `- ${item.title}: ${item.detail} [${item.status}/${item.confidence}]`).join("\n") : "- No confirmed client memory yet.";
  const conversationText = conversation.slice(-10).map((message) => `${message.role}: ${message.content}`).join("\n");
  const common = `
You are the implementation agent inside a local Implementation Workbench.
Task: ${task.ticket} — ${task.title}
Client: ${task.client_name}
Product: ${task.product}
Target environment: ${operation.environment || task.environment}
Current request: ${query}

Recent conversation:
${conversationText || "- This is the first message."}

Confirmed client memory:
${memoryText}

The existing Insly Implementation SDK and its README are the source of truth. Never reveal credentials or tokens. Never change shell profiles, global packages, agent configuration, SDK source code, or terminal settings.
`;
  if (mode === "plan") return `${common}\nInspect the repository read-only. Create a concise executable plan for this classified operation: ${operation.kind} (${operation.label}). Do not number the text inside each step. Use no more than six steps. Do not claim the requested result has been retrieved yet. End with a JSON object containing keys summary, risk, steps, relevantMemory, and note.`;
  if (mode === "answer") return `${common}\nAnswer the current follow-up using only the supplied conversation and execution evidence. Clearly distinguish confirmed evidence from inference. Do not propose a new plan unless the user asked for a change.`;
  return `${common}\nThe user approved preparation inside the ticket working copy. You may edit only files under this ticket's work directory in the configured vault. Do not call live APIs, push, deploy, promote, rollback, generate live documents, or perform any tenant write. Finish with a plain-language summary of files changed, checks run, remaining risks, and the next approval required.`;
}

async function runLocalAgent(prompt, { write = false, workingRoot = null } = {}) {
  if (process.env.WORKBENCH_DISABLE_AGENT === "1" || process.env.WORKBENCH_DISABLE_CODEX === "1") throw new Error("Local planning agent is disabled for this process");
  if (!(await executable(LOCAL_AGENT_BIN))) throw new Error("The bundled local agent is unavailable");
  await mkdir(path.join(DATA_DIR, "runs"), { recursive: true, mode: 0o700 });
  const safeWorkingRoot = workingRoot || (write ? VAULT_ROOT : SDK_ROOT);
  const args = ["exec", "--ephemeral", "--ignore-user-config", "--color", "never", "--cd", safeWorkingRoot];
  if (write) args.push("--sandbox", "workspace-write", "--approve-for-me");
  else args.push("--sandbox", "read-only");
  args.push("-");
  return await new Promise((resolve, reject) => {
    const child = spawn(LOCAL_AGENT_BIN, args, { cwd: safeWorkingRoot, env: { ...process.env, INSLY_VAULT: VAULT_ROOT }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60 * 1000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", async (code) => {
      clearTimeout(timer);
      const output = redactSecrets(`${stdout}\n${stderr}`.trim());
      await writeFile(path.join(DATA_DIR, "runs", `${Date.now()}-${write ? "implement" : "read"}.log`), output, { mode: 0o600 });
      if (code === 0) resolve(output); else reject(new Error(output || `Local agent exited with status ${code}`));
    });
    child.stdin.end(prompt);
  });
}

function extractPlan(output, fallback) {
  const matches = String(output || "").match(/\{[\s\S]*\}/g);
  if (!matches) return { ...fallback, note: String(output || "").slice(-1200) || fallback.note };
  for (const candidate of matches.reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed.summary && Array.isArray(parsed.steps)) return { ...parsed, steps: parsed.steps.map(cleanStep).filter(Boolean), operation: fallback.operation };
    } catch { /* continue */ }
  }
  return { ...fallback, note: String(output || "").slice(-1200) || fallback.note };
}

function walkSchema(node, prefix = "", rows = []) {
  if (!node || typeof node !== "object") return rows;
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  for (const [name, child] of Object.entries(node.properties || {})) {
    const pathName = prefix ? `${prefix}.${name}` : name;
    rows.push({ path: pathName, type: child?.type || (child?.properties ? "object" : "unknown"), required: required.has(name), enumValues: Array.isArray(child?.enum) ? child.enum : [] });
    walkSchema(child, pathName, rows);
    if (child?.items) walkSchema(child.items, `${pathName}[]`, rows);
  }
  return rows;
}

function walkHidden(node, prefix = "", rows = []) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return rows;
  if (node["ui:widget"] === "hidden" && prefix) rows.push(prefix);
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("ui:")) continue;
    walkHidden(value, prefix ? `${prefix}.${key}` : key, rows);
  }
  return rows;
}

export function summarizeSdkOutput(task, operation, stdout, stderr = "") {
  const safeStdout = redactSecrets(stdout);
  if (operation.resultType !== "schema") {
    try {
      const parsed = JSON.parse(safeStdout);
      const size = Array.isArray(parsed) ? parsed.length : Object.keys(parsed || {}).length;
      return `I completed the read through the Implementation SDK.\n\n**What I found**\n\n- Source: ${operation.environment} tenant\n- Result entries: ${size}\n- No tenant data was changed.\n\nOpen the technical run below to inspect the complete response.`;
    } catch {
      return `I completed the read through the Implementation SDK.\n\n${safeStdout.slice(0, 5000)}\n\nNo tenant data was changed.`;
    }
  }
  const document = JSON.parse(safeStdout);
  const schema = document.scheme || document.schema || {};
  const ui = document.ui || {};
  const fields = walkSchema(schema);
  const required = fields.filter((field) => field.required).map((field) => field.path);
  const enums = fields.filter((field) => field.enumValues.length);
  const top = Object.keys(schema.properties || {});
  const hidden = walkHidden(ui);
  const definitions = Object.keys(schema.definitions || schema.$defs || {});
  const version = String(stderr).match(/\bv(\d+)\b/)?.[1] || document.version || document.schemeVersion || "not reported";
  const lines = [
    `I read the **${task.product.toLowerCase()}** ${operation.type || "policy"} schema from the **${operation.environment}** tenant through the Implementation SDK.`,
    "", "**What I found**", "",
    `- Schema version: ${version}`,
    `- Fields discovered: ${fields.length} across ${top.length} top-level sections`,
    `- Required fields: ${required.length}`,
    `- Enumerated fields: ${enums.length}`,
    `- Hidden UI fields: ${hidden.length}`,
    `- Reusable definitions: ${definitions.length}`,
    "", "**Top-level sections**", "",
    top.length ? top.map((name) => `\`${name}\``).join(", ") : "No top-level properties were returned.",
  ];
  if (required.length) lines.push("", "**Required fields**", "", required.slice(0, 24).map((name) => `\`${name}\``).join(", ") + (required.length > 24 ? `, plus ${required.length - 24} more` : ""));
  if (enums.length) lines.push("", "**Notable enumerations**", "", ...enums.slice(0, 12).map((field) => `- \`${field.path}\`: ${field.enumValues.slice(0, 8).map(String).join(", ")}${field.enumValues.length > 8 ? "…" : ""}`));
  if (hidden.length) lines.push("", "**Hidden UI fields**", "", hidden.slice(0, 16).map((name) => `\`${name}\``).join(", ") + (hidden.length > 16 ? `, plus ${hidden.length - 16} more` : ""));
  lines.push("", "No tenant configuration was changed. The complete SDK response is preserved in the technical run history.");
  return lines.join("\n");
}

function ensureMutationApproval(store, task, operation, query) {
  if (store.pendingApprovalForTask(task.id)) return;
  const approval = store.createApproval(task.id, "implement_local", { scope: "Ticket working copy only", liveWrites: false, sdkSourceChanges: false, query, operation });
  store.addEvent({ taskId: task.id, clientId: task.client_id, type: "approval", title: "Implementation approval required", detail: "Changes always pause for explicit approval, including Autopilot.", actor: "system" });
  store.addMessage({ taskId: task.id, role: "assistant", kind: "approval", content: "The plan is ready. This would change the ticket working copy, so I need your approval before continuing. No live tenant write is included.", metadata: { approvalId: approval.id, action: approval.action } });
}

export async function planTask(store, taskId, { query = null, allowAutopilot = true } = {}) {
  const task = store.task(taskId); const request = query || task.request;
  const memories = store.memoriesForClient(task.client_id); const messages = store.messagesForTask(taskId);
  const profile = store.providerProfile(task.provider_profile_id) || store.providerProfile("provider_local_agent");
  const operation = deriveOperation(task, request);
  const run = store.createRun(taskId, "plan", { provider: profile.provider, model: profile.model });
  store.addEvent({ taskId, clientId: task.client_id, type: "agent", title: "Analysis started", detail: `${profile.label}: ${operation.label}`, actor: "agent" });
  try {
    const fallback = fallbackPlan(task, memories, operation); let output; let plan; let meta = {};
    if (profile.provider === "local-agent") {
      output = await runLocalAgent(makePrompt(task, memories, "plan", request, operation, messages)); plan = extractPlan(output, fallback);
    } else {
      const result = await planWithProvider(profile, makePrompt(task, memories, "plan", request, operation, messages));
      plan = { ...result.plan, steps: result.plan.steps.map(cleanStep).filter(Boolean), operation }; output = result.raw; meta = { requestId: result.requestId, usage: result.usage };
    }
    store.setTaskPlan(taskId, plan, "ready"); store.finishRun(run.id, "complete", redactSecrets(output), meta);
    store.addEvent({ taskId, clientId: task.client_id, type: "plan", title: "Plan ready", detail: plan.summary, actor: "agent" });
    store.addMessage({ taskId, role: "assistant", kind: "plan", content: plan.summary, sources: ["Implementation SDK", "Client memory", "Task history"], metadata: { plan, operation } });
    if (task.execution_mode === "autopilot" && allowAutopilot) {
      if (operation.kind === "tenant-read") await executeReadTask(store, taskId, { query: request, operation });
      else if (operation.kind === "answer") await answerTask(store, taskId, request);
      else ensureMutationApproval(store, task, operation, request);
    }
  } catch (error) {
    const message = redactSecrets(String(error.message || error)); const plan = fallbackPlan(task, memories, operation);
    store.setTaskPlan(taskId, plan, "needs-attention"); store.finishRun(run.id, "failed", message);
    store.addEvent({ taskId, clientId: task.client_id, type: "error", title: "Analysis needs attention", detail: message.slice(-1200), actor: "system" });
    store.addMessage({ taskId, role: "assistant", kind: "error", content: `I could not complete the analysis. ${message.slice(-1400)}`, metadata: { retryable: true } });
  }
}

export async function executeReadTask(store, taskId, { query = null, operation = null } = {}) {
  const task = store.task(taskId); const selectedOperation = operation || task.plan?.operation || deriveOperation(task, query || task.request);
  if (selectedOperation.kind !== "tenant-read" || !Array.isArray(selectedOperation.sdkArgs)) throw new Error("The approved operation is not a supported tenant read");
  const run = store.createRun(taskId, "read", { provider: "implementation-sdk", model: "tenant-read" });
  store.setTaskStatus(taskId, "implementing");
  store.addEvent({ taskId, clientId: task.client_id, type: "source", title: selectedOperation.label, detail: `${selectedOperation.source} · ${selectedOperation.environment}`, actor: "agent" });
  store.addMessage({ taskId, role: "assistant", kind: "progress", content: `${selectedOperation.label}. I’ll report the confirmed findings here when the SDK returns.`, sources: ["Implementation SDK", `${selectedOperation.environment} tenant`], metadata: { operation: selectedOperation } });
  try {
    const credentialEnv = await credentialEnvironment(selectedOperation.environment);
    const result = await runSdk(selectedOperation.sdkArgs, { write: false, approved: true, extraEnv: credentialEnv, timeout: 180_000 });
    const raw = redactSecrets(`${result.stdout}${result.stderr ? `\n\n[stderr]\n${result.stderr}` : ""}`);
    const findings = summarizeSdkOutput(task, selectedOperation, result.stdout, result.stderr);
    store.finishRun(run.id, "complete", raw); store.setTaskStatus(taskId, "complete");
    store.addEvent({ taskId, clientId: task.client_id, type: "result", title: "Tenant read complete", detail: findings.slice(0, 1200), actor: "agent" });
    store.addMessage({ taskId, role: "assistant", kind: "result", content: findings, sources: ["Implementation SDK", `${selectedOperation.environment} tenant`], metadata: { operation: selectedOperation, runId: run.id } });
  } catch (error) {
    const message = redactSecrets(String(error.stderr || error.stdout || error.message || error));
    store.finishRun(run.id, "failed", message); store.setTaskStatus(taskId, "needs-attention");
    store.addEvent({ taskId, clientId: task.client_id, type: "error", title: "Tenant read needs attention", detail: message.slice(-1200), actor: "system" });
    store.addMessage({ taskId, role: "assistant", kind: "error", content: `I could not complete the tenant read. ${message.slice(-1800)}`, sources: ["Implementation SDK", `${selectedOperation.environment} tenant`], metadata: { retryable: true, operation: selectedOperation } });
  }
}

export async function answerTask(store, taskId, query) {
  const task = store.task(taskId); const memories = store.memoriesForClient(task.client_id); const messages = store.messagesForTask(taskId);
  const profile = store.providerProfile(task.provider_profile_id) || store.providerProfile("provider_local_agent");
  const evidence = store.runsForTask(taskId).filter((run) => run.status === "complete").slice(0, 3).map((run) => `${run.mode}: ${String(run.output || "").slice(0, 12000)}`).join("\n\n");
  const prompt = `${makePrompt(task, memories, "answer", query, { kind: "answer", label: "Answer from task evidence", environment: task.environment }, messages)}\n\nExecution evidence:\n${evidence || "No completed execution evidence is available yet."}`;
  const run = store.createRun(taskId, "chat", { provider: profile.provider, model: profile.model });
  store.setTaskStatus(taskId, "implementing");
  try {
    let answer; let meta = {};
    if (profile.provider === "local-agent") answer = await runLocalAgent(prompt);
    else {
      const result = await respondWithProvider(profile, prompt); answer = result.text; meta = { requestId: result.requestId, usage: result.usage };
    }
    answer = redactSecrets(answer || "I could not find enough evidence to answer that yet.");
    store.finishRun(run.id, "complete", answer, meta); store.setTaskStatus(taskId, "complete");
    store.addMessage({ taskId, role: "assistant", kind: "result", content: answer, sources: ["Task conversation", "Previous SDK runs", "Client memory"], metadata: { runId: run.id } });
  } catch (error) {
    const message = redactSecrets(String(error.message || error));
    store.finishRun(run.id, "failed", message); store.setTaskStatus(taskId, "needs-attention");
    store.addMessage({ taskId, role: "assistant", kind: "error", content: `I could not answer that follow-up. ${message.slice(-1400)}`, metadata: { retryable: true } });
  }
}

export async function followUpTask(store, taskId, content, { allowAutopilot = true } = {}) {
  const task = store.task(taskId); const query = String(content || "").trim();
  if (!task || !query) throw new Error("Task and follow-up message are required");
  store.addMessage({ taskId, role: "user", kind: "message", content: query });
  store.addEvent({ taskId, clientId: task.client_id, type: "request", title: "Follow-up requested", detail: query, actor: "user" });
  const operation = deriveOperation(task, query);
  if (operation.kind === "answer") return answerTask(store, taskId, query);
  if (operation.kind === "tenant-read") {
    const plan = fallbackPlan(task, store.memoriesForClient(task.client_id), operation);
    store.setTaskPlan(taskId, plan, "ready");
    store.addMessage({ taskId, role: "assistant", kind: "plan", content: plan.summary, sources: ["Implementation SDK", "Task context"], metadata: { plan, operation } });
    if (task.execution_mode === "autopilot" && allowAutopilot) return executeReadTask(store, taskId, { query, operation });
    return;
  }
  store.setTaskStatus(taskId, "planning");
  return planTask(store, taskId, { query, allowAutopilot });
}

export async function executePlannedTask(store, taskId) {
  const task = store.task(taskId); const operation = task.plan?.operation || deriveOperation(task, task.request);
  if (operation.kind === "tenant-read") return executeReadTask(store, taskId, { operation });
  if (operation.kind === "answer") return answerTask(store, taskId, task.request);
  return implementTask(store, taskId);
}

export async function implementTask(store, taskId) {
  const task = store.task(taskId); const memories = store.memoriesForClient(task.client_id); const messages = store.messagesForTask(taskId);
  const run = store.createRun(taskId, "implement", { provider: "local-agent", model: "private" });
  store.setTaskStatus(taskId, "implementing");
  store.addEvent({ taskId, clientId: task.client_id, type: "agent", title: "Local implementation started", detail: "Live tenant writes remain blocked", actor: "agent" });
  store.addMessage({ taskId, role: "assistant", kind: "progress", content: "I’m preparing the approved change inside the ticket working copy. Live tenant writes remain blocked.", sources: ["Implementation SDK", "Ticket working copy"] });
  try {
    const credentialEnv = await credentialEnvironment(task.environment);
    await runSdk(["--env", task.environment, "task", "start", task.ticket, "--product", task.product.toLowerCase()], { write: true, approved: true, extraEnv: credentialEnv, timeout: 180_000 });
    store.addEvent({ taskId, clientId: task.client_id, type: "baseline", title: "Ticket baseline initialized", detail: `${task.product.toLowerCase()} · ${task.environment}`, actor: "system" });
    const ticketWorkRoot = path.join(VAULT_ROOT, "50-Tasks", task.ticket, "work");
    await access(ticketWorkRoot, constants.R_OK | constants.W_OK);
    const output = await runLocalAgent(makePrompt(task, memories, "implement", messages.at(-1)?.content || task.request, { kind: "mutation", label: "Prepare implementation", environment: task.environment }, messages), { write: true, workingRoot: ticketWorkRoot });
    store.finishRun(run.id, "complete", output); store.setTaskStatus(taskId, "review");
    store.addEvent({ taskId, clientId: task.client_id, type: "implementation", title: "Working copy updated", detail: output.slice(-1200), actor: "agent" });
    store.addMessage({ taskId, role: "assistant", kind: "result", content: output, sources: ["Implementation SDK", "Ticket working copy", "Local checks"], metadata: { runId: run.id } });
  } catch (error) {
    const message = redactSecrets(String(error.stderr || error.stdout || error.message || error)); store.finishRun(run.id, "failed", message); store.setTaskStatus(taskId, "needs-attention");
    store.addEvent({ taskId, clientId: task.client_id, type: "error", title: "Implementation needs attention", detail: message.slice(-1200), actor: "system" });
    store.addMessage({ taskId, role: "assistant", kind: "error", content: `I could not complete the approved local implementation. ${message.slice(-1800)}`, metadata: { retryable: true } });
  }
}
