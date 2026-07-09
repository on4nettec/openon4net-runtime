# openon4net-runtime (Plane 1 — Customer Runtime)

This is the **installable runtime** customers run on their own servers (self-host / on‑prem). It is the “core product” that executes the organization’s daily work via Digital Employees.

## Responsibilities
- **API surface (MVP first):** Agents, Chat (sync + SSE), Memory (L1/L2 + search), Governance (audit + approvals), Tools/Connectors execution.
- **Execution runtime:** Workflow runs, skill execution, tool/plugin calls.
- **Governance enforcement:** RBAC/Policy, budget/credits gating, approval queue, audit logs.
- **Observability:** OpenTelemetry traces/metrics/log correlation + `trace_id` propagation.
- **Multi‑tenant boundary:** Organization/Workspace scoping and isolation.

## What it is NOT
- A public Marketplace registry (that’s Plane 4).
- A global activation/billing control plane (that’s Plane 2).
- A managed long‑term memory SaaS (that’s Plane 3).

## Key Contracts
- API contract: `docs/spect/04_API/00-openapi-v0.1.yaml`
- MVP guardrails: `docs/spect/09_TASKS/08-scope-guardrails-mvp.md`
- Governance/RBAC: `docs/spect/02_ARCHITECTURE/10-rbac-and-policy.md` and defaults `docs/spect/02_ARCHITECTURE/15-rbac-default-matrix.md`
- Sandbox policy: `docs/spect/02_ARCHITECTURE/09-plugin-sandbox.md`
- Observability: `docs/spect/02_ARCHITECTURE/08-observability-otel.md`

## Data Stores (typical)
- PostgreSQL (core + conversations + audit + optional vectors)
- Redis (L1 memory + caching + rate limits)
- Neo4j (memory graph, optional for MVP)
- MinIO/S3 (files)

Migrations: `migrations/` (this repo's own — not the root repo's `tools/migrations/`, which predates the plane split and is being retired)

## Getting Started

New to this repo? See [ONBOARDING.md](ONBOARDING.md) for the full setup walkthrough (clone → env → run → first chat), including the gotchas that have actually come up during development.

## Suggested Deploy Modes
- **MVP:** Docker Compose (local / single node).
- **Enterprise:** Kubernetes (on‑prem) with strict network policies and BYOK.

## Multilingual (i18n/l10n)
- UI must support RTL/LTR and locale formatting.
- API should respect `Accept-Language` and `X-Timezone`.

Spec: `docs/spect/00_VISION/08-i18n-l10n.md`

