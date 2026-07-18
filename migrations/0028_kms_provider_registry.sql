-- RT-019 — KMS Provider Registry infrastructure (02_ARCHITECTURE/
-- 11-secrets-and-key-management.md §4.1). Metadata alongside each
-- encrypted secret so a future re-encrypt-on-read migration (key rotation,
-- or eventually a real Vault provider — RT-020, currently deferred) can
-- tell which provider/key encrypted a given row without guessing.
--
-- Existing rows default to ('env', 'current', 1) — the exact provider/key
-- they were already encrypted with (the only provider that has ever
-- existed here), so this migration needs no data backfill or re-encryption.

ALTER TABLE llm_configs
  ADD COLUMN IF NOT EXISTS kms_provider_id VARCHAR(50) NOT NULL DEFAULT 'env',
  ADD COLUMN IF NOT EXISTS kms_key_id VARCHAR(50) NOT NULL DEFAULT 'current',
  ADD COLUMN IF NOT EXISTS kms_key_version INT NOT NULL DEFAULT 1;

ALTER TABLE sso_configs
  ADD COLUMN IF NOT EXISTS kms_provider_id VARCHAR(50) NOT NULL DEFAULT 'env',
  ADD COLUMN IF NOT EXISTS kms_key_id VARCHAR(50) NOT NULL DEFAULT 'current',
  ADD COLUMN IF NOT EXISTS kms_key_version INT NOT NULL DEFAULT 1;
