export interface DailyValue {
  date: string;
  value: number;
}

export interface AnomalyResult extends DailyValue {
  isAnomaly: boolean;
  zScore: number;
}

const Z_SCORE_THRESHOLD = 2;

/**
 * Z-score outlier check (RT-062 — roadmap Phase 4's "Anomaly detection") —
 * mean ± Z_SCORE_THRESHOLD·stddev over the trailing window, EXCLUDING the
 * point being tested from its own baseline. A simple statistical heuristic,
 * explicitly not a trained model. Needs at least 3 baseline points to
 * produce a meaningful stddev; earlier points are never flagged.
 */
export function detectAnomalies(dailyValues: DailyValue[]): AnomalyResult[] {
  return dailyValues.map((point, i) => {
    const baseline = dailyValues.slice(0, i).map((p) => p.value);
    if (baseline.length < 3) {
      return { ...point, isAnomaly: false, zScore: 0 };
    }

    const mean = baseline.reduce((sum, v) => sum + v, 0) / baseline.length;
    const variance = baseline.reduce((sum, v) => sum + (v - mean) ** 2, 0) / baseline.length;
    const stddev = Math.sqrt(variance);

    if (stddev === 0) {
      return { ...point, isAnomaly: point.value !== mean, zScore: point.value === mean ? 0 : Infinity };
    }

    const zScore = Math.round(((point.value - mean) / stddev) * 100) / 100;
    return { ...point, isAnomaly: Math.abs(zScore) > Z_SCORE_THRESHOLD, zScore };
  });
}
