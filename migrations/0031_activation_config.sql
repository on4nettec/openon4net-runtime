-- RT-092 — activation key becomes DB-configurable via a first-run UI page,
-- instead of only a manually-edited env var (ACTIVATION_KEY) requiring a
-- restart. Singleton table (id always 1): activation is a deployment-wide
-- concept — a single Runtime install has exactly one relationship with
-- Control Plane, unlike per-organization config (llm_configs, sso_configs).
-- Envelope-encrypted the same way as those two tables (RT-019's KMS
-- registry), since an activation key is just as sensitive as an LLM/SSO
-- provider key.
CREATE TABLE activation_config (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    activation_key_encrypted BYTEA NOT NULL,
    kms_provider_id VARCHAR(50) NOT NULL,
    kms_key_id VARCHAR(50) NOT NULL,
    kms_key_version INTEGER NOT NULL DEFAULT 1,
    configured_by_user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
