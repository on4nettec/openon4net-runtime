import { describe, expect, it } from 'vitest';
import { detectAnomalies } from './anomaly-detector.js';

describe('detectAnomalies', () => {
  it('never flags a point with fewer than 3 baseline points', () => {
    const results = detectAnomalies([
      { date: '2026-01-01', value: 10 },
      { date: '2026-01-02', value: 10 },
      { date: '2026-01-03', value: 10000 },
    ]);
    expect(results.every((r) => !r.isAnomaly)).toBe(true);
  });

  it('flags a value far outside the trailing baseline', () => {
    const stable = Array.from({ length: 10 }, (unused, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, value: 100 }));
    const results = detectAnomalies([...stable, { date: '2026-01-11', value: 10000 }]);
    const last = results[results.length - 1]!;
    expect(last.isAnomaly).toBe(true);
    expect(last.zScore).toBeGreaterThan(2);
  });

  it('does not flag a value within normal variance of the baseline', () => {
    const noisy = [95, 105, 98, 102, 97, 103, 99, 101, 96, 104].map((value, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      value,
    }));
    const results = detectAnomalies([...noisy, { date: '2026-01-11', value: 100 }]);
    const last = results[results.length - 1]!;
    expect(last.isAnomaly).toBe(false);
  });

  it('handles a zero-stddev baseline without dividing by zero', () => {
    const flat = Array.from({ length: 5 }, (unused, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, value: 50 }));
    const results = detectAnomalies([...flat, { date: '2026-01-06', value: 50 }]);
    expect(results[results.length - 1]!.isAnomaly).toBe(false);

    const jump = detectAnomalies([...flat, { date: '2026-01-06', value: 999 }]);
    expect(jump[jump.length - 1]!.isAnomaly).toBe(true);
  });
});
