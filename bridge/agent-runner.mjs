import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DATA_DIR, LOCAL_AGENT_BIN, SDK_ROOT, VAULT_ROOT } from "./config.mjs";
import { runSdk } from "./sdk-adapter.mjs";
import { credentialEnvironment } from "./tenants.mjs";
import { planWithProvider } from "./providers.mjs";
import { redactSecrets } from "./policy.mjs";

async function executable(target) { try { await access(target, constants.X_OK); return true; } catch { return false; } }

function fallbackPlan(task, memories) {
  return {
    summary: `Prepare ${task.ticket} for ${task.product} in ${task.environment}, using the existing SDK task workflow.`,
    risk: task.environment === "beta" ? "medium" : "high",
    steps: [
      "Retrieve the current product state and create an immutable baseline.",
      "Apply the requested change only to the task working copy.",
      "Inspect related schema, UI, autocomplete, and feature surfaces.",
      "Run the deterministic review gate and relevant regression tests.",
      "Present the exact diff for approval before any live write.",
    ],
    relevantMemory: memories.map((memory) => memory.title),
    note: "The local planner was unavailable, so this safe deterministic plan was created locally.",
  };
}

function makePrompt(task, memories, mode) {
  const memoryText = memories.length ? memories.map((item) => `- ${item.title}: ${item.detail} [${item.status}/${item.confidence}]`).join("\n") : "- No confirmed client memory yet.";
  const common = `
You are the implementation agent inside a local Implementation Workbench.
Task: ${task.ticket} — ${task.title}
Client: ${task.client_name}
Product: ${task.product}
Target environment: ${task.environment}
Request: ${task.request}

Confirmed client memory:
${memoryText}

The existing Insly Implementation SDK and its README are the source of truth. Never reveal credentials or tokens. Never change shell profiles, global packages, agent configuration, SDK source code, or terminal settings.
`;
  if (mode === "plan") return `${common}\nInspect the repository read-only. Do not create, edit, or delete files and do not call live APIs. Produce a concise implementation plan with: summary, affected surfaces, relevant prior decisions, risks, tests, and the exact approval boundary. End with a JSON object containing keys summary, risk, steps, relevantMemory, and note.`;
  return `${common}\nThe user has approved LOCAL IMPLEMENTATION only. The bridge has already initialized this ticket's baseline and work copies. You may edit only files under this ticket's work directory in the configured vault. Do not call live APIs, push, deploy, promote, rollback, generate live documents, or perform any live write. Use offline SDK review and relevant local tests where possible. Finish with a plain-language summary of files changed, checks run, remaining risks, and the next approval required.`;
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
      await writeFile(path.join(DATA_DIR, "runs", `${Date.now()}-${write ? "implement" : "plan"}.log`), output, { mode: 0o600 });
      if (code === 0) resolve(output); else reject(new Error(output || `Local agent exited with status ${code}`));
    });
    child.stdin.end(prompt);
  });
}

function extractPlan(output, fallback) {
  const matches = output.match(/\{[\s\S]*\}/g);
  if (!matches) return { ...fallback, note: output.slice(-1200) || fallback.note };
  for (const candidate of matches.reverse()) {
    try { const parsed = JSON.parse(candidate); if (parsed.summary && Array.isArray(parsed.steps)) return parsed; } catch { /* continue */ }
  }
  return { ...fallback, note: output.slice(-1200) || fallback.note };
}

export async function planTask(store, taskId) {
  const task = store.task(taskId); const memories = store.memoriesForClient(task.client_id); const profile = store.providerProfile(task.provider_profile_id) || store.providerProfile("provider_local_agent");
  const run = store.createRun(taskId, "plan", { provider: profile.provider, model: profile.model });
  store.addEvent({ taskId, clientId: task.client_id, type: "agent", title: "Planning started", detail: profile.label, actor: "agent" });
  try {
    const fallback = fallbackPlan(task, memories); let output; let plan; let meta = {};
    if (profile.provider === "local-agent") {
      output = await runLocalAgent(makePrompt(task, memories, "plan")); plan = extractPlan(output, fallback);
    } else {
      const result = await planWithProvider(profile, makePrompt(task, memories, "plan")); plan = result.plan; output = result.raw; meta = { requestId: result.requestId, usage: result.usage };
    }
    store.setTaskPlan(taskId, plan, "ready"); store.finishRun(run.id, "complete", redactSecrets(output), meta);
    store.addEvent({ taskId, clientId: task.client_id, type: "plan", title: "Implementation plan ready", detail: plan.summary, actor: "agent" });
  } catch (error) {
    const plan = fallbackPlan(task, memories); store.setTaskPlan(taskId, plan, "ready"); store.finishRun(run.id, "fallback", String(error.message || error));
    store.addEvent({ taskId, clientId: task.client_id, type: "plan", title: "Safe local plan ready", detail: plan.summary, actor: "system" });
  }
}

export async function implementTask(store, taskId) {
  const task = store.task(taskId); const memories = store.memoriesForClient(task.client_id); const run = store.createRun(taskId, "implement", { provider: "local-agent", model: "private" });
  store.setTaskStatus(taskId, "implementing");
  store.addEvent({ taskId, clientId: task.client_id, type: "agent", title: "Local implementation started", detail: "Live deployment remains blocked", actor: "agent" });
  try {
    const credentialEnv = await credentialEnvironment(task.environment);
    await runSdk(["--env", task.environment, "task", "start", task.ticket, "--product", task.product], { write: true, approved: true, extraEnv: credentialEnv, timeout: 180_000 });
    store.addEvent({ taskId, clientId: task.client_id, type: "baseline", title: "Ticket baseline initialized", detail: `${task.product} · ${task.environment}`, actor: "system" });
    const ticketWorkRoot = path.join(VAULT_ROOT, "50-Tasks", task.ticket, "work");
    await access(ticketWorkRoot, constants.R_OK | constants.W_OK);
    const output = await runLocalAgent(makePrompt(task, memories, "implement"), { write: true, workingRoot: ticketWorkRoot });
    store.finishRun(run.id, "complete", output); store.setTaskStatus(taskId, "review");
    store.addEvent({ taskId, clientId: task.client_id, type: "implementation", title: "Working copy updated", detail: output.slice(-1200), actor: "agent" });
  } catch (error) {
    const message = String(error.message || error); store.finishRun(run.id, "failed", message); store.setTaskStatus(taskId, "needs-attention");
    store.addEvent({ taskId, clientId: task.client_id, type: "error", title: "Implementation needs attention", detail: message.slice(-1200), actor: "system" });
  }
}
