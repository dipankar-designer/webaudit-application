import { describe, expect, it } from 'vitest';
import { withinNoise } from './PerformanceInsights';

describe('scan comparison: lab noise is not reported as better or worse', () => {
  it('uses evidence-based variability thresholds per measurement', () => {
    expect(withinNoise('score', 2, 80)).toBe(true);
    expect(withinNoise('score', 5, 80)).toBe(false);
    expect(withinNoise('ms', 15, 666)).toBe(true); // 2% of FCP
    expect(withinNoise('ms', 400, 2500)).toBe(false); // 16% of LCP
    expect(withinNoise('cls', 0.005, 0.02)).toBe(true);
    expect(withinNoise('cls', 0.05, 0.02)).toBe(false);
    expect(withinNoise('bytes', 10_000, 1_000_000)).toBe(true);
    expect(withinNoise('bytes', 200_000, 1_000_000)).toBe(false);
    expect(withinNoise('count', 1, 40)).toBe(false); // request counts are exact
  });
});
