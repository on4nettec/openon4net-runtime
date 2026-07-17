-- RT-083 (docs/spect/06_MEETINGS/05-self-service-signup-and-activation-model.md):
-- i18n. Mirrors Control Plane's CP-028 org-level default, plus Runtime's
-- own per-user override (meeting 5: "سازمان عربی، یک کاربر فرانسوی توی
-- همون سازمان" — Control Plane has no users table concept for this, so the
-- per-user part only ever made sense here).

ALTER TABLE organizations ADD COLUMN language VARCHAR(10) NOT NULL DEFAULT 'en';

-- NULL = no preference chosen yet (inherits organizations.language) — this
-- is also the exact signal the frontend uses to show the first-login
-- language picker (see routes/users.ts's GET /v1/users/me).
ALTER TABLE users ADD COLUMN language VARCHAR(10);
