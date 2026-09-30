"use client";

import {
  Activity, AlertTriangle, Archive, Bot, Braces, Check, CircleDot, Cpu,
  FileDiff, History, KeyRound, MemoryStick, Play, Plus, RefreshCw,
  Server, ShieldCheck, Sparkles, Users, X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

const API = "http://127.0.0.1:4319/api";

type Client = { id: string; name: string; slug: string; created_at: string };
type Memory = { id: string; client_id: string; title: string; detail: string; status: string; confidence: string; source: string; scope_product: string | null; scope_environment: string | null; effective_from: string | null; revision: number; created_by: string; updated_at: string };
type Plan = { summary: string; risk: string; steps: string[]; relevantMemory?: string[]; note?: string };
type Task = { id: string; client_id: string; client_name: string; ticket: string; title: string; request: string; product: string; environment: string; status: string; risk: string; provider_profile_id: string; plan: Plan | null; updated_at: string };
type Event = { id: string; task_id: string | null; client_id: string | null; type: string; title: string; detail: string; actor: string; created_at: string };
type Approval = { id: string; task_id: string; action: string; status: string; snapshot_hash: string; requested_by: string; payload: { scope: string; liveWrites: boolean } };
type Run = { id: string; task_id: string; mode: string; status: string; output: string | null; started_at: string };
type System = { repoReadable: boolean; launcherExecutable: boolean; vaultReadable: boolean; vaultWritable: boolean; mode: string; credentialsPresent: boolean; sdkRoot: string; vaultRoot: string };
type TenantConnection = { env_name: string; status: string; source: string | null; last_checked_at: string | null; last_error: string | null };
type Tenant = { name: string; tenant: string; baseUrl: string; username: string; protected: boolean; authFrom: string | null; isDefault: boolean; credentialPresent: boolean; credentialSource: string | null; connection: TenantConnection | null };
type ProviderDefinition = { id: string; name: string; keyRequired: boolean; capabilities: string[] };
type ProviderProfile = { id: string; label: string; scope: string; status: string; last_tested_at: string | null; last_error: string | null; local: boolean; credentialPresent: boolean; definition: { name: string; capabilities: string[] } };
type TeamMember = { id: string; display_name: string; role: string; status: string; last_seen_at: string | null };
type Actor = { id: string; name: string; role: string };
type Bootstrap = { clients: Client[]; memories: Memory[]; tasks: Task[]; events: Event[]; approvals: Approval[]; runs: Run[]; connections: TenantConnection[]; tenants: Tenant[]; providers: ProviderProfile[]; providerDefinitions: ProviderDefinition[]; members: TeamMember[]; currentActor: Actor; system: System };

type WebTool = { name: string; title: string; description: string; inputSchema: object; annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean }; execute: (input: Record<string, unknown>) => Promise<unknown> };
type ModelContext = { registerTool: (tool: WebTool, options?: { signal?: AbortSignal }) => void | Promise<void> };

const emptyData: Bootstrap = {
  clients: [], memories: [], tasks: [], events: [], approvals: [], runs: [], connections: [], tenants: [],
  providers: [], providerDefinitions: [], members: [], currentActor: { id: "local", name: "Local user", role: "admin" },
  system: { repoReadable: false, launcherExecutable: false, vaultReadable: false, vaultWritable: false, mode: "offline", credentialsPresent: false, sdkRoot: "", vaultRoot: "" },
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-workbench-intent": "ui", ...(init?.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

function relativeTime(value: string) {
  const seconds = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(value).toLocaleDateString();
}

function statusTone(status: string) {
  if (["ready", "complete", "review", "approved"].includes(status)) return "border-emerald-300/20 bg-emerald-300/8 text-emerald-200";
  if (["planning", "running", "implementing", "pending"].includes(status)) return "border-amber-300/20 bg-amber-300/8 text-amber-200";
  if (["failed", "needs-attention", "rejected"].includes(status)) return "border-rose-300/20 bg-rose-300/8 text-rose-200";
  return "border-white/10 bg-white/5 text-slate-300";
}

export default function Home() {
  const [data, setData] = useState<Bootstrap>(emptyData);
  const [connected, setConnected] = useState(false);
  const [selectedClientId, setSelectedClientId] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [view, setView] = useState("work");
  const [request, setRequest] = useState("");
  const [ticket, setTicket] = useState("MAKE-");
  const [product, setProduct] = useState("");
  const [environment, setEnvironment] = useState("beta");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryTitle, setMemoryTitle] = useState("");
  const [memoryDetail, setMemoryDetail] = useState("");
  const [memoryProduct, setMemoryProduct] = useState("");
  const [memoryEnvironment, setMemoryEnvironment] = useState("");
  const [memoryEffectiveFrom, setMemoryEffectiveFrom] = useState("");
  const [planningProviderId, setPlanningProviderId] = useState("provider_local_agent");
  const [providerOpen, setProviderOpen] = useState(false);
  const [providerType, setProviderType] = useState("");
  const [providerLabel, setProviderLabel] = useState("Team planning connector");
  const [providerApiKey, setProviderApiKey] = useState("");
  const [providerContext, setProviderContext] = useState("");
  const [providerScope, setProviderScope] = useState("team");
  const [testingProvider, setTestingProvider] = useState("");
  const [credentialTenant, setCredentialTenant] = useState<Tenant | null>(null);
  const [credentialPassword, setCredentialPassword] = useState("");
  const [credentialStatus, setCredentialStatus] = useState<{ tone: "working" | "error"; message: string } | null>(null);
  const [testingTenant, setTestingTenant] = useState("");

  const refresh = useCallback(async (quiet = false) => {
    try {
      const next = await api<Bootstrap>("/bootstrap");
      setData(next); setConnected(true);
      setSelectedClientId((current) => current || next.clients[0]?.id || "");
      setSelectedTaskId((current) => current || next.tasks[0]?.id || "");
      setPlanningProviderId((current) => next.providers.some((item) => item.id === current) ? current : next.providers[0]?.id || "provider_local_agent");
      setProviderType((current) => next.providerDefinitions.some((item) => item.id === current && item.keyRequired) ? current : next.providerDefinitions.find((item) => item.keyRequired)?.id || "");
      setEnvironment((current) => next.tenants.some((item) => item.name === current) ? current : next.tenants.find((item) => item.isDefault)?.name || next.tenants[0]?.name || "beta");
      if (!quiet) setNotice("");
    } catch {
      setConnected(false);
      if (!quiet) setNotice("The private local bridge is offline. Start the app with npm run local.");
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(true), 15_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);

  const selectedClient = data.clients.find((item) => item.id === selectedClientId) || data.clients[0];
  const clientTasks = data.tasks.filter((item) => item.client_id === selectedClient?.id);
  const selectedTask = data.tasks.find((item) => item.id === selectedTaskId) || clientTasks[0] || null;
  const clientMemories = data.memories.filter((item) => item.client_id === selectedClient?.id);
  const taskEvents = data.events.filter((item) => item.task_id === selectedTask?.id);
  const pendingApproval = data.approvals.find((item) => item.task_id === selectedTask?.id && item.status === "pending");
  const activeRun = data.runs.find((item) => item.task_id === selectedTask?.id && item.status === "running");

  const createTask = useCallback(async (values?: Record<string, unknown>) => {
    const clientId = String(values?.clientId || selectedClient?.id || "");
    const taskTicket = String(values?.ticket || ticket).trim();
    const taskProduct = String(values?.product || product).trim();
    const taskRequest = String(values?.request || request).trim();
    const taskEnvironment = String(values?.environment || environment);
    const providerProfileId = String(values?.providerProfileId || planningProviderId);
    if (!clientId || !taskTicket || taskTicket === "MAKE-" || !taskProduct || !taskRequest) throw new Error("Add a ticket, product, and implementation request.");
    const task = await api<Task>("/tasks", { method: "POST", body: JSON.stringify({ clientId, ticket: taskTicket, title: taskRequest.slice(0, 72), request: taskRequest, product: taskProduct, environment: taskEnvironment, providerProfileId }) });
    setSelectedClientId(clientId); setSelectedTaskId(task.id); setRequest(""); setNotice("Read-only planning started. The app will update when the plan is ready.");
    await refresh(true);
    return { taskId: task.id, status: task.status };
  }, [environment, planningProviderId, product, refresh, request, selectedClient?.id, ticket]);

  const addMemory = useCallback(async (values?: Record<string, unknown>) => {
    const clientId = String(values?.clientId || selectedClient?.id || "");
    const title = String(values?.title || memoryTitle).trim();
    const detail = String(values?.detail || memoryDetail).trim();
    if (!clientId || !title || !detail) throw new Error("Add a memory title and the confirmed detail.");
    await api("/memories", { method: "POST", body: JSON.stringify({ clientId, title, detail, status: "confirmed", source: "user", confidence: "confirmed", scopeProduct: memoryProduct.trim() || null, scopeEnvironment: memoryEnvironment || null, effectiveFrom: memoryEffectiveFrom || null }) });
    setMemoryTitle(""); setMemoryDetail(""); setMemoryProduct(""); setMemoryEnvironment(""); setMemoryEffectiveFrom(""); setMemoryOpen(false); setNotice("Client memory saved with scope, author, and revision history.");
    await refresh(true);
    return { saved: true };
  }, [memoryDetail, memoryEffectiveFrom, memoryEnvironment, memoryProduct, memoryTitle, refresh, selectedClient?.id]);

  useEffect(() => {
    const context = (document as Document & { modelContext?: ModelContext }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const tools: WebTool[] = [
      {
        name: "create_implementation_task", title: "Create implementation task",
        description: "Create a client implementation task and start read-only planning. This does not change live systems.",
        inputSchema: { type: "object", properties: { clientId: { type: "string" }, ticket: { type: "string" }, product: { type: "string" }, environment: { type: "string", description: "One of the configured tenant environment names" }, request: { type: "string" } }, required: ["clientId", "ticket", "product", "environment", "request"], additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: createTask,
      },
      {
        name: "add_client_memory", title: "Add confirmed client memory",
        description: "Save a confirmed client requirement with provenance in the local Workbench history.",
        inputSchema: { type: "object", properties: { clientId: { type: "string" }, title: { type: "string" }, detail: { type: "string" } }, required: ["clientId", "title", "detail"], additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: addMemory,
      },
    ];
    for (const tool of tools) void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, [addMemory, createTask]);

  async function handleCreateTask(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice("");
    try { await createTask(); } catch (error) { setNotice(String((error as Error).message)); } finally { setBusy(false); }
  }

  async function requestImplementation() {
    if (!selectedTask) return;
    setBusy(true);
    try { await api(`/tasks/${selectedTask.id}/request-implementation`, { method: "POST", body: "{}" }); setNotice("Approval created. Review its scope before allowing local edits."); await refresh(true); }
    catch (error) { setNotice(String((error as Error).message)); } finally { setBusy(false); }
  }

  async function resolveApproval(decision: "approve" | "reject") {
    if (!pendingApproval) return;
    setBusy(true);
    try { await api(`/approvals/${pendingApproval.id}/${decision}`, { method: "POST", body: "{}" }); setNotice(decision === "approve" ? "Local implementation started. Live deployment remains blocked." : "Implementation request rejected."); await refresh(true); }
    catch (error) { setNotice(String((error as Error).message)); } finally { setBusy(false); }
  }

  async function handleAddMemory(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try { await addMemory(); } catch (error) { setNotice(String((error as Error).message)); } finally { setBusy(false); }
  }

  async function saveCredential(event: FormEvent) {
    event.preventDefault();
    if (!credentialTenant || !credentialPassword) return;
    const tenantName = credentialTenant.name;
    setBusy(true); setNotice(""); setCredentialStatus({ tone: "working", message: "Saving securely to macOS Keychain…" });
    let saved = false;
    try {
      const result = await api<{ covers: string[] }>(`/tenants/${encodeURIComponent(tenantName)}/credential`, { method: "POST", body: JSON.stringify({ password: credentialPassword }) });
      saved = true; setCredentialPassword("");
      setCredentialStatus({ tone: "working", message: `Saved securely. Testing ${tenantName} now; this can take up to 45 seconds…` });
      await api(`/tenants/${encodeURIComponent(tenantName)}/test`, { method: "POST", body: "{}" });
      setCredentialTenant(null); setCredentialStatus(null);
      setNotice(`${tenantName} is connected. The credential covers ${result.covers.join(", ")}.`);
      await refresh(true);
    } catch (error) {
      const message = String((error as Error).message);
      setCredentialStatus({ tone: "error", message: saved ? `The credential was saved, but ${tenantName} could not authenticate: ${message}` : `The credential could not be saved: ${message}` });
      await refresh(true);
    }
    finally { setBusy(false); }
  }

  async function testConnection(name: string) {
    setTestingTenant(name); setNotice("");
    try {
      await api(`/tenants/${encodeURIComponent(name)}/test`, { method: "POST", body: "{}" });
      setNotice(`${name} is connected and authenticated.`);
      await refresh(true);
    } catch (error) { setNotice(`${name}: ${String((error as Error).message)}`); await refresh(true); }
    finally { setTestingTenant(""); }
  }

  async function saveProvider(event: FormEvent) {
    event.preventDefault();
    if (!providerType || !providerLabel.trim() || !providerApiKey.trim()) return;
    setBusy(true); setNotice("");
    try {
      const profile = await api<ProviderProfile>("/providers", { method: "POST", body: JSON.stringify({ provider: providerType, label: providerLabel.trim(), apiKey: providerApiKey.trim(), projectId: providerContext.trim() || null, workspaceId: providerContext.trim() || null, scope: providerScope }) });
      setProviderApiKey(""); setProviderContext(""); setProviderOpen(false); setPlanningProviderId(profile.id);
      setNotice(`${profile.label} is stored securely. Testing the connection now…`);
      await testProvider(profile.id);
    } catch (error) { setNotice(String((error as Error).message)); }
    finally { setBusy(false); }
  }

  async function testProvider(id: string) {
    setTestingProvider(id); setNotice("");
    try {
      const result = await api<{ label: string }>(`/providers/${encodeURIComponent(id)}/test`, { method: "POST", body: "{}" });
      setNotice(`${result.label} is connected and ready for planning.`); await refresh(true);
    } catch (error) { setNotice(String((error as Error).message)); await refresh(true); }
    finally { setTestingProvider(""); }
  }

  function chooseProvider(type: string) {
    setProviderType(type);
    const position = data.providerDefinitions.filter((item) => item.keyRequired).findIndex((item) => item.id === type);
    setProviderLabel(`Team planning connector ${String.fromCharCode(65 + Math.max(0, position))}`);
  }

  const navigation = useMemo(() => [
    ["work", Activity, "Active work"], ["history", History, "History"],
    ["memory", MemoryStick, "Client memory"], ["system", Server, "Tenants"],
    ["providers", Cpu, "Planning"], ["team", Users, "Team"],
  ] as const, []);

  return (
    <main className="min-h-screen bg-[#071018] text-[#e7f2f5]">
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-white/8 bg-[#071018]/92 px-4 backdrop-blur-xl sm:px-6">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-xl border border-cyan-300/30 bg-cyan-300/10 text-cyan-200"><Braces className="size-[18px]" /></div>
          <div><p className="text-[15px] font-semibold tracking-[-0.01em]">Implementation Workbench</p><p className="text-xs text-slate-500">Team-ready local control room</p></div>
        </div>
        <div className="flex items-center gap-2">
          <div className={`hidden items-center gap-2 rounded-full border px-3 py-1.5 text-xs sm:flex ${connected ? "border-emerald-300/15 bg-emerald-300/7 text-emerald-200" : "border-rose-300/15 bg-rose-300/7 text-rose-200"}`}>
            <span className={`size-1.5 rounded-full ${connected ? "bg-emerald-300" : "bg-rose-300"}`} />
            {connected ? `SDK ${data.system.mode}` : "Bridge offline"}
          </div>
          <span className="hidden rounded-full border border-white/10 px-2.5 py-1 text-xs capitalize text-slate-400 md:inline">{data.currentActor.name} · {data.currentActor.role}</span>
          <button onClick={() => void refresh()} className="grid size-9 place-items-center rounded-xl border border-white/10 text-slate-400 transition hover:border-white/20 hover:text-white" aria-label="Refresh"><RefreshCw className="size-4" /></button>
        </div>
      </header>

      <div className="grid min-h-[calc(100vh-4rem)] grid-cols-1 xl:grid-cols-[228px_minmax(540px,1fr)_340px]">
        <aside className="hidden border-r border-white/8 bg-[#09131c] p-4 xl:flex xl:flex-col">
          <button onClick={() => { setView("work"); setSelectedTaskId(""); }} className="mb-5 flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-300 px-3 py-2.5 text-sm font-semibold text-[#041118]"><Plus className="size-4" /> New implementation</button>
          <nav className="space-y-1" aria-label="Primary navigation">
            {navigation.map(([id, Icon, label]) => <button key={id} onClick={() => setView(id)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition ${view === id ? "bg-white/8 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"}`}><Icon className="size-4" />{label}</button>)}
          </nav>
          <div className="mt-7 flex items-center justify-between px-2"><p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-600">Clients</p><span className="text-xs text-slate-600">{data.clients.length}</span></div>
          <div className="mt-2 space-y-1">
            {data.clients.map((client, index) => <button key={client.id} onClick={() => { setSelectedClientId(client.id); setSelectedTaskId(data.tasks.find((task) => task.client_id === client.id)?.id || ""); }} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm ${selectedClient?.id === client.id ? "bg-cyan-300/8 text-cyan-100" : "text-slate-400 hover:bg-white/5"}`}><span className={`size-2 rounded-full ${["bg-cyan-400", "bg-violet-400", "bg-amber-300"][index % 3]}`} /><span className="min-w-0 flex-1 truncate">{client.name}</span><span className="text-xs text-slate-600">{data.tasks.filter((task) => task.client_id === client.id).length}</span></button>)}
          </div>
          <div className="mt-auto rounded-xl border border-white/8 bg-black/15 p-3"><div className="flex items-center gap-2 text-xs font-medium text-slate-300"><ShieldCheck className="size-4 text-emerald-300" /> Approval-gated</div><p className="mt-1.5 text-xs leading-5 text-slate-500">Tenant access is explicit. Local implementation cannot touch the SDK repository or Terminal settings.</p></div>
        </aside>

        <section className="min-w-0 border-r border-white/8">
          <nav className="flex gap-1 overflow-x-auto border-b border-white/8 bg-[#09131c] px-3 py-2 xl:hidden" aria-label="Mobile navigation">{navigation.map(([id, Icon, label]) => <button key={id} onClick={() => setView(id)} className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-xs ${view === id ? "bg-white/10 text-white" : "text-slate-400"}`}><Icon className="size-3.5" />{label}</button>)}</nav>
          {notice && <div className="flex items-start justify-between gap-4 border-b border-cyan-300/15 bg-cyan-300/5 px-4 py-3 text-sm text-cyan-100 sm:px-7"><p>{notice}</p><button onClick={() => setNotice("")} aria-label="Dismiss"><X className="size-4" /></button></div>}

          {view === "work" && <>
            <div className="border-b border-white/8 px-4 py-4 sm:px-7">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><div className="flex items-center gap-2 text-xs text-slate-500"><span>{selectedClient?.name || "Client"}</span>{selectedTask && <><span>/</span><span>{selectedTask.ticket}</span></>}</div><h1 className="mt-1 text-xl font-semibold tracking-[-0.02em] sm:text-2xl">{selectedTask?.title || "Start an implementation"}</h1></div>
                {selectedTask && <span className={`rounded-full border px-2.5 py-1 text-xs capitalize ${statusTone(selectedTask.status)}`}>{selectedTask.status.replace("-", " ")}</span>}
              </div>
            </div>

            <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-7">
              <form onSubmit={handleCreateTask} className="rounded-2xl border border-cyan-300/18 bg-[linear-gradient(135deg,rgba(34,211,238,.07),rgba(15,23,42,.25))] p-4 shadow-[0_20px_80px_rgba(0,0,0,.18)] sm:p-5">
                <div className="mb-3 flex items-center gap-2 text-sm font-medium text-cyan-100"><Sparkles className="size-4 text-cyan-300" /> What should I implement?</div>
                <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-[140px_1fr_120px_190px]">
                  <input value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder="Ticket · MAKE-123" className="rounded-lg border border-white/10 bg-[#071018]/80 px-3 py-2 text-sm outline-none focus:border-cyan-300/40" />
                  <input value={product} onChange={(e) => setProduct(e.target.value)} placeholder="Product slug" className="rounded-lg border border-white/10 bg-[#071018]/80 px-3 py-2 text-sm outline-none focus:border-cyan-300/40" />
                  <select value={environment} onChange={(e) => setEnvironment(e.target.value)} className="rounded-lg border border-white/10 bg-[#071018]/80 px-3 py-2 text-sm outline-none">{data.tenants.map((tenant) => <option key={tenant.name} value={tenant.name}>{tenant.name}{tenant.protected ? " · protected" : ""}</option>)}</select>
                  <select value={planningProviderId} onChange={(e) => setPlanningProviderId(e.target.value)} className="rounded-lg border border-white/10 bg-[#071018]/80 px-3 py-2 text-sm outline-none">{data.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select>
                </div>
                <textarea value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Describe the client request and the outcome you need…" className="min-h-28 w-full resize-y rounded-xl border border-white/10 bg-[#071018]/80 p-3.5 text-base leading-6 text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-300/40 focus:ring-2 focus:ring-cyan-300/10" />
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-slate-500">Planning is read-only. Local edits require a separate approval.</p><button disabled={busy || !connected} className="flex items-center gap-2 rounded-lg bg-cyan-300 px-4 py-2.5 text-sm font-semibold text-[#041118] disabled:cursor-not-allowed disabled:opacity-40"><Play className="size-4 fill-current" /> Start planning</button></div>
              </form>

              {selectedTask ? <>
                <div className="grid gap-4 md:grid-cols-[1fr_220px]">
                  <section className="rounded-2xl border border-white/8 bg-white/[0.025] p-5">
                    <div className="flex items-center justify-between"><div><p className="text-sm font-semibold">Implementation plan</p><p className="mt-1 text-xs text-slate-500">{selectedTask.product} · {selectedTask.environment} · {data.providers.find((item) => item.id === selectedTask.provider_profile_id)?.label || "Local implementation agent"}</p></div>{activeRun && <span className="flex items-center gap-1.5 text-xs text-amber-200"><RefreshCw className="size-3 animate-spin" /> Agent working</span>}</div>
                    {selectedTask.plan ? <div className="mt-4"><p className="text-sm leading-6 text-slate-300">{selectedTask.plan.summary}</p><ol className="mt-4 space-y-2.5">{selectedTask.plan.steps.map((step, index) => <li key={step} className="grid grid-cols-[24px_1fr] gap-3 text-sm text-slate-400"><span className="grid size-6 place-items-center rounded-full border border-white/10 text-xs text-slate-500">{index + 1}</span><span className="pt-0.5 leading-5">{step}</span></li>)}</ol></div> : <div className="mt-5 space-y-3">{[88, 72, 94, 64].map((width) => <div key={width} className="h-3 rounded-full bg-white/5" style={{ width: `${width}%` }} />)}</div>}
                  </section>
                  <section className="rounded-2xl border border-white/8 bg-white/[0.025] p-5"><p className="text-sm font-semibold">Control boundary</p><div className="mt-5 grid place-items-center"><div className="grid size-24 place-items-center rounded-full border border-cyan-300/20 bg-cyan-300/5"><ShieldCheck className="size-9 text-cyan-200" /></div></div><div className="mt-5 space-y-2.5 text-xs text-slate-400"><p className="flex gap-2"><Check className="size-3.5 text-emerald-300" /> Read-only planning</p><p className="flex gap-2"><CircleDot className="size-3.5 text-amber-300" /> Local edits need approval</p><p className="flex gap-2"><KeyRound className="size-3.5 text-cyan-300" /> Credentials in Keychain</p></div></section>
                </div>

                {pendingApproval ? <section className="rounded-2xl border border-amber-300/20 bg-amber-300/5 p-5"><div className="flex gap-3"><AlertTriangle className="mt-0.5 size-5 text-amber-200" /><div className="flex-1"><p className="font-medium text-amber-100">Approve local implementation?</p><p className="mt-1 text-sm leading-6 text-slate-400">The implementation agent may update only this ticket’s working copy. The approval is tied to snapshot <span className="font-mono text-amber-100/80">{pendingApproval.snapshot_hash?.slice(0, 10)}</span> and becomes invalid if the task changes.</p><div className="mt-4 flex gap-2"><button onClick={() => void resolveApproval("approve")} disabled={busy} className="rounded-lg bg-amber-200 px-3.5 py-2 text-sm font-semibold text-[#191207]">Approve local edits</button><button onClick={() => void resolveApproval("reject")} disabled={busy} className="rounded-lg border border-white/10 px-3.5 py-2 text-sm text-slate-300">Reject</button></div></div></div></section> : selectedTask.status === "ready" && <button onClick={() => void requestImplementation()} disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-xl border border-violet-300/20 bg-violet-300/8 px-4 py-3 text-sm font-semibold text-violet-100"><Bot className="size-4" /> Ask the implementation agent to prepare local changes</button>}

                <section className="rounded-2xl border border-white/8 bg-white/[0.025]"><div className="flex items-center justify-between border-b border-white/8 px-5 py-4"><div className="flex items-center gap-2"><FileDiff className="size-4 text-violet-300" /><p className="text-sm font-semibold">Task history</p></div><span className="text-xs text-slate-600">{taskEvents.length} events</span></div><div className="divide-y divide-white/8">{taskEvents.slice(0, 6).map((event) => <div key={event.id} className="grid grid-cols-[28px_1fr_auto] items-start gap-3 px-5 py-3.5"><div className="mt-0.5 grid size-7 place-items-center rounded-full border border-white/10 text-slate-500"><History className="size-3.5" /></div><div><p className="text-sm text-slate-200">{event.title}</p><p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{event.detail}</p></div><p className="text-xs text-slate-600">{relativeTime(event.created_at)}</p></div>)}</div></section>
              </> : <section className="rounded-2xl border border-dashed border-white/10 p-10 text-center"><Archive className="mx-auto size-8 text-slate-600" /><p className="mt-3 text-sm text-slate-300">No implementation selected</p><p className="mt-1 text-xs text-slate-600">Create one above or choose an existing task from the history.</p></section>}
            </div>
          </>}

          {view === "history" && <ContentView title="Implementation history" subtitle="Every request, plan, approval, run, and outcome"><div className="divide-y divide-white/8 rounded-2xl border border-white/8 bg-white/[0.025]">{data.events.map((event) => <button key={event.id} onClick={() => { if (event.task_id) { setSelectedTaskId(event.task_id); setView("work"); } }} className="grid w-full grid-cols-[36px_1fr_auto] items-start gap-3 p-4 text-left"><div className="grid size-8 place-items-center rounded-lg bg-white/5 text-slate-500"><History className="size-4" /></div><div><p className="text-sm text-slate-200">{event.title}</p><p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{event.detail}</p></div><span className="text-xs text-slate-600">{relativeTime(event.created_at)}</span></button>)}</div></ContentView>}
          {view === "memory" && <ContentView title="Client memory" subtitle="Confirmed requirements, decisions, and implementation outcomes"><MemoryCards memories={clientMemories} onAdd={() => setMemoryOpen(true)} /></ContentView>}
          {view === "system" && <ContentView title="Tenant connections" subtitle="Every environment already configured in your Implementation SDK"><div className="mb-5 grid gap-3 sm:grid-cols-3"><Metric label="Environments" value={String(data.tenants.length)} /><Metric label="Tenants" value={String(new Set(data.tenants.map((item) => item.tenant)).size)} /><Metric label="Verified" value={String(data.tenants.filter((item) => item.connection?.status === "connected").length)} /></div><div className="space-y-3">{data.tenants.map((tenant) => <TenantCard key={tenant.name} tenant={tenant} testing={testingTenant === tenant.name} canManage={data.currentActor.role === "admin"} canTest={data.currentActor.role !== "viewer"} onConnect={() => { setCredentialStatus(null); setCredentialTenant(tenant); }} onTest={() => void testConnection(tenant.name)} onUse={() => { setEnvironment(tenant.name); setView("work"); setSelectedTaskId(""); setNotice(`${tenant.name} selected for the next implementation.`); }} />)}</div><div className="mt-5 rounded-xl border border-emerald-300/15 bg-emerald-300/5 p-4 text-sm leading-6 text-slate-300"><ShieldCheck className="mr-2 inline size-4 text-emerald-300" />Passwords are stored in macOS Keychain, never in this app’s database or source. Your SDK, shell profiles, Terminal settings, and global packages are unchanged.</div><div className="mt-3 grid gap-3 sm:grid-cols-2"><div className="rounded-xl border border-white/8 bg-white/[0.025] p-4"><p className="text-sm font-medium">SDK access</p><p className="mt-2 break-all text-xs leading-5 text-slate-500">{data.system.repoReadable && data.system.launcherExecutable ? "Ready · read-only source" : "Needs attention"}<br />{data.system.sdkRoot}</p></div><div className="rounded-xl border border-white/8 bg-white/[0.025] p-4"><p className="text-sm font-medium">Client vault</p><p className="mt-2 break-all text-xs leading-5 text-slate-500">{data.system.vaultWritable ? "Ready · approval-gated edits" : "Read-only"}<br />{data.system.vaultRoot}</p></div></div></ContentView>}
          {view === "providers" && <ContentView title="Planning connectors" subtitle="Choose a private planning profile per task; implementation remains approval-gated and local"><div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div className="grid flex-1 gap-3 sm:grid-cols-3"><Metric label="Profiles" value={String(data.providers.length)} /><Metric label="Connected" value={String(data.providers.filter((item) => item.status === "connected" || item.local).length)} /><Metric label="API keys in source" value="0" /></div>{data.currentActor.role === "admin" && <button onClick={() => setProviderOpen(true)} className="flex items-center gap-2 rounded-lg bg-cyan-300 px-4 py-2.5 text-sm font-semibold text-[#041118]"><Plus className="size-4" /> Connect planner</button>}</div><div className="space-y-3">{data.providers.map((provider) => <ProviderCard key={provider.id} provider={provider} testing={testingProvider === provider.id} canManage={data.currentActor.role === "admin"} onTest={() => void testProvider(provider.id)} onUse={() => { setPlanningProviderId(provider.id); setView("work"); setSelectedTaskId(""); setNotice(`${provider.label} selected for the next plan.`); }} />)}</div><div className="mt-5 rounded-xl border border-violet-300/15 bg-violet-300/5 p-4 text-sm leading-6 text-slate-300"><ShieldCheck className="mr-2 inline size-4 text-violet-200" />Cloud connectors can create structured plans and reviews. Only the local implementation agent can edit a client working copy, and only after a current approval snapshot is accepted. Connector and model details are not exposed in the workspace.</div></ContentView>}
          {view === "team" && <ContentView title="Team controls" subtitle="Clear ownership, roles, and an audit trail for wider rollout"><div className="mb-5 grid gap-3 sm:grid-cols-3"><Metric label="Members" value={String(data.members.length)} /><Metric label="Your role" value={data.currentActor.role} /><Metric label="Audit events" value={String(data.events.length)} /></div><div className="overflow-hidden rounded-2xl border border-white/8 bg-white/[0.025]"><div className="grid grid-cols-[1fr_110px_100px] border-b border-white/8 px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-600"><span>Member</span><span>Role</span><span>Status</span></div>{data.members.map((member) => <div key={member.id} className="grid grid-cols-[1fr_110px_100px] items-center px-4 py-4 text-sm"><div><p className="font-medium text-slate-200">{member.display_name}</p><p className="mt-1 text-xs text-slate-600">{member.id}</p></div><span className="capitalize text-slate-400">{member.role}</span><span className="text-emerald-200">{member.status}</span></div>)}</div><div className="mt-5 grid gap-3 sm:grid-cols-2"><div className="rounded-xl border border-white/8 bg-white/[0.025] p-4"><p className="text-sm font-medium">Role boundaries</p><p className="mt-2 text-xs leading-5 text-slate-500">Viewers inspect, implementers create work, reviewers resolve approvals, and admins manage provider credentials.</p></div><div className="rounded-xl border border-white/8 bg-white/[0.025] p-4"><p className="text-sm font-medium">Deployment model</p><p className="mt-2 text-xs leading-5 text-slate-500">Each teammate runs their own private local bridge and Keychain. No API key or tenant password is synchronized through Git.</p></div></div></ContentView>}
        </section>

        <aside className="bg-[#09131c] p-4 sm:p-6">
          <div className="flex items-center justify-between"><div><p className="text-sm font-semibold">{selectedClient?.name || "Client"} memory</p><p className="mt-1 text-xs text-slate-500">{clientMemories.length} confirmed records</p></div><button onClick={() => setMemoryOpen(true)} className="grid size-8 place-items-center rounded-lg border border-white/10 text-slate-400" aria-label="Add memory"><Plus className="size-4" /></button></div>
          <MemoryCards memories={clientMemories.slice(0, 5)} compact onAdd={() => setMemoryOpen(true)} />
          <section className="mt-5 rounded-xl border border-amber-300/15 bg-amber-300/5 p-4"><div className="flex items-center gap-2 text-sm font-medium text-amber-100"><ShieldCheck className="size-4" /> Approval boundary</div><p className="mt-2 text-xs leading-5 text-slate-400">The planning agent can inspect without approval. Editing task work files is always a separate approval and remains inside the client vault.</p></section>
          {clientTasks.length > 0 && <section className="mt-5 border-t border-white/8 pt-5"><p className="text-xs font-semibold uppercase tracking-[0.13em] text-slate-600">Recent tasks</p><div className="mt-3 space-y-2">{clientTasks.slice(0, 5).map((task) => <button key={task.id} onClick={() => { setSelectedTaskId(task.id); setView("work"); }} className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-sm text-slate-400 hover:bg-white/5"><span className="truncate">{task.ticket} · {task.product}</span><span className={`ml-2 size-2 shrink-0 rounded-full ${task.status === "ready" ? "bg-emerald-300" : "bg-amber-300"}`} /></button>)}</div></section>}
        </aside>
      </div>

      {memoryOpen && <div className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Add client memory"><form onSubmit={handleAddMemory} className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#0b1721] p-5 shadow-2xl"><div className="flex items-center justify-between"><div><p className="font-semibold">Add confirmed client memory</p><p className="mt-1 text-xs text-slate-500">Saved with scope, author, revision, and timestamp.</p></div><button type="button" onClick={() => setMemoryOpen(false)} className="grid size-8 place-items-center text-slate-500" aria-label="Close"><X className="size-4" /></button></div><label className="mt-5 block text-xs font-medium text-slate-400">Decision or requirement<input value={memoryTitle} onChange={(e) => setMemoryTitle(e.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-[#071018] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/40" placeholder="e.g. Renewal dates stay editable" /></label><label className="mt-4 block text-xs font-medium text-slate-400">Confirmed detail<textarea value={memoryDetail} onChange={(e) => setMemoryDetail(e.target.value)} className="mt-2 min-h-28 w-full rounded-lg border border-white/10 bg-[#071018] p-3 text-sm text-white outline-none focus:border-cyan-300/40" placeholder="Include scope, exceptions, ticket, and rationale." /></label><div className="mt-4 grid gap-3 sm:grid-cols-3"><label className="text-xs font-medium text-slate-400">Product scope<input value={memoryProduct} onChange={(e) => setMemoryProduct(e.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-[#071018] px-3 py-2.5 text-sm text-white outline-none" placeholder="All products" /></label><label className="text-xs font-medium text-slate-400">Environment<select value={memoryEnvironment} onChange={(e) => setMemoryEnvironment(e.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-[#071018] px-3 py-2.5 text-sm text-white outline-none"><option value="">All</option>{data.tenants.map((tenant) => <option key={tenant.name} value={tenant.name}>{tenant.name}</option>)}</select></label><label className="text-xs font-medium text-slate-400">Effective from<input type="date" value={memoryEffectiveFrom} onChange={(e) => setMemoryEffectiveFrom(e.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-[#071018] px-3 py-2.5 text-sm text-white outline-none" /></label></div><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setMemoryOpen(false)} className="rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-300">Cancel</button><button disabled={busy || !connected} className="rounded-lg bg-cyan-300 px-3.5 py-2 text-sm font-semibold text-[#041118] disabled:opacity-40">Save memory</button></div></form></div>}
      {credentialTenant && <div className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Connect tenant credential"><form onSubmit={saveCredential} className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#0b1721] p-5 shadow-2xl"><div className="flex items-start justify-between gap-4"><div><p className="font-semibold">Connect {credentialTenant.name}</p><p className="mt-1 text-xs leading-5 text-slate-500">Account: {credentialTenant.username}<br />One Keychain credential will automatically cover every configured environment using this account.</p></div><button type="button" disabled={busy} onClick={() => { setCredentialTenant(null); setCredentialPassword(""); setCredentialStatus(null); }} className="grid size-8 place-items-center text-slate-500 disabled:opacity-30" aria-label="Close"><X className="size-4" /></button></div><label className="mt-5 block text-xs font-medium text-slate-400">Insly password<input autoFocus disabled={busy} type="password" autoComplete="current-password" value={credentialPassword} onChange={(e) => setCredentialPassword(e.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-[#071018] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/40 disabled:opacity-50" placeholder="Stored directly in macOS Keychain" /></label><div className="mt-4 rounded-lg border border-cyan-300/12 bg-cyan-300/5 p-3 text-xs leading-5 text-slate-400"><KeyRound className="mr-2 inline size-3.5 text-cyan-300" />The Workbench never writes this password to SQLite, logs, task history, the SDK, or your shell.</div>{credentialStatus && <div role="status" aria-live="polite" className={`mt-4 rounded-lg border p-3 text-xs leading-5 ${credentialStatus.tone === "error" ? "border-rose-300/20 bg-rose-300/5 text-rose-100" : "border-amber-300/20 bg-amber-300/5 text-amber-100"}`}>{credentialStatus.tone === "working" && <RefreshCw className="mr-2 inline size-3.5 animate-spin" />}{credentialStatus.message}</div>}<div className="mt-5 flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => { setCredentialTenant(null); setCredentialPassword(""); setCredentialStatus(null); }} className="rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-300 disabled:opacity-30">Cancel</button><button type="submit" disabled={busy || !credentialPassword || !connected} className="min-w-28 rounded-lg bg-cyan-300 px-3.5 py-2 text-sm font-semibold text-[#041118] disabled:opacity-40">{busy ? "Working…" : "Save & test"}</button></div>{!connected && <p className="mt-3 text-right text-xs text-rose-200">The local bridge is offline. Restart the Workbench, then try again.</p>}</form></div>}
      {providerOpen && <div className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Connect planning connector"><form onSubmit={saveProvider} className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#0b1721] p-5 shadow-2xl"><div className="flex items-start justify-between gap-4"><div><p className="font-semibold">Connect planning connector</p><p className="mt-1 text-xs leading-5 text-slate-500">Add a team-approved private planning profile. Connector and model details stay out of the workspace.</p></div><button type="button" onClick={() => { setProviderOpen(false); setProviderApiKey(""); }} className="grid size-8 place-items-center text-slate-500" aria-label="Close"><X className="size-4" /></button></div><div className="mt-5 grid grid-cols-2 gap-2">{data.providerDefinitions.filter((item) => item.keyRequired).map((definition) => <button type="button" key={definition.id} onClick={() => chooseProvider(definition.id)} className={`rounded-lg border px-3 py-2 text-sm ${providerType === definition.id ? "border-cyan-300/30 bg-cyan-300/8 text-cyan-100" : "border-white/10 text-slate-400"}`}>{definition.name}</button>)}</div><label className="mt-4 block text-xs font-medium text-slate-400">Profile label<input value={providerLabel} onChange={(e) => setProviderLabel(e.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-[#071018] px-3 py-2.5 text-sm text-white outline-none" /></label><label className="mt-4 block text-xs font-medium text-slate-400">API key<input autoFocus type="password" autoComplete="new-password" value={providerApiKey} onChange={(e) => setProviderApiKey(e.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-[#071018] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/40" placeholder="Stored directly in macOS Keychain" /></label><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs font-medium text-slate-400">Account scope (optional)<input value={providerContext} onChange={(e) => setProviderContext(e.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-[#071018] px-3 py-2.5 text-sm text-white outline-none" /></label><label className="text-xs font-medium text-slate-400">Sharing scope<select value={providerScope} onChange={(e) => setProviderScope(e.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-[#071018] px-3 py-2.5 text-sm text-white outline-none"><option value="team">Team profile</option><option value="personal">Personal profile</option></select></label></div><div className="mt-4 rounded-lg border border-cyan-300/12 bg-cyan-300/5 p-3 text-xs leading-5 text-slate-400"><KeyRound className="mr-2 inline size-3.5 text-cyan-300" />The key is never returned to the browser, written to SQLite, committed to Git, or copied into task history.</div><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => { setProviderOpen(false); setProviderApiKey(""); }} className="rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-300">Cancel</button><button type="submit" disabled={busy || !providerType || !providerApiKey || !providerLabel} className="rounded-lg bg-cyan-300 px-3.5 py-2 text-sm font-semibold text-[#041118] disabled:opacity-40">Save & test</button></div></form></div>}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-white/8 bg-white/[0.025] p-4"><p className="text-2xl font-semibold text-cyan-100">{value}</p><p className="mt-1 text-xs text-slate-500">{label}</p></div>;
}

function TenantCard({ tenant, testing, canManage, canTest, onConnect, onTest, onUse }: { tenant: Tenant; testing: boolean; canManage: boolean; canTest: boolean; onConnect: () => void; onTest: () => void; onUse: () => void }) {
  const verified = tenant.connection?.status === "connected";
  return <article className={`rounded-2xl border p-4 sm:p-5 ${verified ? "border-emerald-300/15 bg-emerald-300/[0.035]" : tenant.connection?.status === "failed" ? "border-rose-300/15 bg-rose-300/[0.025]" : "border-white/8 bg-white/[0.025]"}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 gap-3"><div className={`grid size-10 shrink-0 place-items-center rounded-xl ${verified ? "bg-emerald-300/10 text-emerald-200" : "bg-cyan-300/8 text-cyan-200"}`}><Server className="size-[18px]" /></div><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-semibold capitalize">{tenant.tenant}</p><span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-slate-400">{tenant.name}</span>{tenant.isDefault && <span className="rounded-full bg-cyan-300/10 px-2 py-0.5 text-[11px] text-cyan-200">default</span>}{tenant.protected && <span className="rounded-full bg-amber-300/10 px-2 py-0.5 text-[11px] text-amber-200">protected</span>}</div><p className="mt-1 truncate text-xs text-slate-500">{tenant.username}</p><p className="mt-1 truncate text-xs text-slate-600">{tenant.baseUrl}</p></div></div>
      <div className={`flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs ${verified ? "border-emerald-300/15 bg-emerald-300/8 text-emerald-200" : tenant.connection?.status === "failed" ? "border-rose-300/15 bg-rose-300/8 text-rose-200" : "border-white/10 bg-white/5 text-slate-400"}`}><span className={`size-1.5 rounded-full ${verified ? "bg-emerald-300" : tenant.connection?.status === "failed" ? "bg-rose-300" : "bg-slate-500"}`} />{verified ? "Verified" : tenant.connection?.status === "failed" ? "Needs attention" : tenant.credentialPresent ? "Credential ready" : "Not connected"}</div>
    </div>
    {tenant.connection?.last_error && <p className="mt-3 rounded-lg bg-rose-300/5 px-3 py-2 text-xs leading-5 text-rose-200/75">{tenant.connection.last_error}</p>}
    <div className="mt-4 flex flex-wrap items-center gap-2"><button onClick={onConnect} disabled={!canManage} title={canManage ? undefined : "Admin role required"} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-slate-200 hover:border-cyan-300/25 disabled:cursor-not-allowed disabled:opacity-35"><KeyRound className="size-3.5" />{tenant.credentialPresent ? "Replace credential" : "Connect"}</button><button onClick={onTest} disabled={testing || !tenant.credentialPresent || !canTest} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-slate-200 disabled:cursor-not-allowed disabled:opacity-35"><RefreshCw className={`size-3.5 ${testing ? "animate-spin" : ""}`} />{testing ? "Testing…" : "Test connection"}</button><button onClick={onUse} className="ml-auto flex items-center gap-1.5 rounded-lg bg-cyan-300/10 px-3 py-2 text-xs font-semibold text-cyan-100"><Play className="size-3.5" />Use for new task</button></div>
    {tenant.connection?.last_checked_at && <p className="mt-3 text-[11px] text-slate-600">Last checked {relativeTime(tenant.connection.last_checked_at)}{tenant.credentialSource ? ` · ${tenant.credentialSource}` : ""}</p>}
  </article>;
}

function ProviderCard({ provider, testing, canManage, onTest, onUse }: { provider: ProviderProfile; testing: boolean; canManage: boolean; onTest: () => void; onUse: () => void }) {
  const local = provider.local;
  const connected = local || provider.status === "connected";
  return <article className={`rounded-2xl border p-4 sm:p-5 ${connected ? "border-emerald-300/15 bg-emerald-300/[0.035]" : provider.status === "failed" ? "border-rose-300/15 bg-rose-300/[0.025]" : "border-white/8 bg-white/[0.025]"}`}><div className="flex flex-wrap items-start justify-between gap-3"><div className="flex gap-3"><div className="grid size-10 place-items-center rounded-xl bg-violet-300/10 text-violet-200"><Cpu className="size-[18px]" /></div><div><div className="flex flex-wrap items-center gap-2"><p className="font-semibold">{provider.label}</p><span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] capitalize text-slate-400">{provider.scope}</span></div><p className="mt-1 text-xs text-slate-500">{provider.definition.name}</p><p className="mt-1 text-[11px] text-slate-600">{provider.definition.capabilities.join(" · ")}</p></div></div><span className={`rounded-full border px-2.5 py-1 text-xs ${connected ? "border-emerald-300/15 bg-emerald-300/8 text-emerald-200" : "border-white/10 text-slate-400"}`}>{connected ? "Ready" : provider.credentialPresent ? "Key stored" : "Needs key"}</span></div>{provider.last_error && <p className="mt-3 rounded-lg bg-rose-300/5 px-3 py-2 text-xs leading-5 text-rose-200/75">{provider.last_error}</p>}<div className="mt-4 flex flex-wrap gap-2">{!local && canManage && <button onClick={onTest} disabled={testing || !provider.credentialPresent} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-slate-200 disabled:opacity-35"><RefreshCw className={`size-3.5 ${testing ? "animate-spin" : ""}`} />{testing ? "Testing…" : "Test connection"}</button>}<button onClick={onUse} className="ml-auto flex items-center gap-1.5 rounded-lg bg-cyan-300/10 px-3 py-2 text-xs font-semibold text-cyan-100"><Play className="size-3.5" />Use for new task</button></div>{provider.last_tested_at && <p className="mt-3 text-[11px] text-slate-600">Last tested {relativeTime(provider.last_tested_at)}</p>}</article>;
}

function ContentView({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return <><div className="border-b border-white/8 px-4 py-5 sm:px-7"><h1 className="text-2xl font-semibold tracking-[-0.02em]">{title}</h1><p className="mt-1 text-sm text-slate-500">{subtitle}</p></div><div className="mx-auto max-w-4xl p-4 sm:p-7">{children}</div></>;
}

function MemoryCards({ memories, compact = false, onAdd }: { memories: Memory[]; compact?: boolean; onAdd: () => void }) {
  if (!memories.length) return <button onClick={onAdd} className={`${compact ? "mt-5" : ""} w-full rounded-xl border border-dashed border-white/10 p-6 text-center text-sm text-slate-500 hover:border-cyan-300/20 hover:text-cyan-100`}><MemoryStick className="mx-auto mb-2 size-5" />Add the first confirmed client decision</button>;
  return <div className={`${compact ? "mt-5" : "grid gap-3 sm:grid-cols-2"} space-y-3`}>{memories.map((memory) => <article key={memory.id} className="rounded-xl border border-white/8 bg-white/[0.025] p-3.5"><div className="flex items-start gap-3"><div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-violet-300/8 text-violet-200"><MemoryStick className="size-3.5" /></div><div><p className="text-sm font-medium leading-5 text-slate-200">{memory.title}</p><p className="mt-1.5 text-xs leading-5 text-slate-500">{memory.detail}</p><div className="mt-2 flex flex-wrap gap-2"><span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] capitalize text-slate-400">{memory.status} · r{memory.revision || 1}</span>{memory.scope_product && <span className="rounded-full bg-violet-300/8 px-2 py-0.5 text-[11px] text-violet-200">{memory.scope_product}</span>}{memory.scope_environment && <span className="rounded-full bg-cyan-300/8 px-2 py-0.5 text-[11px] text-cyan-200">{memory.scope_environment}</span>}<span className="text-[11px] text-slate-600">{relativeTime(memory.updated_at)}</span></div></div></div></article>)}</div>;
}
