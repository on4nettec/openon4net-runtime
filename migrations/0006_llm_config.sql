-- Per-organization BYOK provider override, editable from the dashboard
-- instead of requiring .env edits + a gateway restart. Absence of a row
-- means "use the env-configured default" (see gateway/src/services/
-- provider-config-service.ts) — this table only stores overrides.
-- API key is encrypted at rest (AES-256-GCM, envelope pattern per
-- docs/spect/02_ARCHITECTURE/11-secrets-and-key-management.md §4), master
-- key supplied via CONFIG_ENCRYPTION_KEY env var (Runtime's own env-first
-- MVP secret store — no external Vault dependency).

CREATE TABLE llm_configs (
    organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    model VARCHAR(100) NOT NULL,
    api_key_encrypted BYTEA NOT NULL,
    base_url VARCHAR(255),
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
