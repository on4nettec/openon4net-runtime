-- RT-077 (docs/spect/06_MEETINGS/04-plugin-ecosystem-architecture.md) —
-- self-hosted local Plugin registration, entirely bypassing Marketplace
-- (no publisher/submit/review/sandbox pipeline). Org-scoped only: a
-- self-hosted admin registers a plugin for their own organization, not for
-- publishing/selling — that path stays Marketplace's (see MKT-025's
-- sandbox test-gate, which only applies to the Marketplace listing flow).

CREATE TABLE local_plugins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(30),
    manifest JSONB NOT NULL, -- {provider: {type: 'http', baseUrl}, ...} — same shape as Marketplace's plugin_versions.manifest
    created_by_user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_local_plugins_organization ON local_plugins(organization_id);
