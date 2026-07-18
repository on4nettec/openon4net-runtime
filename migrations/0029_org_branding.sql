-- RT-030 — org branding (logo upload). Both nullable: no logo means the
-- default O2N mark is shown, never a broken <img>.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS logo_light_url VARCHAR(1000),
  ADD COLUMN IF NOT EXISTS logo_dark_url VARCHAR(1000);
