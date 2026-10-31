import { describe, expect, test } from 'bun:test';
import { buildOverviewCredential, rollPastResets } from '@/custom/quotaOverview/model';
import { readPassiveQuota } from '@/custom/quotaOverview/passiveQuota';
import type { QuotaCardState } from '@/features/quota/providers';
import type { AuthFileItem } from '@/types';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const OBSERVED = NOW - 2 * HOUR;
const seconds = (ms: number) => String(Math.round(ms / 1000));

const fileWith = (type: string, signals: Record<string, string>, observedAt = OBSERVED) =>
  ({
    name: `${type}.json`,
    type,
    quota: { observed_at: new Date(observedAt).toISOString(), signals },
  }) as unknown as AuthFileItem;

const claudeSignals = {
  'Anthropic-Ratelimit-Unified-5h-Utilization': '0.1',
  'Anthropic-Ratelimit-Unified-5h-Reset': seconds(NOW + HOUR),
  'Anthropic-Ratelimit-Unified-7d-Utilization': '0.42',
  'Anthropic-Ratelimit-Unified-7d-Reset': seconds(NOW + 48 * HOUR),
};

describe('passive quota from CLIProxy observations', () => {
  test('reads Claude utilization fractions and reset instants', () => {
    const passive = readPassiveQuota('claude', fileWith('claude', claudeSignals));
    expect(passive?.observedAtMs).toBe(OBSERVED);
    expect(passive?.windows.map((w) => [w.id, w.remaining, w.resetAtMs])).toEqual([
      ['five-hour', 90, NOW + HOUR],
      ['seven-day', 58, NOW + 48 * HOUR],
    ]);
  });

  test('reads Codex windows by length, resolving relative resets', () => {
    const passive = readPassiveQuota(
      'codex',
      fileWith('codex', {
        'X-Codex-Primary-Used-Percent': '20',
        'X-Codex-Primary-Window-Minutes': '300',
        'X-Codex-Secondary-Used-Percent': '35',
        'X-Codex-Secondary-Window-Minutes': '10080',
        'X-Codex-Secondary-Reset-After-Seconds': '3600',
      })
    );
    expect(passive?.windows.map((w) => [w.id, w.remaining, w.resetAtMs, w.periodHours])).toEqual([
      ['five-hour', 80, null, 5],
      ['weekly', 65, OBSERVED + HOUR, 168],
    ]);
  });

  test('ignores missing or malformed observations and other providers', () => {
    expect(readPassiveQuota('claude', { name: 'a', type: 'claude' } as AuthFileItem)).toBeNull();
    expect(readPassiveQuota('claude', fileWith('claude', {}))).toBeNull();
    expect(readPassiveQuota('kimi', fileWith('kimi', claudeSignals))).toBeNull();
  });

  test('a credential with no live quota uses the proxy reading', () => {
    const credential = buildOverviewCredential(
      { type: 'claude', file: fileWith('claude', claudeSignals) },
      undefined,
      NOW
    );
    expect(credential.source).toBe('proxy');
    expect(credential.primary?.remaining).toBe(58);
    expect(credential.sample).toEqual([OBSERVED, 58, NOW + 48 * HOUR]);
  });

  test('the newer reading wins; live-only limits survive a newer proxy reading', () => {
    const live = (observedAt: number) =>
      ({
        status: 'success',
        observedAt: new Date(observedAt).toISOString(),
        windows: [
          {
            id: 'seven-day',
            label: '7d',
            usedPercent: 10,
            resetAtMs: NOW + 48 * HOUR,
            periodHours: 168,
          },
          {
            id: 'seven-day-fable',
            label: 'Fable',
            usedPercent: 5,
            resetAtMs: null,
            periodHours: 168,
          },
        ],
      }) as unknown as QuotaCardState;
    const file = fileWith('claude', claudeSignals);
    const newerLive = buildOverviewCredential({ type: 'claude', file }, live(NOW - HOUR), NOW);
    expect(newerLive.source).toBe('live');
    expect(newerLive.primary?.remaining).toBe(90);

    const olderLive = buildOverviewCredential({ type: 'claude', file }, live(NOW - 5 * HOUR), NOW);
    expect(olderLive.source).toBe('proxy');
    expect(olderLive.windows.map((w) => [w.id, w.remaining])).toEqual([
      ['seven-day', 58],
      ['seven-day-fable', 95],
      ['five-hour', 90],
    ]);
  });

  test('readings taken before a reset count as full, with the next reset', () => {
    const [rolled] = rollPastResets(
      [{ id: 'seven-day', label: '', remaining: 20, resetAtMs: NOW - HOUR, periodHours: 168 }],
      NOW
    );
    expect(rolled.remaining).toBe(100);
    expect(rolled.resetAtMs).toBe(NOW + 167 * HOUR);
  });
});
