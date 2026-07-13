-- Workspace archive (soft-delete). agents.workspace_id has ON DELETE CASCADE,
-- so a real DELETE on workspaces would silently wipe out every agent (and
-- their conversations) in it -- archive is the only safe "remove" story.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'; -- active | archived
