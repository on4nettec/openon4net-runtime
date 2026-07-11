-- RT-024: per-user access to specific agents (docs/spect/03_DATABASE/01-schema-master.md §2.2).
-- Creating/editing/deleting an agent stays admin-only (unchanged); this
-- table controls who else may see/use a given agent at all. admin bypasses
-- this table entirely (see gateway/src/services/agent-access-service.ts).

CREATE TABLE agent_access_bindings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    access_role VARCHAR(20) NOT NULL DEFAULT 'member', -- owner | member | viewer
    granted_by_user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(agent_id, user_id)
);

CREATE INDEX idx_agent_access_bindings_user ON agent_access_bindings(user_id);
CREATE INDEX idx_agent_access_bindings_agent ON agent_access_bindings(agent_id);

-- Backfill: grant every existing agent's creator an 'owner' binding, found
-- via the most plausible prior actor — the earliest 'agent-create' audit
-- log row for that agent. Agents created before audit logging existed (or
-- with no matching row) get no backfilled binding; a non-admin who already
-- lacked any real tie to such an agent gets no new access, which is the
-- correct least-privilege default rather than blanket-granting everyone.
INSERT INTO agent_access_bindings (agent_id, user_id, access_role, granted_by_user_id)
SELECT DISTINCT ON (a.id) a.id, al.user_id, 'owner', al.user_id
FROM agents a
JOIN audit_logs al ON al.agent_id = a.id AND al.action_type = 'agent-create' AND al.user_id IS NOT NULL
ORDER BY a.id, al.created_at ASC
ON CONFLICT (agent_id, user_id) DO NOTHING;

-- No role_permissions backfill needed: agents:access:grant/revoke are
-- admin-only for now, and admin's existing 'agents:*' already covers them
-- (see hasPermission()'s wildcard match in packages/governance/src/permissions.ts)
-- — same reasoning as migrations/0011_webhook_tool.sql's admin skip.
