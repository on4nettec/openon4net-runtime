-- Email invitations for org onboarding. Mirrors magic_link_tokens' hashed-
-- token shape (0013_auth_methods.sql) -- same TTL/lookup pattern, own table
-- since this represents a not-yet-created user, not a login credential.
CREATE TABLE invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    role VARCHAR(100) NOT NULL,
    workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
    invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    token_hash TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | accepted | revoked | expired
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_invitations_org ON invitations(organization_id);
-- accept() looks up by hash directly, not by org first.
CREATE INDEX idx_invitations_hash ON invitations(token_hash) WHERE status = 'pending';
