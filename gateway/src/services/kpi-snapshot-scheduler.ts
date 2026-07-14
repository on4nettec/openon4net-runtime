import type { KpiDefinition } from '@o2n/shared';
import type { AppContext } from '../context.js';
import { computeMetric } from './kpi-computation-service.js';

const CHECK_INTERVAL_MS = 24 * 60 * 60_000; // daily — KPI trends don't need finer granularity than that

interface AgentKpiRow {
  id: string;
  kpi_config: { kpis?: KpiDefinition[] } | null;
}

/**
 * Computes every non-manual KPI's `current` value once a day (RT-058) and
 * records a snapshot row for trend history. Same setInterval+disposer shape
 * as every other scheduler in this codebase (scheduler.ts, skill-proposal-
 * scheduler.ts, audit-retention-scheduler.ts). Agents with only manual KPIs
 * (or none) are skipped entirely — this never overwrites an admin-set value
 * unless the KPI opted into a metricType.
 */
export function startKpiSnapshotScheduler(ctx: AppContext): () => void {
  const timer = setInterval(() => {
    sweep(ctx).catch((err) => {
      console.error('KPI snapshot sweep failed:', err);
    });
  }, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}

async function sweep(ctx: AppContext): Promise<void> {
  const { rows } = await ctx.db.query<AgentKpiRow>(
    `SELECT id, kpi_config FROM agents WHERE kpi_config -> 'kpis' IS NOT NULL AND jsonb_array_length(kpi_config -> 'kpis') > 0`,
  );

  for (const row of rows) {
    const kpis = row.kpi_config?.kpis ?? [];
    let changed = false;

    for (const kpi of kpis) {
      if (!kpi.metricType || kpi.metricType === 'manual') continue;

      const value = await computeMetric(ctx.db, row.id, kpi.metricType, kpi.windowDays ?? 7);
      kpi.current = value;
      changed = true;

      await ctx.db.query(`INSERT INTO agent_kpi_snapshots (agent_id, kpi_name, value) VALUES ($1, $2, $3)`, [
        row.id,
        kpi.name,
        value,
      ]);
    }

    if (changed) {
      await ctx.db.query(`UPDATE agents SET kpi_config = kpi_config || $1::jsonb, updated_at = NOW() WHERE id = $2`, [
        JSON.stringify({ kpis }),
        row.id,
      ]);
    }
  }
}
