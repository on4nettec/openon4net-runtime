-- Phase 2 (Skills) core: docs/spect/02_ARCHITECTURE/03-skill-engine.md,
-- docs/spect/03_DATABASE/01-schema-master.md §2.3.

CREATE TABLE skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    version VARCHAR(20) DEFAULT '1.0.0',
    definition JSONB NOT NULL, -- {trigger, steps} — see SkillDefinitionSchema in packages/shared
    source VARCHAR(20) DEFAULT 'auto', -- auto, manual, marketplace
    status VARCHAR(20) DEFAULT 'active', -- active, inactive, deprecated
    execution_count BIGINT DEFAULT 0,
    success_rate DECIMAL(5,2) DEFAULT 100.00,
    avg_duration_ms INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE agent_skill_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
    skill_id UUID REFERENCES skills(id) ON DELETE CASCADE,
    granted_by_user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(agent_id, skill_id)
);

CREATE INDEX idx_skills_organization ON skills(organization_id);
CREATE INDEX idx_agent_skill_grants_agent ON agent_skill_grants(agent_id);
CREATE INDEX idx_agent_skill_grants_skill ON agent_skill_grants(skill_id);

-- Not in schema-master.md's original §2.3 (named only in the architecture
-- doc's lifecycle, §2.1) — added here alongside the actual implementation.
-- Auto-detection (skill-pattern-detector.ts) writes rows here; a human
-- approves/rejects (routes/skill-proposals.ts) before a real `skills` row
-- is ever created — final activation is never automatic (§2.1).
CREATE TABLE skill_proposals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id),
    proposed_definition JSONB NOT NULL,
    pattern_metadata JSONB DEFAULT '{}', -- {actionType, occurrences, windowDays, ...} — why this was proposed
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, approved, rejected
    reviewed_by_user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_skill_proposals_org_status ON skill_proposals(organization_id, status);

-- No role_permissions backfill needed: skills:* is admin-only by default via
-- the existing wildcard match (packages/governance/src/permissions.ts), same
-- reasoning as migrations/0011_webhook_tool.sql's admin skip.
