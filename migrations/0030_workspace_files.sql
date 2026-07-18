-- RT-025 — per-agent workspace files. Storage is workspace-scoped (matches
-- the existing agents.workspace_id relationship and RT-023's 1:1
-- workspace-per-agent convention), but the API surface (routes/agent-files.ts)
-- is agent-scoped so it can reuse requireAgentAccessible — the same access
-- check already gating chat/tools for a given agent.

CREATE TABLE IF NOT EXISTS workspace_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    uploaded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    filename VARCHAR(500) NOT NULL,
    -- Deliberately no stored URL column: a private file's URL is a
    -- presigned link that expires (lib/object-storage.ts), so it's
    -- generated fresh on every read (routes/agent-files.ts) instead.
    storage_key VARCHAR(1000) NOT NULL,
    content_type VARCHAR(200) NOT NULL,
    size_bytes BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_files_workspace ON workspace_files(workspace_id, created_at DESC);
