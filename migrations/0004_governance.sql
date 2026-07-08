-- Governance & Audit
-- Source: docs/spect/03_DATABASE/01-schema-master.md §2.5

CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id),
    agent_id UUID REFERENCES agents(id),
    user_id UUID REFERENCES users(id),
    action_type VARCHAR(100) NOT NULL, -- send-email, create-contract, delete-file, agent-chat, agent-create, ...
    action_data JSONB NOT NULL, -- includes trace_id: no dedicated column, see packages/shared AuditLog type
    model_used VARCHAR(100),
    cost_cents INTEGER,
    status VARCHAR(20) DEFAULT 'success', -- success, failed, pending
    approval_status VARCHAR(20) DEFAULT 'auto', -- auto, pending, approved, rejected
    approved_by UUID REFERENCES users(id),
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE approval_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id),
    agent_id UUID REFERENCES agents(id),
    action_data JSONB NOT NULL,
    reason TEXT,
    status VARCHAR(20) DEFAULT 'pending', -- pending, approved, rejected, expired
    assigned_to UUID REFERENCES users(id),
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_org ON audit_logs(organization_id, created_at);
CREATE INDEX idx_audit_logs_agent ON audit_logs(agent_id);
