-- User management (POST/GET /v1/users) needs its own permission pair,
-- distinct from roles:read/roles:write (editing a role's permissions vs.
-- creating a user and binding them to one). Backfill for orgs whose admin
-- role was already seeded before this migration — packages/governance/src/
-- permissions.ts's DEFAULT_ROLE_PERMISSIONS covers new orgs going forward.

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES ('admin', 'users:read'), ('admin', 'users:write')) AS p(role_name, permission)
  ON p.role_name = r.name
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission = p.permission
);
