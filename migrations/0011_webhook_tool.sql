-- Webhook connector (RT-006) needs its own permission - backfill for orgs
-- whose roles were already seeded before this migration. admin already has
-- tools:* which covers it; manager/editor get tools:telegram-send's sibling.

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES ('manager', 'tools:webhook-send'), ('editor', 'tools:webhook-send')) AS p(role_name, permission)
  ON p.role_name = r.name
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission = p.permission
);
