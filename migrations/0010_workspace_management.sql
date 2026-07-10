-- Workspace management (POST/GET /v1/workspaces) needs its own permission
-- pair. Backfill for orgs whose roles were already seeded before this
-- migration — packages/governance/src/permissions.ts's
-- DEFAULT_ROLE_PERMISSIONS covers new orgs going forward.

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
    ('admin', 'workspaces:read'), ('admin', 'workspaces:write'),
    ('manager', 'workspaces:read')
) AS p(role_name, permission)
  ON p.role_name = r.name
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission = p.permission
);
