/**
 * Quota CLIProxy observes on its own.
 *
 * Every upstream response CLIProxy proxies for a Claude or Codex credential
 * carries rate-limit headers (`anthropic-ratelimit-unified-*`, `x-codex-*`).
 * CLIProxy keeps the latest set per credential and returns it from
 * `GET /auth-files` as `quota: { observed_at, signals }`. Reading it costs no
 * call to Anthropic or OpenAI; it is as fresh as the credential's last request.
 */

import i18n from '@/i18n';
import type { QuotaProviderType } from '@/features/quota/providers/types';
import type { AuthFileItem } from '@/types';
import type { OverviewWindow } from './model';

export interface PassiveQuota {
  observedAtMs: number;
  windows: OverviewWindow[];
}

const MINUTE_MS = 60_000;
const WEEK_MINUTES = 7 * 24 * 60;

const readNumber = (value: string | undefined): number | null => {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

/** Header timestamps are Unix seconds; accept milliseconds too. */
const readInstant = (value: string | undefined): number | null => {
  const parsed = readNumber(value);
  if (parsed === null || parsed <= 0) return null;
  return parsed < 1e12 ? parsed * 1000 : parsed;
};

const readSignals = (
  file: AuthFileItem
): { observedAtMs: number; signals: Map<string, string> } | null => {
  const quota = (file as { quota?: unknown }).quota;
  if (!quota || typeof quota !== 'object') return null;
  const { observed_at: observedAt, signals } = quota as {
    observed_at?: unknown;
    signals?: unknown;
  };
  const observedAtMs = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN;
  if (!Number.isFinite(observedAtMs) || !signals || typeof signals !== 'object') return null;
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(signals as Record<string, unknown>)) {
    if (typeof value === 'string') map.set(key.toLowerCase(), value);
  }
  return map.size > 0 ? { observedAtMs, signals: map } : null;
};

/** Anthropic reports utilization as a fraction (0.42 = 42% used). */
function claudeWindows(signals: Map<string, string>): OverviewWindow[] {
  const specs = [
    { key: '5h', id: 'five-hour', labelKey: 'claude_quota.five_hour', hours: 5 },
    { key: '7d', id: 'seven-day', labelKey: 'claude_quota.seven_day', hours: 168 },
  ];
  return specs.flatMap((spec) => {
    const utilization = readNumber(
      signals.get(`anthropic-ratelimit-unified-${spec.key}-utilization`)
    );
    if (utilization === null) return [];
    return [
      {
        id: spec.id,
        label: i18n.t(spec.labelKey),
        remaining: clampPercent(100 - utilization * 100),
        resetAtMs: readInstant(signals.get(`anthropic-ratelimit-unified-${spec.key}-reset`)),
        periodHours: spec.hours,
      },
    ];
  });
}

/** Codex reports a primary and a secondary window, each with its own length. */
function codexWindows(signals: Map<string, string>, observedAtMs: number): OverviewWindow[] {
  return (['primary', 'secondary'] as const).flatMap((slot) => {
    const prefix = `x-codex-${slot}`;
    const used = readNumber(signals.get(`${prefix}-used-percent`));
    if (used === null) return [];
    const minutes = readNumber(signals.get(`${prefix}-window-minutes`));
    const resetAfter = readNumber(signals.get(`${prefix}-reset-after-seconds`));
    const resetAtMs =
      readInstant(signals.get(`${prefix}-reset-at`)) ??
      (resetAfter === null ? null : observedAtMs + resetAfter * 1000);
    const weekly = minutes === WEEK_MINUTES;
    return [
      {
        id: weekly ? 'weekly' : minutes === 300 ? 'five-hour' : `codex-${slot}`,
        label: i18n.t(
          slot === 'primary' ? 'codex_quota.primary_window' : 'codex_quota.secondary_window'
        ),
        remaining: clampPercent(100 - used),
        resetAtMs,
        periodHours: minutes === null ? null : (minutes * MINUTE_MS) / 3_600_000,
      },
    ];
  });
}

/** CLIProxy's last observed limits for a credential, or null when it has none yet. */
export function readPassiveQuota(
  provider: QuotaProviderType,
  file: AuthFileItem
): PassiveQuota | null {
  if (provider !== 'claude' && provider !== 'codex') return null;
  const read = readSignals(file);
  if (!read) return null;
  const windows =
    provider === 'claude'
      ? claudeWindows(read.signals)
      : codexWindows(read.signals, read.observedAtMs);
  return windows.length > 0 ? { observedAtMs: read.observedAtMs, windows } : null;
}
