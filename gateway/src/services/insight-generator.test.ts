import { describe, expect, it } from 'vitest';
import { generateInsights } from './insight-generator.js';

describe('generateInsights', () => {
  it('returns nothing with fewer than 2 snapshots', () => {
    expect(generateInsights('cost', [])).toEqual([]);
    expect(generateInsights('cost', [{ value: 10, recordedAt: '2026-01-01' }])).toEqual([]);
  });

  it('returns nothing when the change is below the threshold', () => {
    const snapshots = [
      { value: 100, recordedAt: '2026-01-01' },
      { value: 105, recordedAt: '2026-01-02' },
    ];
    expect(generateInsights('cost', snapshots)).toEqual([]);
  });

  it('emits an insight when the change exceeds the threshold', () => {
    const snapshots = [
      { value: 100, recordedAt: '2026-01-01' },
      { value: 150, recordedAt: '2026-01-02' },
    ];
    const insights = generateInsights('cost', snapshots);
    expect(insights).toHaveLength(1);
    expect(insights[0]!.percentChange).toBe(50);
    expect(insights[0]!.message).toContain('increased');
  });

  it('reports a decrease with the correct direction', () => {
    const snapshots = [
      { value: 200, recordedAt: '2026-01-01' },
      { value: 100, recordedAt: '2026-01-02' },
    ];
    const insights = generateInsights('cost', snapshots);
    expect(insights).toHaveLength(1);
    expect(insights[0]!.percentChange).toBe(-50);
    expect(insights[0]!.message).toContain('decreased');
  });

  it('returns nothing when the baseline value is zero (avoids divide-by-zero)', () => {
    const snapshots = [
      { value: 0, recordedAt: '2026-01-01' },
      { value: 100, recordedAt: '2026-01-02' },
    ];
    expect(generateInsights('cost', snapshots)).toEqual([]);
  });

  it('compares against the point `lookback` snapshots back, not always the first', () => {
    const snapshots = [
      { value: 1000, recordedAt: '2026-01-01' }, // far outside the lookback window
      { value: 100, recordedAt: '2026-01-02' },
      { value: 150, recordedAt: '2026-01-03' },
    ];
    const insights = generateInsights('cost', snapshots, 1);
    expect(insights).toHaveLength(1);
    expect(insights[0]!.percentChange).toBe(50); // 100 -> 150, not 1000 -> 150
  });
});
