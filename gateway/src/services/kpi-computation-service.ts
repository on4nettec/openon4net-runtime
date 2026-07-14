import type { KpiMetricType } from '@o2n/shared';
import type { Queryable } from '../db.js';

export interface KpiSnapshot {
  value: number;
  recordedAt: string;
}

/** Trend history for one agent's KPI — the BI dashboard's data source (RT-059). */
export async function listKpiSnapshots(db: Queryable, agentId: string, kpiName: string, limit = 90): Promise<KpiSnapshot[]> {
  const { rows } = await db.query<{ value: string; recorded_at: string }>(
    `SELECT value, recorded_at FROM agent_kpi_snapshots
     WHERE agent_id = $1 AND kpi_name = $2
     ORDER BY recorded_at DESC LIMIT $3`,
    [agentId, kpiName, limit],
  );
  return rows.map((row) => ({ value: Number(row.value), recordedAt: row.recorded_at })).reverse(); // oldest first, for charting
}

/**
 * The three computable metric types (RT-058) — each a straightforward
 * aggregate over audit_logs, the only real time-series data source Runtime
 * has (see docs/spect/DONE.md's Phase 4 section for why: no separate
 * credit_transactions ledger, wallet mutations are logged here too).
 * `manual` isn't handled here — callers never invoke this for a manual KPI.
 */
export async function computeMetric(
  db: Queryable,
  agentId: string,
  metricType: Exclude<KpiMetricType, 'manual'>,
  windowDays: number,
): Promise<number> {
  switch (metricType) {
    case 'action_count': {
      const { rows } = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM audit_logs WHERE agent_id = $1 AND created_at > NOW() - ($2 || ' days')::interval`,
        [agentId, windowDays],
      );
      return Number(rows[0]?.count ?? 0);
    }
    case 'cost_cents': {
      const { rows } = await db.query<{ total: string | null }>(
        `SELECT COALESCE(SUM(cost_cents), 0) AS total FROM audit_logs WHERE agent_id = $1 AND created_at > NOW() - ($2 || ' days')::interval`,
        [agentId, windowDays],
      );
      return Number(rows[0]?.total ?? 0);
    }
    case 'success_rate': {
      const { rows } = await db.query<{ total: string; succeeded: string }>(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'success') AS succeeded
         FROM audit_logs WHERE agent_id = $1 AND created_at > NOW() - ($2 || ' days')::interval`,
        [agentId, windowDays],
      );
      const total = Number(rows[0]?.total ?? 0);
      const succeeded = Number(rows[0]?.succeeded ?? 0);
      return total === 0 ? 0 : Math.round((succeeded / total) * 10000) / 100; // percent, 2 decimal places
    }
    default: {
      const exhaustive: never = metricType;
      throw new Error(`Unknown computable metric type: ${String(exhaustive)}`);
    }
  }
}

/**
 * Same three aggregates as computeMetric, scoped to a whole organization
 * instead of one agent — shared by report-service.ts (RT-061) and
 * nl-query-service.ts (RT-064), whose questions may not name a single agent.
 */
export async function computeOrgMetric(
  db: Queryable,
  organizationId: string,
  metricType: Exclude<KpiMetricType, 'manual'>,
  windowDays: number,
): Promise<number> {
  switch (metricType) {
    case 'action_count': {
      const { rows } = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM audit_logs WHERE organization_id = $1 AND created_at > NOW() - ($2 || ' days')::interval`,
        [organizationId, windowDays],
      );
      return Number(rows[0]?.count ?? 0);
    }
    case 'cost_cents': {
      const { rows } = await db.query<{ total: string | null }>(
        `SELECT COALESCE(SUM(cost_cents), 0) AS total FROM audit_logs WHERE organization_id = $1 AND created_at > NOW() - ($2 || ' days')::interval`,
        [organizationId, windowDays],
      );
      return Number(rows[0]?.total ?? 0);
    }
    case 'success_rate': {
      const { rows } = await db.query<{ total: string; succeeded: string }>(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'success') AS succeeded
         FROM audit_logs WHERE organization_id = $1 AND created_at > NOW() - ($2 || ' days')::interval`,
        [organizationId, windowDays],
      );
      const total = Number(rows[0]?.total ?? 0);
      const succeeded = Number(rows[0]?.succeeded ?? 0);
      return total === 0 ? 0 : Math.round((succeeded / total) * 10000) / 100;
    }
    default: {
      const exhaustive: never = metricType;
      throw new Error(`Unknown computable metric type: ${String(exhaustive)}`);
    }
  }
}
