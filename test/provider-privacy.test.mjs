import test from "node:test";
import assert from "node:assert/strict";
import { publicProfile } from "../bridge/providers.mjs";

test("public planning profiles expose selectable model metadata but omit account internals", async () => {
  const profile = await publicProfile({
    id: "provider_local_agent", provider: "local-agent", label: "Local implementation agent",
    model: "private-model-id", project_id: "private-project", workspace_id: null,
    scope: "personal", status: "connected", last_tested_at: null, last_error: null,
  });
  assert.equal(profile.local, true);
  assert.equal(profile.provider, "local-agent");
  assert.equal(profile.model, "private-model-id");
  assert.equal(JSON.stringify(profile).includes("private-project"), false);
});
