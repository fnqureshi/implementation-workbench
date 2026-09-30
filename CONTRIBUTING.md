# Contributing

## Local workflow

1. Create a branch from `main`.
2. Install with `npm ci` and run `npm run doctor`.
3. Keep all work inside this repository. Do not change global packages, shell profiles, Terminal settings, the SDK source, agent configuration, or another teammate's local data.
4. Run `npm run lint`, `npm test`, and `npm run build` before opening a pull request.
5. Describe the user outcome, security impact, test evidence, and any database migration in the pull request.

## Review requirements

Changes touching `bridge/providers.mjs`, `bridge/tenants.mjs`, `bridge/policy.mjs`, approvals, Keychain access, filesystem scope, or implementation execution require security-focused review from a code owner.

Never weaken these invariants:

- No secret reaches Git, SQLite, browser output, task memory, or normal logs.
- Planning does not imply implementation authority.
- Approval does not imply deployment authority.
- A changed task or memory snapshot invalidates its approval.
- The SDK source and machine-wide terminal configuration stay untouched.

## Database changes

Keep migrations additive and safe for existing local databases. New columns need defaults or nullable semantics. Never delete or reinterpret client history silently.
