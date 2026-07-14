export interface TrendPoint {
  x: number;
  y: number;
}

export interface TrendPrediction {
  predicted: number;
  slope: number;
  intercept: number;
}

/**
 * Ordinary least-squares linear regression (RT-063 — roadmap Phase 4's
 * "Predictive analytics") — explicitly a linear extrapolation heuristic,
 * not a real forecasting model. Returns null when there aren't enough
 * points (or all x values are identical) to fit a line.
 */
export function predictNext(points: TrendPoint[]): TrendPrediction | null {
  if (points.length < 2) return null;

  const n = points.length;
  const sumX = points.reduce((sum, p) => sum + p.x, 0);
  const sumY = points.reduce((sum, p) => sum + p.y, 0);
  const sumXY = points.reduce((sum, p) => sum + p.x * p.y, 0);
  const sumXX = points.reduce((sum, p) => sum + p.x * p.x, 0);

  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return null;

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  const nextX = points[points.length - 1]!.x + 1;
  const predicted = Math.round((slope * nextX + intercept) * 100) / 100;

  return { predicted, slope: Math.round(slope * 10000) / 10000, intercept: Math.round(intercept * 100) / 100 };
}
