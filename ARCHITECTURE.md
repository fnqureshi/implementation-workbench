# Architecture

## Runtime boundary

The browser UI and Node bridge run as one private desktop application:

```text
Browser UI (127.0.0.1:5173)
        |
        | explicit UI intent + origin check
        v
Local bridge (127.0.0.1:4319)
   |        |           |             |
 SQLite  Keychain  SDK read adapter  Client vault
                                  (ticket copies only)
```

The bridge is the only component allowed to read Keychain, inspect the SDK, or launch an approved implementation run. The browser never receives tenant passwords or provider API keys.

## Core records

- **Client** owns memories and implementation tasks.
- **Memory** records a confirmed or proposed requirement with scope, author, effective date, revision, and optional predecessor.
- **Task** freezes the request, product, environment, provider profile, plan, and status.
- **Approval** contains an immutable SHA-256 snapshot of the task plan and referenced memory revisions.
- **Run** records mode, provider, model, request identifier, usage metadata, status, and redacted output.
- **Event** is the append-oriented, actor-aware audit timeline.
- **Provider profile** stores non-secret configuration in SQLite; its credential lives in Keychain.

## Provider adapter contract

Every planner returns the same validated shape: summary, risk, ordered steps, relevant memory IDs, and a note. Cloud connectors are planning/review adapters only. The implementation adapter is deliberately pinned to the local implementation agent so an API planning credential cannot silently gain filesystem authority.

## Approval lifecycle

1. A task is planned without write authority.
2. The user requests local implementation.
3. The bridge hashes the current request, plan, environment, and memory revisions.
4. A reviewer approves or rejects that exact snapshot.
5. Before starting, the bridge computes the snapshot again. Any difference makes the approval stale.
6. An approved run may prepare files only in the ticket working copy. Live deployment remains excluded.

## Growth path

The current storage and Keychain model is intentionally per-device. A hosted team deployment should replace local actor environment variables with SSO, move SQLite to a managed database with row-level authorization, use an organization secret manager, sign approval events, and add tenant isolation tests before exposing the bridge beyond localhost.
