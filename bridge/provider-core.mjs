export const PROVIDER_DEFINITIONS = {
  "local-agent": {
    id: "local-agent", name: "Local implementation agent", keyRequired: false,
    capabilities: ["plan", "implement", "review"], defaultModel: "private",
  },
  "connector-a": {
    id: "connector-a", name: "OpenAI / ChatGPT", keyRequired: true,
    capabilities: ["plan", "review"], defaultModel: "gpt-5.4",
  },
  "connector-b": {
    id: "connector-b", name: "Anthropic / Claude", keyRequired: true,
    capabilities: ["plan", "review"], defaultModel: "claude-sonnet-4-6",
  },
};

export function publicProviderDefinitions() {
  return Object.values(PROVIDER_DEFINITIONS).map(({ id, name, keyRequired, capabilities, defaultModel }) => ({ id, name, keyRequired, capabilities, defaultModel }));
}

export const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    steps: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
    relevantMemory: { type: "array", items: { type: "string" } },
    note: { type: "string" },
  },
  required: ["summary", "risk", "steps", "relevantMemory", "note"],
};

export function normalizePlan(value) {
  if (!value || typeof value !== "object" || typeof value.summary !== "string" || !Array.isArray(value.steps) || !value.steps.length) throw new Error("Provider returned an invalid implementation plan");
  const risk = ["low", "medium", "high"].includes(value.risk) ? value.risk : "unknown";
  return { summary: value.summary, risk, steps: value.steps.slice(0, 6).map(String), relevantMemory: Array.isArray(value.relevantMemory) ? value.relevantMemory.map(String) : [], note: String(value.note || "") };
}

export function extractJson(text) {
  const value = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(value); } catch { /* try embedded object */ }
  const start = value.indexOf("{"); const end = value.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(value.slice(start, end + 1));
  throw new Error("Provider did not return JSON");
}

export function responsesOutputText(payload) {
  return (payload.output || []).flatMap((item) => item.content || []).filter((item) => item.type === "output_text").map((item) => item.text || "").join("\n");
}

export function messagesOutputText(payload) {
  return (payload.content || []).filter((item) => item.type === "text").map((item) => item.text || "").join("\n");
}
