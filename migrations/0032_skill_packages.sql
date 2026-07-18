-- RT-087: Skills per the open Agent Skills standard (agentskills.io) —
-- a folder-with-SKILL.md format the model reads via progressive disclosure
-- (name+description always visible; full instructions loaded only once the
-- model decides it needs them), instead of the existing `skills` table's
-- fixed JSON steps[].type:'tool' model (webhook/telegram only).
--
-- Deliberately additive, not a replacement: `skills`/`agent_skill_grants`
-- (migrations/0015_skills.sql) are untouched — RT-085/RT-086's tool-calling
-- loop still depends on them. v1 scope is instructions-only (confirmed by
-- the user, 2026-07-18): no `scripts/`/`assets/` file storage yet, since
-- executing arbitrary scripts is its own sandboxing decision, deferred.
-- `instructions` is the SKILL.md body (markdown); `description` is the
-- frontmatter's required short summary shown at the "discovery" layer.

CREATE TABLE agent_skill_packages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id),
    name VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    instructions TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'active', -- active, inactive
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE agent_skill_package_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
    skill_package_id UUID REFERENCES agent_skill_packages(id) ON DELETE CASCADE,
    granted_by_user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(agent_id, skill_package_id)
);

CREATE INDEX idx_agent_skill_packages_organization ON agent_skill_packages(organization_id);
CREATE INDEX idx_agent_skill_package_grants_agent ON agent_skill_package_grants(agent_id);
CREATE INDEX idx_agent_skill_package_grants_package ON agent_skill_package_grants(skill_package_id);

-- No role_permissions backfill needed: routes use the `skills:` permission
-- prefix (e.g. skills:package-create), already covered by admin's existing
-- skills:* wildcard (migrations/0015_skills.sql's comment) — conceptually
-- these ARE a kind of skill, just a different definition format.
