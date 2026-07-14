-- Workflow Engine v1 (roadmap Phase 3, week 31-32, item 17 — covers item 19
-- "task delegation" via the `agent` step type, see packages/shared/src/
-- schemas/workflow.ts's scoping comment).
CREATE TABLE workflows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    definition JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'draft', -- draft | active | archived
    created_by_user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_workflows_org ON workflows(organization_id);

CREATE TABLE workflow_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | running | paused | success | failed
    current_step_id VARCHAR(255),
    context JSONB NOT NULL DEFAULT '{}',
    -- Set while status='paused' on a `human` step; routes/approvals.ts's
    -- approve/reject handlers check this to resume the run instead of (or
    -- alongside) the ordinary chat-resume path.
    pending_approval_id UUID REFERENCES approval_queue(id) ON DELETE SET NULL,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_workflow_runs_workflow ON workflow_runs(workflow_id);
CREATE INDEX idx_workflow_runs_org ON workflow_runs(organization_id);

-- Per-step execution log, for audit/debugging (mirrors how skill_proposals/
-- audit_logs give visibility into automated actions elsewhere in Runtime).
CREATE TABLE workflow_run_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    step_id VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL, -- running | completed | failed | skipped
    result JSONB,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_workflow_run_steps_run ON workflow_run_steps(workflow_run_id);
