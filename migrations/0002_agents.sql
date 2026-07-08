-- Agents (Digital Employees)
-- Source: docs/spect/03_DATABASE/01-schema-master.md §2.2 (agents table only —
-- agent_teams is not needed by any Sprint 0 task).

CREATE TABLE agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(100) NOT NULL, -- ceo, marketing, sales, support, ...
    status VARCHAR(20) DEFAULT 'active', -- active, paused, archived, terminated
    reports_to UUID REFERENCES agents(id),
    department VARCHAR(100),

    monthly_budget_cents BIGINT DEFAULT 50000, -- $500
    used_budget_cents BIGINT DEFAULT 0,

    model_preferences JSONB DEFAULT '{}', -- {"primary": "claude-3.5", "fallback": "gpt-4o"}
    permissions JSONB DEFAULT '{}',
    schedule JSONB DEFAULT '{}',
    kpi_config JSONB DEFAULT '{}',

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agents_organization ON agents(organization_id);
CREATE INDEX idx_agents_role ON agents(role);
