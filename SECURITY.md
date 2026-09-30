# Security

## Supported boundary

Implementation Workbench is a localhost application for trusted teammates on managed Macs. It is not designed to be exposed to a network or internet-facing reverse proxy.

## Secrets

- Add tenant passwords and cloud-connector API keys only through the Workbench screens.
- Secrets are stored in macOS Keychain under Workbench-specific service names.
- Secrets must never be added to `.env`, screenshots, issues, task memory, logs, fixtures, or commits.
- Provider responses are redacted before durable run output is saved.
- Rotate a credential immediately if it appears in Git history or an issue; deleting the visible text is not sufficient.

## Request controls

- The bridge binds to loopback, validates permitted browser origins, limits request bodies, and requires an explicit UI intent header on state-changing requests.
- Role checks are enforced by the bridge, not only by the UI.
- Provider API profiles do not have filesystem implementation capability.
- Local implementation requires a fresh snapshot approval. Optional separate-review mode prevents self-approval.

## Reporting a vulnerability

Do not open a public issue containing exploit details or credentials. Contact the repository owner privately with the affected version, reproduction steps, and impact. Remove all client data and secrets from the report.

## Before wider deployment

Complete an application security review, add centralized authentication and authorization, move credentials to an organizational secret manager, add rate limits and tamper-evident audit storage, and validate tenant isolation. Do not treat the current local role environment variables as remote authentication.
