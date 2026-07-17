-- RT-081: Control Plane's CP-026 seat model, mirrored on the Runtime side.
-- Written by activation-scheduler.ts on every successful check-in — never
-- user-editable via OrgService.update()'s self-service PATCH path, same
-- rule as plan/status (see org-service.ts's update() doc comment).

ALTER TABLE organizations ADD COLUMN activation_type VARCHAR(20) NOT NULL DEFAULT 'organizational';
ALTER TABLE organizations ADD COLUMN max_users INTEGER; -- NULL = unlimited
