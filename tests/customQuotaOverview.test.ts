import { describe, expect, test } from 'bun:test';
import {
  backAtMs,
  buildOverviewCredential,
  buildProviderSummaries,
  credentialLabel,
  maskEmails,
  resetUrgency,
  firstInLine,
  formatCountdown,
  pickPrimaryWindow,
  sortCredentials,
  type OverviewWindow,
} from '@/custom/quotaOverview/model';
import type { QuotaCardState } from '@/features/quota/providers';
import type { AuthFileItem } from '@/types';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

const claudeQuota = (weeklyUsed: number, fiveHourUsed: number, weeklyResetMs: number) =>
  ({
    status: 'success',
    planType: 'Max',
    windows: [
      {
        id: 'five-hour',
        label: '5-hour limit',
        usedPercent: fiveHourUsed,
        resetLabel: '',
        resetAtMs: NOW + 2 * HOUR,
        periodHours: 5,
      },
      {
        id: 'seven-day',
        label: '7-day limit',
        usedPercent: weeklyUsed,
        resetLabel: '',
        resetAtMs: weeklyResetMs,
        periodHours: 168,
      },
      {
        id: 'seven-day-fable',
        label: '7-day Fable 5',
        usedPercent: 0,
        resetLabel: '',
        resetAtMs: weeklyResetMs,
        periodHours: 168,
      },
    ],
  }) as unknown as QuotaCardState;

const credential = (name: string, quota: QuotaCardState | undefined, file: Partial<AuthFileItem> = {}) =>
  buildOverviewCredential({ type: 'claude', file: { name, type: 'claude', ...file } }, quota, NOW);

const window = (patch: Partial<OverviewWindow>): OverviewWindow => ({
  id: 'w',
  label: 'w',
  remaining: 50,
  resetAtMs: null,
  periodHours: null,
  ...patch,
});

describe('quota overview model', () => {
  test('normalizes Claude windows to percent remaining and picks the 7-day limit', () => {
    const c = credential('a.json', claudeQuota(30, 90, NOW + 48 * HOUR));
    expect(c.windows.map((w) => w.remaining)).toEqual([10, 70, 100]);
    expect(c.primary?.id).toBe('seven-day');
    expect(c.plan).toBe('Max');
  });

  test('falls back to the longest window up to a week', () => {
    const picked = pickPrimaryWindow([
      window({ id: 'a', periodHours: 5 }),
      window({ id: 'b', periodHours: 24 }),
      window({ id: 'c', periodHours: 720 }),
    ]);
    expect(picked?.id).toBe('b');
  });

  test('back-at is the latest reset among exhausted limits', () => {
    expect(
      backAtMs(
        [
          window({ remaining: 0, resetAtMs: NOW + HOUR }),
          window({ remaining: 0, resetAtMs: NOW + 5 * HOUR }),
          window({ remaining: 40, resetAtMs: NOW + 9 * HOUR }),
        ],
        NOW
      )
    ).toBe(NOW + 5 * HOUR);
    expect(backAtMs([window({ remaining: 3, resetAtMs: NOW + HOUR })], NOW)).toBeNull();
  });

  test('routing order is priority first, then file name', () => {
    const list = [
      credential('b.json', claudeQuota(0, 0, NOW + HOUR)),
      credential('a.json', claudeQuota(0, 0, NOW + HOUR)),
      credential('z.json', claudeQuota(0, 0, NOW + HOUR), { priority: 10 }),
    ];
    expect(sortCredentials(list, 'routing', NOW).map((c) => c.entry.file.name)).toEqual([
      'z.json',
      'a.json',
      'b.json',
    ]);
  });

  test('first in line skips exhausted, cooling down and disabled credentials', () => {
    const list = [
      credential('a.json', claudeQuota(100, 0, NOW + HOUR)),
      credential('b.json', claudeQuota(0, 0, NOW + HOUR), {
        cooldownSnapshot: {
          receivedAtMs: NOW,
          records: [
            {
              scope: 'credential',
              reason: 'quota',
              retryAt: new Date(NOW + HOUR).toISOString(),
              remainingSeconds: 3600,
            },
          ],
        },
      }),
      credential('c.json', claudeQuota(0, 0, NOW + HOUR), { disabled: true }),
      credential('d.json', claudeQuota(10, 0, NOW + HOUR)),
    ];
    expect([...firstInLine(list)]).toEqual(['d.json']);
  });

  test('provider summary pools remaining capacity and lists other weekly limits', () => {
    const list = [
      credential('a.json', claudeQuota(40, 0, NOW + 48 * HOUR)),
      credential('b.json', claudeQuota(10, 0, NOW + 24 * HOUR)),
      credential('c.json', undefined),
    ];
    const [summary] = buildProviderSummaries(list, ['claude', 'codex'], NOW);
    expect(summary.credentialCount).toBe(3);
    expect(summary.loadedCount).toBe(2);
    expect(summary.primary?.remaining).toBe(150);
    expect(summary.primary?.total).toBe(200);
    expect(summary.primary?.segments).toEqual([60, 90, null]);
    expect(summary.primary?.soonestResetMs).toBe(NOW + 24 * HOUR);
    expect(summary.secondary.map((line) => line.id)).toEqual(['seven-day-fable']);
  });

  test('formats compact countdowns', () => {
    expect(formatCountdown(NOW + 51 * HOUR, NOW)).toBe('2d 3h');
    expect(formatCountdown(NOW + 4.5 * HOUR, NOW)).toBe('4h 30m');
    expect(formatCountdown(NOW + 12 * 60_000, NOW)).toBe('12m');
  });

  test('masks email local parts and prefers the account note', () => {
    expect(maskEmails('pdavis@example.com')).toBe('p•••@example.com');
    // Hyphens are valid in local parts, so a file-name prefix is hidden with the address.
    expect(maskEmails('claude-114cec5c-pdavis@example.com.json')).toBe('c•••@example.com.json');
    expect(maskEmails('no email here')).toBe('no email here');
    expect(credentialLabel({ name: 'a.json', email: 'x@y.com', note: ' Work Max ' })).toBe('Work Max');
    expect(credentialLabel({ name: 'a.json', email: 'x@y.com' })).toBe('x@y.com');
  });

  test('reset urgency: red within a day, yellow within a week', () => {
    expect(resetUrgency(NOW + 3 * HOUR, NOW)).toBe('day');
    expect(resetUrgency(NOW + 3 * 24 * HOUR, NOW)).toBe('week');
    expect(resetUrgency(NOW + 9 * 24 * HOUR, NOW)).toBe('later');
    expect(resetUrgency(null, NOW)).toBe('none');
  });
});
