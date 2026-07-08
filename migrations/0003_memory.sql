-- Memory L2: conversations + messages
-- Source: docs/spect/03_DATABASE/01-schema-master.md §2.4 (conversations/messages
-- only — memory_graph_*, company_knowledge, and pgvector are out of MVP scope
-- per docs/spect/09_TASKS/08-scope-guardrails-mvp.md §4).

CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    title VARCHAR(255),
    summary TEXT,
    tags TEXT[],
    message_count INTEGER DEFAULT 0,
    token_count INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active', -- active, summarized, archived
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL, -- user, agent, system, tool
    content TEXT NOT NULL,
    model VARCHAR(100),
    cost_cents INTEGER DEFAULT 0,
    tokens INTEGER DEFAULT 0,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
