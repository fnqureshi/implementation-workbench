import test from "node:test";
import assert from "node:assert/strict";
import { extractJson, messagesOutputText, normalizePlan, publicProviderDefinitions, responsesOutputText } from "../bridge/provider-core.mjs";

const plan = { summary: "Safe plan", risk: "low", steps: ["Inspect", "Prepare"], relevantMemory: ["memory_1"], note: "No deployment" };

test("normalizes a valid provider plan", () => {
  assert.deepEqual(normalizePlan(plan), plan);
  assert.throws(() => normalizePlan({ summary: "No steps", steps: [] }), /invalid/);
});

test("extracts JSON from provider markdown", () => {
  assert.deepEqual(extractJson(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``), plan);
});

test("extracts text from supported connector responses", () => {
  assert.equal(responsesOutputText({ output: [{ content: [{ type: "output_text", text: "connector-a" }] }] }), "connector-a");
  assert.equal(messagesOutputText({ content: [{ type: "text", text: "connector-b" }] }), "connector-b");
});

test("public connector definitions expose provider defaults for model settings", () => {
  const definitions = publicProviderDefinitions();
  assert.equal(definitions.every((item) => typeof item.defaultModel === "string"), true);
  assert.equal(definitions.some((item) => item.name === "OpenAI / ChatGPT"), true);
  assert.equal(definitions.some((item) => item.name === "Anthropic / Claude"), true);
});
