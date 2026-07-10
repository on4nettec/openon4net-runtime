-- ABAC Policy Layer (RT-008) — docs/spect/02_ARCHITECTURE/10-rbac-and-policy.md
-- §6/§8 "minimal" policies table. Generalizes the previously-hardcoded
-- APPROVAL_THRESHOLD_CENTS env check into admin-configurable, per-org rules
-- (still additive with that env default, not a replacement — see
-- gateway/src/services/chat-service.ts).

CREATE TABLE policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    definition JSONB NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_policies_organization ON policies(organization_id) WHERE is_active = true;

-- Backfill policies:read/write for existing orgs' admin role (new orgs get
-- it from DEFAULT_ROLE_PERMISSIONS going forward).
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES ('admin', 'policies:read'), ('admin', 'policies:write')) AS p(role_name, permission)
  ON p.role_name = r.name
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission = p.permission
);
