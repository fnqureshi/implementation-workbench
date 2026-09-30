# Implementation Workbench

A local-first control room for repeatable Insly implementation work. It combines structured client memory, implementation history, tenant discovery, approval-gated local changes, and private planning connectors.

## What the team gets

- One task workspace for the request, plan, risk, approval, implementation run, and outcome.
- Client memory with product/environment scope, authorship, effective date, and revision history.
- Automatic discovery of every environment already configured in the Implementation SDK.
- A provider profile per planning model, selectable for each task.
- Viewer, implementer, reviewer, and admin roles with actor-aware audit events.
- Approval snapshots that become invalid if the task or relevant client memory changes.
- A hard boundary between read-only planning, local working-copy edits, and live deployment.

## Safety and isolation

- The app binds only to `127.0.0.1` and keeps its SQLite state in the ignored `data/` folder.
- It does not edit shell profiles, Terminal settings, global packages, agent configuration, or the Implementation SDK source.
- Tenant passwords and provider API keys are stored in each teammate's macOS Keychain. They never enter SQLite, browser responses, Git, task history, or logs.
- Cloud profiles can plan and review. Only the local implementation adapter can prepare changes, and only inside a ticket working copy after approval.
- Deployment, promotion, rollback, protected-environment writes, and SDK source changes are outside the approval scope.

See [SECURITY.md](SECURITY.md) for the threat model and [ARCHITECTURE.md](ARCHITECTURE.md) for system boundaries.

## First-time setup

Requirements: macOS, Node.js 22.13 or newer, and an existing Implementation SDK checkout for live SDK integration.

```bash
npm ci
npm run doctor
npm run local
```

Open `http://127.0.0.1:5173`. The private bridge listens on `127.0.0.1:4319`.

No API key is required for local planning. To use a cloud connector, open **Planning**, choose **Connect planner**, and paste the key there. The browser submits it once to the local bridge, which saves it directly to Keychain and never returns it. Provider and model details are not displayed in the workspace or normal task history.

## Per-teammate configuration

Copy `.env.example` to `.env.local` only when the default paths or identity need changing. Do not add secrets to this file.

```bash
WORKBENCH_SDK_ROOT="/path/to/implementation-sdk" \
WORKBENCH_VAULT_ROOT="/path/to/client-vault" \
WORKBENCH_INSLY_CONFIG="/path/to/.insly/config.json" \
WORKBENCH_ACTOR_ID="company-user-id" \
WORKBENCH_ACTOR_NAME="Team member" \
WORKBENCH_ROLE="implementer" \
npm run local
```

Set `WORKBENCH_REQUIRE_SEPARATE_REVIEW=1` when an implementation requester must not approve their own request. Because the current foundation is local-first, shared organizational identity and synchronized multi-user state are a future service-layer deployment, not simulated by committing local databases or secrets.

## Provider support

| Connector | Plan | Review | Local implementation | Secret storage |
|---|---:|---:|---:|---|
| Local implementation agent | Yes | Yes | Yes, after approval | Existing local agent session |
| Cloud planning connector A | Yes | Yes | No | macOS Keychain |
| Cloud planning connector B | Yes | Yes | No | macOS Keychain |

All connectors return the same validated, structured plan contract. Provider request identifiers and usage metadata may be retained privately for diagnosis; credentials, model identifiers, and provider headers are not returned to the browser or displayed in task history.

## Quality checks

```bash
npm run lint
npm test
npm run build
npm run doctor
```

Pull requests run lint, tests, and a production build automatically. See [CONTRIBUTING.md](CONTRIBUTING.md) before changing approval, credential, or implementation boundaries.

## Repository status

This is a team-ready foundation, not a hosted multi-tenant service. Each clone currently has its own local database and Keychain entries. That preserves the existing SDK and terminal setup while giving the wider team a safe operating model to validate before centralizing identity, storage, or deployment.
