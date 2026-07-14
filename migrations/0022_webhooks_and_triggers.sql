-- Integration Hub, roadmap Phase 4 weeks 39-40: inbound webhooks (RT-065)
-- and workflow triggers (RT-066), folded into one migration per the plan
-- since RT-066's webhook-triggered workflows depend directly on this table.

-- Token-based auth (same trust model as invitation/magic-link tokens): the
-- unguessable token itself is the credential, no JWT/session needed to POST
-- to a registered endpoint. Only the SHA-256 hash is stored (same as
-- magic_link_tokens/invitation tokens) — the raw token is shown once at
-- creation time and never persisted.
CREATE TABLE webhook_endpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    target_type VARCHAR(20) NOT NULL, -- workflow | agent
    target_id UUID NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by_user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_triggered_at TIMESTAMPTZ
);

CREATE INDEX idx_webhook_endpoints_org ON webhook_endpoints(organization_id);

-- Default {"type":"manual"} keeps every workflow created before RT-066 fully
-- backward compatible — trigger opt-in only. {"type":"scheduled",
-- "intervalMinutes":N} reuses agents.schedule's exact shape (no cron
-- library); {"type":"webhook","webhookEndpointId":...} ties into the table
-- above.
ALTER TABLE workflows ADD COLUMN trigger JSONB NOT NULL DEFAULT '{"type":"manual"}';
