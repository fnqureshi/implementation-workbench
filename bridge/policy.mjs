import { createHash } from "node:crypto";

export const ROLES = ["viewer", "implementer", "reviewer", "admin"];

const grants = {
  viewer: new Set(["read"]),
  implementer: new Set(["read", "create_task", "create_memory", "request_implementation", "test_connections"]),
  reviewer: new Set(["read", "create_task", "create_memory", "request_implementation", "resolve_approval", "test_connections"]),
  admin: new Set(["read", "create_task", "create_memory", "request_implementation", "resolve_approval", "test_connections", "manage_providers", "manage_tenants", "manage_clients"]),
};

export function assertRole(role, action) {
  if (!ROLES.includes(role) || !grants[role].has(action)) {
    const error = new Error(`Role '${role}' is not allowed to ${action.replaceAll("_", " ")}`);
    error.statusCode = 403;
    throw error;
  }
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)]));
  return value;
}

export function snapshotHash(value) {
  return createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex");
}

export function redactSecrets(value = "") {
  return String(value)
    .replace(/(sk-(?:ant-)?[A-Za-z0-9_-]{12,})/g, "[redacted-api-key]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, "[redacted-jwt]");
}
