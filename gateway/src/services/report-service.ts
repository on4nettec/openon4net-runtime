import type { Queryable } from '../db.js';
import { generateInsights } from './insight-generator.js';
import { computeOrgMetric, listKpiSnapshots } from './kpi-computation-service.js';

export type ReportPeriod = 'daily' | 'weekly';

export interface ReportKpiInsight {
  agentId: string;
  agentName: string;
  kpiName: string;
  message: string;
}

export interface Report {
  organizationId: string;
  period: ReportPeriod;
  generatedAt: string;
  totalActions: number;
  totalCostCents: number;
  successRate: number;
  insights: ReportKpiInsight[];
}

interface AgentRow {
  id: string;
  name: string;
  kpi_config: { kpis?: { name: string; metricType?: string }[] } | null;
}

function windowDaysFor(period: ReportPeriod): number {
  return period === 'daily' ? 1 : 7;
}

/**
 * Org-wide digest for RT-061 auto-reporting: cost/action-count/success-rate
 * aggregated directly from audit_logs, plus one insight sentence per KPI
 * whose trend crossed the threshold in insight-generator.ts. Shared by the
 * daily scheduler (report-scheduler.ts) and the on-demand
 * GET /v1/reports/latest route, so the feature works identically whether or
 * not a report was ever actually scheduled/emailed.
 */
export async function buildReport(db: Queryable, organizationId: string, period: ReportPeriod): Promise<Report> {
  const windowDays = windowDaysFor(period);

  const [totalActions, totalCostCents, successRate] = await Promise.all([
    computeOrgMetric(db, organizationId, 'action_count', windowDays),
    computeOrgMetric(db, organizationId, 'cost_cents', windowDays),
    computeOrgMetric(db, organizationId, 'success_rate', windowDays),
  ]);

  const { rows: agents } = await db.query<AgentRow>(
    `SELECT id, name, kpi_config FROM agents WHERE organization_id = $1 AND kpi_config -> 'kpis' IS NOT NULL AND jsonb_array_length(kpi_config -> 'kpis') > 0`,
    [organizationId],
  );

  const insights: ReportKpiInsight[] = [];
  for (const agent of agents) {
    for (const kpi of agent.kpi_config?.kpis ?? []) {
      const snapshots = await listKpiSnapshots(db, agent.id, kpi.name);
      for (const insight of generateInsights(kpi.name, snapshots)) {
        insights.push({ agentId: agent.id, agentName: agent.name, kpiName: kpi.name, message: insight.message });
      }
    }
  }

  return {
    organizationId,
    period,
    generatedAt: new Date().toISOString(),
    totalActions,
    totalCostCents,
    successRate,
    insights,
  };
}

export function reportToText(report: Report): string {
  const lines = [
    `Open on4net ${report.period} report — ${report.generatedAt}`,
    ``,
    `Actions: ${report.totalActions}`,
    `Cost: $${(report.totalCostCents / 100).toFixed(2)}`,
    `Success rate: ${report.successRate}%`,
  ];
  if (report.insights.length > 0) {
    lines.push('', 'Insights:');
    for (const insight of report.insights) {
      lines.push(`- [${insight.agentName}] ${insight.message}`);
    }
  }
  return lines.join('\n');
}
