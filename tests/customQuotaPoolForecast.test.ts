import { describe, expect, test } from 'bun:test';
import {
  appendSample,
  compactSamples,
  parseHistory,
  serializeHistory,
  type HistorySample,
} from '@/custom/quotaOverview/history';
import {
  burnRate,
  projectPool,
  recordedSeries,
  seriesValuesAt,
  sumValues,
  type PoolAccount,
} from '@/custom/quotaOverview/poolForecast';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

const account = (patch: Partial<PoolAccount> & { name: string }): PoolAccount => ({
  key: `claude:${patch.name}`,
  label: patch.name,
  priority: 0,
  enabled: true,
  remaining: 100,
  resetAtMs: null,
  periodMs: 168 * HOUR,
  blockedUntilMs: null,
  samples: [],
  ...patch,
});

describe('quota history storage', () => {
  test('rapid samples replace the tip but keep one anchor per interval', () => {
    let samples: HistorySample[] = [];
    for (let minute = 0; minute <= 30; minute += 2) {
      samples = appendSample(samples, [NOW + minute * MINUTE, 90 - minute / 2, null]);
    }
    expect(samples.length).toBeLessThan(6);
    expect(samples[0][0]).toBe(NOW);
    expect(samples[samples.length - 1]).toEqual([NOW + 30 * MINUTE, 75, null]);
  });

  test('a rise or a new reset window always starts a new sample', () => {
    const samples = appendSample(
      appendSample([[NOW, 50, NOW + DAY]], [NOW + MINUTE, 40, NOW + DAY]),
      [NOW + 2 * MINUTE, 100, NOW + 8 * DAY]
    );
    expect(samples).toHaveLength(3);
  });

  test('compaction drops expired samples and collapses flat runs', () => {
    const samples: HistorySample[] = [
      [NOW - 30 * DAY, 10, null],
      [NOW - 3 * HOUR, 80, null],
      [NOW - 2 * HOUR, 80, null],
      [NOW - HOUR, 80, null],
      [NOW, 80, null],
    ];
    expect(compactSamples(samples, NOW)).toEqual([
      [NOW - 3 * HOUR, 80, null],
      [NOW, 80, null],
    ]);
  });

  test('round-trips through minute-resolution storage and ignores junk', () => {
    const history = { 'claude:a.json': [[NOW, 55.55, NOW + DAY] as HistorySample] };
    const parsed = parseHistory(serializeHistory(history));
    expect(parsed['claude:a.json']).toEqual([[NOW, 55.6, NOW + DAY]]);
    expect(parseHistory('{"x":[[1,"a",0]],"y":5}')).toEqual({});
    expect(parseHistory('not json')).toEqual({});
  });
});

describe('pool forecast', () => {
  test('recorded series draws a reset at its instant and labels the gain', () => {
    const a = account({
      name: 'a',
      remaining: 90,
      samples: [
        [NOW - 4 * HOUR, 30, NOW - 2 * HOUR],
        [NOW - HOUR, 90, NOW + 7 * DAY],
      ],
    });
    const { points, jumps } = recordedSeries([a], NOW);
    expect(jumps).toEqual([{ t: NOW - 2 * HOUR, gain: 70 }]);
    expect(seriesValuesAt(points, NOW - 3 * HOUR)).toEqual([30]);
    expect(seriesValuesAt(points, NOW)).toEqual([90]);
  });

  test('a credential without history backfills instead of jumping into the pool', () => {
    const a = account({
      name: 'a',
      remaining: 50,
      samples: [
        [NOW - 2 * HOUR, 60, null],
        [NOW, 50, null],
      ],
    });
    const b = account({ name: 'b', remaining: 80 });
    const { points, jumps } = recordedSeries([a, b], NOW);
    expect(jumps).toEqual([]);
    expect(sumValues(points[0].values)).toBe(140);
  });

  test('burn rate averages consumption over the window, ignoring resets', () => {
    const a = account({
      name: 'a',
      samples: [
        [NOW - 6 * HOUR, 90, null],
        [NOW - 3 * HOUR, 84, null],
        [NOW, 78, null],
      ],
    });
    expect(burnRate([a], NOW, 3)).toBeCloseTo(2);
    expect(burnRate([a], NOW, 6)).toBeCloseTo(2);
    expect(burnRate([account({ name: 'b' })], NOW, 3)).toBeNull();
  });

  test('fill-first drains the first credential, then the next, then the pool is empty', () => {
    const projection = projectPool({
      accounts: [
        account({ name: 'a', remaining: 10 }),
        account({ name: 'b', remaining: 20 }),
        account({ name: 'c', remaining: 50, enabled: false }),
      ],
      nowMs: NOW,
      untilMs: NOW + 2 * DAY,
      burnPerHour: 1,
      mode: 'fill-first',
    });
    expect(projection.firstEmpty).toEqual({ t: NOW + 10 * HOUR, index: 0 });
    expect(projection.poolEmptyMs).toBe(NOW + 30 * HOUR);
    expect(seriesValuesAt(projection.points, NOW + 15 * HOUR)).toEqual([0, 15, 50]);
  });

  test('higher priority tiers take traffic first; spread splits within a tier', () => {
    const projection = projectPool({
      accounts: [
        account({ name: 'hi', priority: 5, remaining: 100 }),
        account({ name: 'a', remaining: 100 }),
        account({ name: 'b', remaining: 100 }),
      ],
      nowMs: NOW,
      untilMs: NOW + 200 * HOUR,
      burnPerHour: 2,
      mode: 'spread',
    });
    expect(seriesValuesAt(projection.points, NOW + 50 * HOUR)).toEqual([0, 100, 100]);
    expect(seriesValuesAt(projection.points, NOW + 60 * HOUR)).toEqual([0, 90, 90]);
  });

  test('resets refill to 100% every period and report the gain', () => {
    const projection = projectPool({
      accounts: [account({ name: 'a', remaining: 40, resetAtMs: NOW - HOUR, periodMs: DAY })],
      nowMs: NOW,
      untilMs: NOW + 3 * DAY,
      burnPerHour: 1,
      mode: 'fill-first',
    });
    expect(projection.nextReset).toEqual({ t: NOW + 23 * HOUR, gain: 83 });
    expect(projection.jumps.map((jump) => jump.t)).toEqual([
      NOW + 23 * HOUR,
      NOW + 47 * HOUR,
      NOW + 71 * HOUR,
    ]);
    expect(projection.firstEmpty).toBeNull();
  });

  test('blocked credentials wait for their cooldown', () => {
    const projection = projectPool({
      accounts: [
        account({ name: 'a', remaining: 100, blockedUntilMs: NOW + 5 * HOUR }),
        account({ name: 'b', remaining: 100 }),
      ],
      nowMs: NOW,
      untilMs: NOW + 10 * HOUR,
      burnPerHour: 1,
      mode: 'fill-first',
    });
    expect(seriesValuesAt(projection.points, NOW + 10 * HOUR)).toEqual([95, 95]);
  });

  test('no burn means a flat projection and no empties', () => {
    const projection = projectPool({
      accounts: [account({ name: 'a', remaining: 30 })],
      nowMs: NOW,
      untilMs: NOW + DAY,
      burnPerHour: 0,
      mode: 'fill-first',
    });
    expect(projection.poolEmptyMs).toBeNull();
    expect(projection.drain).toEqual([{ t: NOW, rate: 0 }]);
  });
});
