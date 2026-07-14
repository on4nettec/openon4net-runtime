-- Agent-to-agent messaging (roadmap Phase 3, week 31-32, item 16).
-- Deliberately async/fire-and-forget: a sender enqueues, agent-message-
-- scheduler.ts polls and delivers as a system-initiated chat turn on the
-- recipient (same "userId: null" convention as services/scheduler.ts).
-- Distinct from the workflow engine's `agent` step (item 17), which calls
-- ChatService.chat() synchronously and needs the result immediately.
CREATE TABLE agent_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    from_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL, -- nullable: a human/system can also send
    to_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | delivered | failed
    created_at TIMESTAMPTZ DEFAULT NOW(),
    delivered_at TIMESTAMPTZ
);

CREATE INDEX idx_agent_messages_org ON agent_messages(organization_id);
CREATE INDEX idx_agent_messages_to ON agent_messages(to_agent_id);
-- The scheduler's poll query filters on this.
CREATE INDEX idx_agent_messages_pending ON agent_messages(status) WHERE status = 'pending';
