import { describe, expect, it } from 'vitest';
import { predictNext } from './trend-predictor.js';

describe('predictNext', () => {
  it('returns null with fewer than 2 points', () => {
    expect(predictNext([])).toBeNull();
    expect(predictNext([{ x: 0, y: 5 }])).toBeNull();
  });

  it('returns null when all x values are identical (degenerate line)', () => {
    expect(
      predictNext([
        { x: 1, y: 5 },
        { x: 1, y: 10 },
      ]),
    ).toBeNull();
  });

  it('extrapolates a perfect linear trend exactly', () => {
    const points = [
      { x: 0, y: 10 },
      { x: 1, y: 20 },
      { x: 2, y: 30 },
    ];
    const result = predictNext(points);
    expect(result).not.toBeNull();
    expect(result!.slope).toBe(10);
    expect(result!.intercept).toBe(10);
    expect(result!.predicted).toBe(40); // next x = 3 -> 10*3 + 10
  });

  it('fits a best-effort line through noisy points', () => {
    const points = [
      { x: 0, y: 10 },
      { x: 1, y: 19 },
      { x: 2, y: 31 },
      { x: 3, y: 39 },
    ];
    const result = predictNext(points);
    expect(result).not.toBeNull();
    expect(result!.slope).toBeGreaterThan(9);
    expect(result!.slope).toBeLessThan(11);
  });
});
