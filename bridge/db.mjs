import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "./config.mjs";
import { ACTOR_ID, ACTOR_NAME, ACTOR_ROLE } from "./config.mjs";
import { snapshotHash } from "./policy.mjs";

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const databasePath = path.join(DATA_DIR, "workbench.sqlite");
const db = new DatabaseSync(databasePath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    vault_path TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed',
    source TEXT NOT NULL DEFAULT 'user',
    confidence TEXT NOT NULL DEFAULT 'confirmed',
    supersedes_id TEXT REFERENCES memories(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    ticket TEXT NOT NULL,
    title TEXT NOT NULL,
    request TEXT NOT NULL,
    product TEXT NOT NULL,
    environment TEXT NOT NULL,
    status TEXT NOT NULL,
    risk TEXT NOT NULL DEFAULT 'unknown',
    plan_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    output TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'message',
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'complete',
    source_json TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tenant_connections (
    env_name TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    source TEXT,
    last_checked_at TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS provider_profiles (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    label TEXT NOT NULL,
    model TEXT NOT NULL,
    project_id TEXT,
    workspace_id TEXT,
    scope TEXT NOT NULL DEFAULT 'personal',
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'unverified',
    last_tested_at TEXT,
    last_error TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS team_members (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_client_status ON tasks(client_id, status);
  CREATE INDEX IF NOT EXISTS idx_memories_client_status ON memories(client_id, status);
  CREATE INDEX IF NOT EXISTS idx_events_task_created ON events(task_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_approvals_task_status ON approvals(task_id, status);
  CREATE INDEX IF NOT EXISTS idx_chat_messages_task_created ON chat_messages(task_id, created_at);
`);

function ensureColumn(table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

ensureColumn("memories", "scope_product", "TEXT");
ensureColumn("memories", "scope_environment", "TEXT");
ensureColumn("memories", "effective_from", "TEXT");
ensureColumn("memories", "revision", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("memories", "created_by", "TEXT NOT NULL DEFAULT 'local-user'");
ensureColumn("tasks", "provider_profile_id", "TEXT");
ensureColumn("tasks", "planning_model", "TEXT");
ensureColumn("tasks", "memory_snapshot_json", "TEXT");
ensureColumn("tasks", "execution_mode", "TEXT NOT NULL DEFAULT 'review'");
ensureColumn("approvals", "snapshot_hash", "TEXT");
ensureColumn("approvals", "requested_by", "TEXT");
ensureColumn("approvals", "resolved_by", "TEXT");
ensureColumn("agent_runs", "provider", "TEXT");
ensureColumn("agent_runs", "model", "TEXT");
ensureColumn("agent_runs", "request_id", "TEXT");
ensureColumn("agent_runs", "usage_json", "TEXT");
ensureColumn("events", "actor_id", "TEXT");
db.exec("PRAGMA optimize");

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${randomUUID()}`;
const slugify = (value) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

for (const task of db.prepare("SELECT * FROM tasks WHERE NOT EXISTS (SELECT 1 FROM chat_messages WHERE chat_messages.task_id = tasks.id)").all()) {
  db.prepare("INSERT INTO chat_messages (id, task_id, role, kind, content, status, source_json, metadata_json, created_at) VALUES (?, ?, 'user', 'request', ?, 'complete', '[]', '{}', ?)")
    .run(id("message"), task.id, task.request, task.created_at);
  if (task.plan_json) {
    const plan = JSON.parse(task.plan_json);
    db.prepare("INSERT INTO chat_messages (id, task_id, role, kind, content, status, source_json, metadata_json, created_at) VALUES (?, ?, 'assistant', 'plan', ?, 'complete', ?, ?, ?)")
      .run(id("message"), task.id, plan.summary || "Plan ready", JSON.stringify(["Task history"]), JSON.stringify({ plan, operation: plan.operation || null }), task.updated_at);
  }
}

const count = db.prepare("SELECT COUNT(*) AS count FROM clients").get().count;
if (count === 0) {
  db.prepare("INSERT INTO clients (id, name, slug, vault_path, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id("client"), "Current client", "current-client", null, now());
}

db.prepare(`INSERT OR IGNORE INTO provider_profiles
  (id, provider, label, model, scope, enabled, status, created_by, created_at, updated_at)
  VALUES ('provider_local_agent', 'local-agent', 'Local implementation agent', 'private', 'personal', 1, 'connected', ?, ?, ?)`)
  .run(ACTOR_ID, now(), now());
db.prepare("UPDATE events SET detail = substr(detail, 1, instr(detail, ' · ') - 1) WHERE title = 'Planning started' AND instr(detail, ' · ') > 0").run();
db.prepare("INSERT OR IGNORE INTO team_members (id, display_name, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)")
  .run(ACTOR_ID, ACTOR_NAME, ACTOR_ROLE, now(), now());

function parseTask(row) {
  if (!row) return null;
  return { ...row, plan: row.plan_json ? JSON.parse(row.plan_json) : null, memory_snapshot: row.memory_snapshot_json ? JSON.parse(row.memory_snapshot_json) : null };
}

function parseMessage(row) {
  if (!row) return null;
  return {
    ...row,
    sources: row.source_json ? JSON.parse(row.source_json) : [],
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
  };
}

export const store = {
  path: databasePath,
  bootstrap() {
    const clients = db.prepare("SELECT * FROM clients ORDER BY created_at ASC").all();
    const tasks = db.prepare(`
      SELECT tasks.*, clients.name AS client_name
      FROM tasks JOIN clients ON clients.id = tasks.client_id
      ORDER BY tasks.updated_at DESC
    `).all().map(parseTask);
    const memories = db.prepare(`
      SELECT memories.*, clients.name AS client_name
      FROM memories JOIN clients ON clients.id = memories.client_id
      ORDER BY memories.updated_at DESC
    `).all();
    const events = db.prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT 200").all();
    const approvals = db.prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100").all().map((row) => ({
      ...row,
      payload: JSON.parse(row.payload_json),
    }));
    const runs = db.prepare("SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT 100").all();
    const messages = db.prepare("SELECT * FROM chat_messages ORDER BY created_at ASC LIMIT 1000").all().map(parseMessage);
    const connections = db.prepare("SELECT * FROM tenant_connections ORDER BY env_name ASC").all();
    const providers = db.prepare("SELECT * FROM provider_profiles WHERE enabled = 1 ORDER BY created_at ASC").all();
    const members = db.prepare("SELECT * FROM team_members WHERE active = 1 ORDER BY created_at ASC").all();
    return { clients, tasks, memories, events, approvals, runs, messages, connections, providers, members, currentActor: { id: ACTOR_ID, name: ACTOR_NAME, role: ACTOR_ROLE } };
  },
  client(clientId) {
    return db.prepare("SELECT * FROM clients WHERE id = ?").get(clientId);
  },
  createClient({ name }) {
    const created = { id: id("client"), name: name.trim(), slug: slugify(name), vault_path: null, created_at: now() };
    db.prepare("INSERT INTO clients (id, name, slug, vault_path, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(created.id, created.name, created.slug, created.vault_path, created.created_at);
    return created;
  },
  task(taskId) {
    return parseTask(db.prepare(`
      SELECT tasks.*, clients.name AS client_name
      FROM tasks JOIN clients ON clients.id = tasks.client_id
      WHERE tasks.id = ?
    `).get(taskId));
  },
  memoriesForClient(clientId) {
    return db.prepare("SELECT * FROM memories WHERE client_id = ? AND status != 'superseded' ORDER BY updated_at DESC").all(clientId);
  },
  providerProfiles() {
    return db.prepare("SELECT * FROM provider_profiles WHERE enabled = 1 ORDER BY created_at ASC").all();
  },
  providerProfile(profileId) {
    return db.prepare("SELECT * FROM provider_profiles WHERE id = ? AND enabled = 1").get(profileId);
  },
  createProviderProfile(input) {
    const stamp = now(); const profile = {
      id: id("provider"), provider: input.provider, label: input.label.trim(), model: input.model.trim(),
      project_id: input.projectId?.trim() || null, workspace_id: input.workspaceId?.trim() || null,
      scope: input.scope || "personal", enabled: 1, status: "unverified", last_tested_at: null, last_error: null,
      created_by: ACTOR_ID, created_at: stamp, updated_at: stamp,
    };
    db.prepare(`INSERT INTO provider_profiles (id, provider, label, model, project_id, workspace_id, scope, enabled, status, last_tested_at, last_error, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(profile.id, profile.provider, profile.label, profile.model, profile.project_id, profile.workspace_id, profile.scope, profile.enabled, profile.status, profile.last_tested_at, profile.last_error, profile.created_by, profile.created_at, profile.updated_at);
    return profile;
  },
  setProviderStatus(profileId, status, error = null) {
    db.prepare("UPDATE provider_profiles SET status = ?, last_tested_at = ?, last_error = ?, updated_at = ? WHERE id = ?").run(status, now(), error, now(), profileId);
    return this.providerProfile(profileId);
  },
  setProviderModel(profileId, model) {
    db.prepare("UPDATE provider_profiles SET model = ?, updated_at = ? WHERE id = ?").run(model, now(), profileId);
    return this.providerProfile(profileId);
  },
  createTask(input) {
    const stamp = now();
    const created = {
      id: id("task"), client_id: input.clientId, ticket: input.ticket.trim(),
      title: input.title.trim() || input.request.trim().slice(0, 72), request: input.request.trim(),
      product: input.product.trim(), environment: input.environment, status: "planning", risk: "unknown",
      provider_profile_id: input.providerProfileId || "provider_local_agent", planning_model: input.planningModel || null,
      execution_mode: input.executionMode === "autopilot" ? "autopilot" : "review",
      plan_json: null, memory_snapshot_json: null, created_at: stamp, updated_at: stamp,
    };
    db.prepare(`
      INSERT INTO tasks (id, client_id, ticket, title, request, product, environment, status, risk, provider_profile_id, planning_model, execution_mode, plan_json, memory_snapshot_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(created.id, created.client_id, created.ticket, created.title, created.request, created.product, created.environment, created.status, created.risk, created.provider_profile_id, created.planning_model, created.execution_mode, created.plan_json, created.memory_snapshot_json, created.created_at, created.updated_at);
    this.addEvent({ taskId: created.id, clientId: created.client_id, type: "request", title: "Implementation requested", detail: created.request, actor: "user" });
    this.addMessage({ taskId: created.id, role: "user", kind: "request", content: created.request, sources: [], metadata: { ticket: created.ticket } });
    this.addEvent({ taskId: created.id, clientId: created.client_id, type: "mode", title: created.execution_mode === "autopilot" ? "Autopilot authorized" : "Plan review required", detail: created.execution_mode === "autopilot" ? "Analyze, plan, and update the local ticket working copy. Live writes remain blocked." : "Stop after planning until the user approves local execution.", actor: "user" });
    return parseTask(created);
  },
  setTaskPlan(taskId, plan, status = "ready") {
    db.prepare("UPDATE tasks SET plan_json = ?, risk = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(plan), plan.risk || "unknown", status, now(), taskId);
    return this.task(taskId);
  },
  setTaskStatus(taskId, status) {
    db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), taskId);
  },
  setTaskSettings(taskId, input) {
    const task = this.task(taskId);
    if (!task) return null;
    const providerId = input.providerProfileId || task.provider_profile_id;
    const executionMode = input.executionMode === "autopilot" ? "autopilot" : input.executionMode === "review" ? "review" : task.execution_mode;
    db.prepare("UPDATE tasks SET provider_profile_id = ?, execution_mode = ?, updated_at = ? WHERE id = ?")
      .run(providerId, executionMode, now(), taskId);
    return this.task(taskId);
  },
  createMemory(input) {
    const stamp = now();
    const superseded = input.supersedesId ? db.prepare("SELECT * FROM memories WHERE id = ? AND client_id = ?").get(input.supersedesId, input.clientId) : null;
    if (input.supersedesId && !superseded) throw new Error("The memory being revised was not found for this client");
    const created = {
      id: id("memory"), client_id: input.clientId, title: input.title.trim(), detail: input.detail.trim(),
      status: input.status || "confirmed", source: input.source || "user", confidence: input.confidence || "confirmed",
      supersedes_id: input.supersedesId || null, scope_product: input.scopeProduct?.trim() || null,
      scope_environment: input.scopeEnvironment?.trim() || null, effective_from: input.effectiveFrom || stamp,
      revision: superseded ? Number(superseded.revision || 1) + 1 : 1, created_by: ACTOR_ID, created_at: stamp, updated_at: stamp,
    };
    if (created.supersedes_id) db.prepare("UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ? AND client_id = ?").run(stamp, created.supersedes_id, created.client_id);
    db.prepare(`
      INSERT INTO memories (id, client_id, title, detail, status, source, confidence, supersedes_id, scope_product, scope_environment, effective_from, revision, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(created.id, created.client_id, created.title, created.detail, created.status, created.source, created.confidence, created.supersedes_id, created.scope_product, created.scope_environment, created.effective_from, created.revision, created.created_by, created.created_at, created.updated_at);
    this.addEvent({ clientId: created.client_id, type: "memory", title: "Client memory added", detail: created.title, actor: "user" });
    return created;
  },
  addEvent(input) {
    const created = { id: id("event"), task_id: input.taskId || null, client_id: input.clientId || null, type: input.type, title: input.title, detail: input.detail || "", actor: input.actor || ACTOR_NAME, actor_id: input.actorId || ACTOR_ID, created_at: now() };
    db.prepare("INSERT INTO events (id, task_id, client_id, type, title, detail, actor, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(created.id, created.task_id, created.client_id, created.type, created.title, created.detail, created.actor, created.actor_id, created.created_at);
    return created;
  },
  addMessage(input) {
    const created = {
      id: id("message"), task_id: input.taskId, role: input.role,
      kind: input.kind || "message", content: String(input.content || ""),
      status: input.status || "complete", source_json: JSON.stringify(input.sources || []),
      metadata_json: JSON.stringify(input.metadata || {}), created_at: now(),
    };
    db.prepare("INSERT INTO chat_messages (id, task_id, role, kind, content, status, source_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(created.id, created.task_id, created.role, created.kind, created.content, created.status, created.source_json, created.metadata_json, created.created_at);
    db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(created.created_at, created.task_id);
    return parseMessage(created);
  },
  messagesForTask(taskId) {
    return db.prepare("SELECT * FROM chat_messages WHERE task_id = ? ORDER BY created_at ASC").all(taskId).map(parseMessage);
  },
  runsForTask(taskId) {
    return db.prepare("SELECT * FROM agent_runs WHERE task_id = ? ORDER BY started_at DESC").all(taskId);
  },
  taskSnapshot(taskId) {
    const task = this.task(taskId); const memories = this.memoriesForClient(task.client_id);
    const snapshot = { task: { id: task.id, request: task.request, product: task.product, environment: task.environment, plan: task.plan }, memories: memories.map((item) => ({ id: item.id, revision: item.revision, updated_at: item.updated_at, status: item.status })) };
    return { snapshot, hash: snapshotHash(snapshot) };
  },
  createApproval(taskId, action, payload) {
    const current = this.taskSnapshot(taskId); const created = { id: id("approval"), task_id: taskId, action, payload_json: JSON.stringify({ ...payload, snapshot: current.snapshot }), snapshot_hash: current.hash, requested_by: ACTOR_ID, status: "pending", created_at: now(), resolved_at: null };
    db.prepare("INSERT INTO approvals (id, task_id, action, payload_json, snapshot_hash, requested_by, status, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(created.id, created.task_id, created.action, created.payload_json, created.snapshot_hash, created.requested_by, created.status, created.created_at, created.resolved_at);
    return { ...created, payload };
  },
  pendingApprovalForTask(taskId) {
    const row = db.prepare("SELECT * FROM approvals WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(taskId);
    return row ? { ...row, payload: JSON.parse(row.payload_json) } : null;
  },
  approval(approvalId) {
    const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId);
    return row ? { ...row, payload: JSON.parse(row.payload_json) } : null;
  },
  resolveApproval(approvalId, status) {
    db.prepare("UPDATE approvals SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?").run(status, now(), ACTOR_ID, approvalId);
    return this.approval(approvalId);
  },
  createRun(taskId, mode, meta = {}) {
    const created = { id: id("run"), task_id: taskId, mode, status: "running", output: null, provider: meta.provider || null, model: meta.model || null, request_id: null, usage_json: null, started_at: now(), completed_at: null };
    db.prepare("INSERT INTO agent_runs (id, task_id, mode, status, output, provider, model, request_id, usage_json, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(created.id, created.task_id, created.mode, created.status, created.output, created.provider, created.model, created.request_id, created.usage_json, created.started_at, created.completed_at);
    return created;
  },
  finishRun(runId, status, output, meta = {}) {
    db.prepare("UPDATE agent_runs SET status = ?, output = ?, request_id = COALESCE(?, request_id), usage_json = COALESCE(?, usage_json), completed_at = ? WHERE id = ?")
      .run(status, output, meta.requestId || null, meta.usage ? JSON.stringify(meta.usage) : null, now(), runId);
  },
  setTenantConnection(envName, { status, source = null, error = null }) {
    const stamp = now();
    db.prepare(`
      INSERT INTO tenant_connections (env_name, status, source, last_checked_at, last_error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(env_name) DO UPDATE SET status = excluded.status, source = excluded.source,
        last_checked_at = excluded.last_checked_at, last_error = excluded.last_error, updated_at = excluded.updated_at
    `).run(envName, status, source, stamp, error, stamp);
    return db.prepare("SELECT * FROM tenant_connections WHERE env_name = ?").get(envName);
  },
};
