import http from "node:http";
import { ACTOR_ID, ACTOR_NAME, ACTOR_ROLE, BRIDGE_HOST, BRIDGE_PORT, ALLOWED_ORIGINS, REQUIRE_SEPARATE_REVIEW } from "./config.mjs";
import { store } from "./db.mjs";
import { planTask, implementTask } from "./agent-runner.mjs";
import { probeSdk } from "./sdk-adapter.mjs";
import { listTenants, saveTenantCredential, testTenantConnection } from "./tenants.mjs";
import { publicProfile, publicProfiles, saveProviderCredential, testProvider } from "./providers.mjs";
import { PROVIDER_DEFINITIONS, publicProviderDefinitions } from "./provider-core.mjs";
import { assertRole } from "./policy.mjs";

function corsHeaders(origin) {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, x-workbench-intent", vary: "Origin" };
}
function send(res, status, payload, origin) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...corsHeaders(origin) });
  res.end(JSON.stringify(payload));
}
async function body(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) throw new Error("Request body is too large"); }
  return raw ? JSON.parse(raw) : {};
}
function requireWriteIntent(req) {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) throw new Error("Origin is not allowed");
  if (req.headers["x-workbench-intent"] !== "ui") throw new Error("Missing write intent header");
}
function without(value, keys) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders(origin)); return res.end(); }
    const url = new URL(req.url, `http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
    if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { ok: true, system: await probeSdk(), database: store.path }, origin);
    if (req.method === "GET" && url.pathname === "/api/bootstrap") {
      const snapshot = store.bootstrap();
      const tasks = snapshot.tasks.map((task) => without(task, ["planning_model"]));
      const runs = snapshot.runs.map((run) => without(run, ["provider", "model", "request_id", "usage_json"]));
      const approvals = snapshot.approvals.map((approval) => ({ ...approval, payload: { scope: approval.payload.scope, liveWrites: approval.payload.liveWrites } }));
      return send(res, 200, { ...snapshot, tasks, runs, approvals, providers: await publicProfiles(snapshot.providers), providerDefinitions: publicProviderDefinitions(), system: await probeSdk(), tenants: await listTenants(snapshot.connections) }, origin);
    }
    if (req.method === "POST" && url.pathname === "/api/providers") {
      requireWriteIntent(req); assertRole(ACTOR_ROLE, "manage_providers"); const input = await body(req);
      if (!["connector-a", "connector-b"].includes(input.provider)) return send(res, 400, { error: "Choose an available planning connector" }, origin);
      if (!input.label?.trim() || !input.apiKey) return send(res, 400, { error: "Connector label and API key are required" }, origin);
      const profile = store.createProviderProfile({ ...input, model: PROVIDER_DEFINITIONS[input.provider].defaultModel });
      try {
        await saveProviderCredential(profile.id, input.apiKey);
        store.addEvent({ type: "provider", title: "Planning connector connected", detail: profile.label, actor: ACTOR_NAME, actorId: ACTOR_ID });
        return send(res, 201, await publicProfile(profile), origin);
      } catch (error) {
        store.setProviderStatus(profile.id, "error", String(error.message || error).slice(0, 500));
        return send(res, 500, { error: `Profile created, but the API key could not be stored: ${String(error.message || error)}` }, origin);
      }
    }
    const providerTestMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/test$/);
    if (req.method === "POST" && providerTestMatch) {
      requireWriteIntent(req); assertRole(ACTOR_ROLE, "manage_providers"); const profile = store.providerProfile(providerTestMatch[1]);
      if (!profile) return send(res, 404, { error: "Provider profile not found" }, origin);
      try { const result = await testProvider(profile); store.setProviderStatus(profile.id, "connected"); return send(res, 200, { ...result, label: profile.label }, origin); }
      catch (error) { store.setProviderStatus(profile.id, "failed", String(error.message || error).slice(0, 500)); return send(res, 400, { error: String(error.message || error) }, origin); }
    }
    const credentialMatch = url.pathname.match(/^\/api\/tenants\/([^/]+)\/credential$/);
    if (req.method === "POST" && credentialMatch) {
      requireWriteIntent(req); assertRole(ACTOR_ROLE, "manage_tenants"); const input = await body(req); const envName = decodeURIComponent(credentialMatch[1]);
      if (typeof input.password !== "string" || !input.password) return send(res, 400, { error: "Enter the tenant password" }, origin);
      const result = await saveTenantCredential(envName, input.password);
      store.addEvent({ type: "connection", title: "Tenant credential connected", detail: `${envName}: macOS Keychain (${result.covers.length} environment${result.covers.length === 1 ? "" : "s"})`, actor: "user" });
      return send(res, 200, result, origin);
    }
    const testMatch = url.pathname.match(/^\/api\/tenants\/([^/]+)\/test$/);
    if (req.method === "POST" && testMatch) {
      requireWriteIntent(req); assertRole(ACTOR_ROLE, "test_connections"); const envName = decodeURIComponent(testMatch[1]);
      try {
        const result = await testTenantConnection(envName);
        store.setTenantConnection(envName, { status: "connected", source: result.source });
        store.addEvent({ type: "connection", title: "Tenant connection verified", detail: envName, actor: "system" });
        return send(res, 200, result, origin);
      } catch (error) {
        store.setTenantConnection(envName, { status: "failed", error: String(error.message || error).slice(0, 700) });
        return send(res, 400, { error: String(error.message || error) }, origin);
      }
    }
    if (req.method === "POST" && url.pathname === "/api/clients") {
      requireWriteIntent(req); assertRole(ACTOR_ROLE, "manage_clients"); const input = await body(req);
      if (!input.name?.trim()) return send(res, 400, { error: "Client name is required" }, origin);
      return send(res, 201, store.createClient(input), origin);
    }
    if (req.method === "POST" && url.pathname === "/api/memories") {
      requireWriteIntent(req); assertRole(ACTOR_ROLE, "create_memory"); const input = await body(req);
      if (!input.clientId || !input.title?.trim() || !input.detail?.trim()) return send(res, 400, { error: "Client, title, and detail are required" }, origin);
      return send(res, 201, store.createMemory(input), origin);
    }
    if (req.method === "POST" && url.pathname === "/api/tasks") {
      requireWriteIntent(req); assertRole(ACTOR_ROLE, "create_task"); const input = await body(req);
      if (!input.clientId || !input.ticket?.trim() || !input.request?.trim() || !input.product?.trim()) return send(res, 400, { error: "Client, ticket, product, and request are required" }, origin);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,80}$/.test(input.ticket.trim())) return send(res, 400, { error: "Ticket may contain only letters, numbers, dots, underscores, and hyphens" }, origin);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(input.product.trim())) return send(res, 400, { error: "Product must be a safe product slug" }, origin);
      if (!store.client(input.clientId)) return send(res, 404, { error: "Client not found" }, origin);
      if (input.providerProfileId && !store.providerProfile(input.providerProfileId)) return send(res, 400, { error: "Planning provider is not available" }, origin);
      const availableTenants = await listTenants(store.bootstrap().connections);
      if (!availableTenants.some((item) => item.name === input.environment)) return send(res, 400, { error: "Choose a configured tenant environment" }, origin);
      const task = store.createTask(input); void planTask(store, task.id); return send(res, 202, task, origin);
    }
    const implementMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/request-implementation$/);
    if (req.method === "POST" && implementMatch) {
      requireWriteIntent(req); assertRole(ACTOR_ROLE, "request_implementation"); const task = store.task(implementMatch[1]);
      if (!task) return send(res, 404, { error: "Task not found" }, origin);
      if (task.status !== "ready") return send(res, 409, { error: "The task must have a completed plan before implementation can be requested" }, origin);
      const existingApproval = store.pendingApprovalForTask(task.id);
      if (existingApproval) return send(res, 409, { error: "This task already has a pending implementation approval" }, origin);
      const approval = store.createApproval(task.id, "implement_local", { scope: "Ticket working copy only", liveWrites: false, sdkSourceChanges: false });
      store.addEvent({ taskId: task.id, clientId: task.client_id, type: "approval", title: "Local implementation approval requested", detail: "No live deployment is included", actor: "system" });
      return send(res, 201, approval, origin);
    }
    const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/(approve|reject)$/);
    if (req.method === "POST" && approvalMatch) {
      requireWriteIntent(req); assertRole(ACTOR_ROLE, "resolve_approval"); const approval = store.approval(approvalMatch[1]);
      if (!approval) return send(res, 404, { error: "Approval not found" }, origin);
      if (approval.status !== "pending") return send(res, 409, { error: "Approval has already been resolved" }, origin);
      const currentSnapshot = store.taskSnapshot(approval.task_id);
      if (approvalMatch[2] === "approve" && approval.snapshot_hash !== currentSnapshot.hash) { store.resolveApproval(approval.id, "stale"); return send(res, 409, { error: "The task or client memory changed after this approval was requested. Review the new snapshot and request approval again." }, origin); }
      if (approvalMatch[2] === "approve" && REQUIRE_SEPARATE_REVIEW && approval.requested_by === ACTOR_ID) return send(res, 403, { error: "A different reviewer must approve this action" }, origin);
      const decision = approvalMatch[2] === "approve" ? "approved" : "rejected"; const updated = store.resolveApproval(approval.id, decision); const task = store.task(approval.task_id);
      store.addEvent({ taskId: task.id, clientId: task.client_id, type: "approval", title: `Action ${decision}`, detail: approval.action, actor: "user" });
      if (decision === "approved" && approval.action === "implement_local") void implementTask(store, task.id);
      return send(res, 200, updated, origin);
    }
    return send(res, 404, { error: "Not found" }, origin);
  } catch (error) { return send(res, Number(error.statusCode || 500), { error: String(error.message || error) }, origin); }
});

server.listen(BRIDGE_PORT, BRIDGE_HOST, () => { process.stdout.write(`Implementation Workbench bridge: http://${BRIDGE_HOST}:${BRIDGE_PORT}\n`); });
