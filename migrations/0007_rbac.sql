-- DB-backed RBAC (docs/spect/02_ARCHITECTURE/10-rbac-and-policy.md §4/§8 "minimum"
-- tables). Replaces the previously-hardcoded role->permission map
-- (packages/governance/src/permissions.ts) as the runtime source of truth —
-- that map now only serves as seed data for new organizations. The separate
-- ABAC "Policy Layer" (§6, a `policies` table with cost/layer/tag/time
-- conditions) is NOT part of this migration — deliberately deferred, see
-- docs/spect/DONE.md.

CREATE TABLE roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    -- System roles (admin/manager/editor/viewer) are seeded automatically per
    -- org and can't be deleted/renamed from the API — only their permissions
    -- are editable. Custom role creation is not implemented in this pass.
    is_system BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(organization_id, name)
);

CREATE TABLE role_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
    permission VARCHAR(200) NOT NULL,
    UNIQUE(role_id, permission)
);

CREATE TABLE user_role_bindings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, role_id, workspace_id)
);

CREATE INDEX idx_roles_organization ON roles(organization_id);
CREATE INDEX idx_role_permissions_role ON role_permissions(role_id);
CREATE INDEX idx_user_role_bindings_user ON user_role_bindings(user_id);

-- Backfill: seed the 4 system roles (with the exact permission strings that
-- were hardcoded in packages/governance/src/permissions.ts) for every
-- organization that already exists, then bind every existing user to the
-- role matching their users.role column, in their first workspace.

INSERT INTO roles (organization_id, name, is_system)
SELECT o.id, r.name, true
FROM organizations o
CROSS JOIN (VALUES ('admin'), ('manager'), ('editor'), ('viewer')) AS r(name);

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission FROM roles r
JOIN (VALUES
    ('admin', 'agents:*'), ('admin', 'memory:*'), ('admin', 'audit:read'),
    ('admin', 'approvals:*'), ('admin', 'billing:wallet:read'), ('admin', 'tools:*'),
    ('admin', 'config:write'), ('admin', 'roles:read'), ('admin', 'roles:write'),

    ('manager', 'agents:create'), ('manager', 'agents:read'), ('manager', 'agents:update'),
    ('manager', 'agents:chat'), ('manager', 'memory:read'), ('manager', 'memory:write'),
    ('manager', 'approvals:read'), ('manager', 'approvals:approve'),
    ('manager', 'tools:read'), ('manager', 'tools:telegram-send'), ('manager', 'roles:read'),

    ('editor', 'agents:read'), ('editor', 'agents:update'), ('editor', 'agents:chat'),
    ('editor', 'memory:read'), ('editor', 'memory:write'),
    ('editor', 'tools:read'), ('editor', 'tools:telegram-send'),

    ('viewer', 'agents:read'), ('viewer', 'memory:read'), ('viewer', 'audit:read'), ('viewer', 'tools:read')
) AS p(role_name, permission) ON p.role_name = r.name;

INSERT INTO user_role_bindings (user_id, role_id, workspace_id)
SELECT u.id, r.id, w.id
FROM users u
JOIN roles r ON r.organization_id = u.organization_id AND r.name = u.role
JOIN LATERAL (
    SELECT id FROM workspaces WHERE organization_id = u.organization_id ORDER BY created_at LIMIT 1
) w ON true;
