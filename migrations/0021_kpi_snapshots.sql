-- Outcome Engine foundation (roadmap Phase 4, week 35-36, RT-058). agents.
-- kpi_config.kpis[].current already exists (JSONB, admin-set) — this table
-- adds the trend-history half: every time the daily kpi-snapshot-scheduler
-- computes a non-manual KPI's value, it overwrites `current` in place AND
-- inserts a row here, so a chart/insight/anomaly-detector can look back
-- further than "whatever the latest value happens to be".
CREATE TABLE agent_kpi_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    kpi_name VARCHAR(255) NOT NULL,
    value NUMERIC NOT NULL,
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agent_kpi_snapshots_lookup ON agent_kpi_snapshots(agent_id, kpi_name, recorded_at);
