-- Enterprise SSO (roadmap Phase 5, week 41-42, RT-068/RT-069): each
-- organization can configure exactly one identity provider (OIDC or SAML).
-- Unlike auth/providers/oauth.ts's google/github (global, env-configured),
-- this is per-org — the whole point of "enterprise SSO" is that each
-- customer brings their own IdP. secret_encrypted reuses the exact
-- envelope-encryption scheme llm_configs.api_key_encrypted already uses
-- (lib/crypto.ts) — only OIDC's client_secret needs it; SAML's IdP metadata
-- (entity id/SSO URL/certificate) is all public, so secret_encrypted stays
-- NULL for SAML rows.
CREATE TABLE sso_configs (
    organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    protocol VARCHAR(10) NOT NULL, -- oidc | saml
    config JSONB NOT NULL, -- oidc: {issuerUrl, clientId}; saml: {entityId, ssoUrl, certificate}
    secret_encrypted BYTEA,
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
