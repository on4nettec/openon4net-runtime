export interface InsightSnapshotPoint {
  value: number;
  recordedAt: string;
}

export interface Insight {
  kpiName: string;
  message: string;
  percentChange: number;
}

const CHANGE_THRESHOLD_PERCENT = 15;

/**
 * Threshold-crossing template sentences, not generative NLG (RT-060 —
 * roadmap Phase 4's "Automated insights"). Compares the latest snapshot
 * against the value from `lookback` points back; emits one Insight when the
 * |% change| exceeds CHANGE_THRESHOLD_PERCENT. Deterministic, no LLM call.
 */
export function generateInsights(kpiName: string, snapshots: InsightSnapshotPoint[], lookback = 7): Insight[] {
  if (snapshots.length < 2) return [];

  const latest = snapshots[snapshots.length - 1]!;
  const baselineIndex = Math.max(0, snapshots.length - 1 - lookback);
  const baseline = snapshots[baselineIndex]!;

  if (baseline.value === 0) return [];

  const percentChange = Math.round(((latest.value - baseline.value) / Math.abs(baseline.value)) * 1000) / 10;
  if (Math.abs(percentChange) < CHANGE_THRESHOLD_PERCENT) return [];

  const direction = percentChange > 0 ? 'increased' : 'decreased';
  const days = Math.max(1, snapshots.length - 1 - baselineIndex);
  return [
    {
      kpiName,
      percentChange,
      message: `${kpiName} ${direction} by ${Math.abs(percentChange)}% over the last ${days} snapshot(s) (${baseline.value} → ${latest.value}).`,
    },
  ];
}
