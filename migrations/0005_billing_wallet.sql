-- Billing: wallets only.
-- Source: docs/spect/03_DATABASE/02-billing-schema.md §2. Per
-- docs/spect/09_TASKS/00-claude-build-pack.md §3 Stage B, credit_transactions
-- is optional/deferred for v0.1 — this table just keeps the schema stable for
-- a future read-only wallet view. No API is built on it in Sprint 0.

CREATE TABLE wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    owner_type VARCHAR(20) NOT NULL, -- organization | workspace | publisher
    owner_id UUID,
    currency VARCHAR(10) NOT NULL DEFAULT 'O2N',
    balance_credits BIGINT NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'active', -- active | suspended
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_wallets_org ON wallets(organization_id);
CREATE INDEX idx_wallets_workspace ON wallets(workspace_id);
