-- RT-014..018: Auth Method Registry (docs/spect/02_ARCHITECTURE/16-authentication-modes.md)

ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN oauth_provider VARCHAR(50);
ALTER TABLE users ADD COLUMN oauth_subject VARCHAR(255);

-- One (provider, subject) maps to at most one user; NULLs (users who never
-- signed in via oauth) are not constrained by a unique index in Postgres.
CREATE UNIQUE INDEX idx_users_oauth_identity ON users(oauth_provider, oauth_subject)
    WHERE oauth_provider IS NOT NULL AND oauth_subject IS NOT NULL;

-- RT-016: short-lived, one-time, revocable tokens. Only the hash is stored
-- (mirrors the password_hash pattern) so a DB read alone can't be replayed
-- as a login.
CREATE TABLE magic_link_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_magic_link_tokens_user ON magic_link_tokens(user_id);
-- verify() looks up by hash directly, not by user_id first.
CREATE INDEX idx_magic_link_tokens_hash ON magic_link_tokens(token_hash) WHERE used_at IS NULL;
