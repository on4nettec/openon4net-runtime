-- RT-080: per-agent Plugin grants, mirroring agent_skill_grants
-- (migrations/0015_skills.sql) exactly. Unlike Skills, Plugins have no
-- local mirror row in Runtime (install stays entirely in Marketplace's own
-- `plugins`/`plugin_installs` tables — see routes/marketplace.ts) — so
-- plugin_id here is a cross-plane reference by id only, same convention as
-- Marketplace's own plugin_installs.organization_id. No FK: the referenced
-- row lives in a different service/database entirely.

CREATE TABLE agent_plugin_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
    plugin_id UUID NOT NULL,
    granted_by_user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(agent_id, plugin_id)
);

CREATE INDEX idx_agent_plugin_grants_agent ON agent_plugin_grants(agent_id);
CREATE INDEX idx_agent_plugin_grants_plugin ON agent_plugin_grants(plugin_id);
