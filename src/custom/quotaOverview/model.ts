/**
 * Quota Overview model: pure functions over the upstream quota cache and the
 * quota CLIProxy observes from proxied traffic.
 *
 * Fork-only code (see src/custom/README.md). It reads the same quota states the
 * upstream Quota page stores, so provider fetching and parsing stay upstream's.
 */

import { buildTimelineLane } from '@/features/quota/quotaTimelineModel';
import { nextRecoveryMs } from '@/features/quota/resetSchedule';
import type { QuotaFileEntry } from '@/features/quota/logic';
import type { QuotaCardState } from '@/features/quota/providers';
import type { QuotaProviderType } from '@/features/quota/providers/types';
import type { AuthFileItem } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { HistorySample, QuotaHistory } from './history';
import { readPassiveQuota } from './passiveQuota';
import type { PoolAccount } from './poolForecast';

/** One limit on one credential, normalized to percent remaining. */
export interface OverviewWindow {
  id: string;
  label: string;
  /** Percent remaining, 0..100; null when the provider reported no usage. */
  remaining: number | null;
  resetAtMs: number | null;
  periodHours: number | null;
}

export interface OverviewCredential {
  entry: QuotaFileEntry;
  quota: QuotaCardState | undefined;
  windows: OverviewWindow[];
  /** The window that governs weekly capacity, when one is known. */
  primary: OverviewWindow | null;
  plan: string | null;
  /** When an exhausted limit gives capacity back; null when nothing is exhausted. */
  backAtMs: number | null;
  /** The proxy's own credential cooldown, from the auth-files snapshot. */
  cooldownUntilMs: number | null;
  priority: number;
  /**
   * Where the windows came from: a quota request made from this panel, or
   * CLIProxy's reading of the credential's last proxied response.
   */
  source: 'live' | 'proxy' | null;
  /** When the source read the limits; null when it doesn't say. */
  observedAtMs: number | null;
  /** The weekly reading as observed (before rolling past resets), for history. */
  sample: HistorySample | null;
}

export interface OverviewProviderPool {
  provider: QuotaProviderType;
  credentialCount: number;
  /** Credentials with a weekly reading, in routing order. */
  accounts: PoolAccount[];
}

const WEEKLY_HOURS = 168;
const HOUR_MS = 3_600_000;

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

interface UsedWindowLike {
  id?: string;
  label?: string;
  usedPercent?: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

const fromUsedWindows = (windows: readonly UsedWindowLike[] | undefined): OverviewWindow[] =>
  (windows ?? []).map((window, index) => {
    const used = finiteOrNull(window.usedPercent);
    return {
      id: window.id || `window-${index}`,
      label: window.label || window.id || `#${index + 1}`,
      remaining: used === null ? null : clampPercent(100 - used),
      resetAtMs: finiteOrNull(window.resetAtMs),
      periodHours: finiteOrNull(window.periodHours),
    };
  });

/**
 * Every limit on a credential. Claude and Codex keep per-window reset instants;
 * other providers fall back to the upstream timeline lane, which carries labels
 * and remaining percentages but a single reset anchor.
 */
export function overviewWindows(
  provider: QuotaProviderType,
  quota: QuotaCardState | undefined,
  name: string
): OverviewWindow[] {
  if (!quota || quota.status !== 'success') return [];
  if (provider === 'claude' || provider === 'codex') {
    return fromUsedWindows((quota as { windows?: UsedWindowLike[] }).windows);
  }
  const lane = buildTimelineLane({ name, displayName: name, provider, quota });
  return lane.limits.map((limit, index) => ({
    id: `${provider}-${index}`,
    label: limit.label,
    remaining: clampPercent(limit.remaining),
    resetAtMs: index === 0 ? lane.anchorMs : null,
    periodHours: index === 0 ? lane.periodHours : null,
  }));
}

/**
 * The weekly account limit: Claude's `seven-day`, Codex's `weekly`, otherwise
 * the longest window that is at most a week long.
 */
export function pickPrimaryWindow(windows: readonly OverviewWindow[]): OverviewWindow | null {
  const preferred = windows.find((window) => window.id === 'seven-day' || window.id === 'weekly');
  if (preferred) return preferred;
  let best: OverviewWindow | null = null;
  for (const window of windows) {
    if (window.periodHours === null || window.periodHours > WEEKLY_HOURS) continue;
    if (best === null || (best.periodHours ?? 0) < window.periodHours) best = window;
  }
  return best ?? windows[0] ?? null;
}

/** Latest reset among exhausted limits: the instant the credential is usable again. */
export function backAtMs(windows: readonly OverviewWindow[], nowMs: number): number | null {
  let back: number | null = null;
  for (const window of windows) {
    if (window.remaining === null || window.remaining > 0) continue;
    if (window.resetAtMs === null || window.resetAtMs <= nowMs) continue;
    if (back === null || window.resetAtMs > back) back = window.resetAtMs;
  }
  return back;
}

/** Credential-scoped cooldown the proxy itself is enforcing, if any. */
export function cooldownUntilMs(file: AuthFileItem, nowMs: number): number | null {
  const records = file.cooldownSnapshot?.records ?? [];
  let until: number | null = null;
  for (const record of records) {
    if (record.scope !== 'credential') continue;
    const at = Date.parse(record.retryAt);
    if (!Number.isFinite(at) || at <= nowMs) continue;
    if (until === null || at > until) until = at;
  }
  return until;
}

const readPlan = (quota: QuotaCardState | undefined): string | null => {
  if (!quota || quota.status !== 'success') return null;
  const state = quota as { planType?: unknown; plan?: unknown; data?: { planName?: unknown } };
  const plan = state.planType ?? state.plan ?? state.data?.planName;
  return typeof plan === 'string' && plan.trim() ? plan.trim() : null;
};

/** When a loaded quota state was fetched, if the provider adapter records it. */
const liveObservedAtMs = (quota: QuotaCardState | undefined): number | null => {
  const state = quota as { observedAt?: unknown; observedAtMs?: unknown } | undefined;
  const at =
    typeof state?.observedAtMs === 'number'
      ? state.observedAtMs
      : typeof state?.observedAt === 'string'
        ? Date.parse(state.observedAt)
        : NaN;
  return Number.isFinite(at) ? at : null;
};

/**
 * A reading taken before a window reset says nothing about the new window
 * except that it started full: move such windows to 100% and their next reset.
 */
export function rollPastResets(
  windows: readonly OverviewWindow[],
  nowMs: number
): OverviewWindow[] {
  return windows.map((window) => {
    if (window.resetAtMs === null || window.resetAtMs > nowMs) return window;
    const periodMs = window.periodHours === null ? 0 : window.periodHours * HOUR_MS;
    const resetAtMs =
      periodMs > 0
        ? window.resetAtMs + (Math.floor((nowMs - window.resetAtMs) / periodMs) + 1) * periodMs
        : null;
    return { ...window, remaining: window.remaining === null ? null : 100, resetAtMs };
  });
}

export function buildOverviewCredential(
  entry: QuotaFileEntry,
  quota: QuotaCardState | undefined,
  nowMs: number
): OverviewCredential {
  const live = overviewWindows(entry.type, quota, entry.file.name);
  const liveAt = live.length > 0 ? liveObservedAtMs(quota) : null;
  const passive = readPassiveQuota(entry.type, entry.file);
  let observed = live;
  let source: OverviewCredential['source'] = live.length > 0 ? 'live' : null;
  let observedAtMs = liveAt;
  // Prefer whichever reading is newer; the proxy's lacks some limits, so keep
  // the live ones it doesn't report.
  if (passive && (liveAt === null || passive.observedAtMs > liveAt)) {
    const byId = new Map(passive.windows.map((window) => [window.id, window]));
    observed = [
      ...live.map((window) => byId.get(window.id) ?? window),
      ...passive.windows.filter((window) => !live.some((own) => own.id === window.id)),
    ];
    source = 'proxy';
    observedAtMs = passive.observedAtMs;
  }
  const observedPrimary = pickPrimaryWindow(observed);
  const windows = rollPastResets(observed, nowMs);
  return {
    entry,
    quota,
    windows,
    primary: pickPrimaryWindow(windows),
    plan: readPlan(quota),
    backAtMs: backAtMs(windows, nowMs),
    cooldownUntilMs: cooldownUntilMs(entry.file, nowMs),
    priority: typeof entry.file.priority === 'number' ? entry.file.priority : 0,
    source,
    observedAtMs,
    sample:
      observedPrimary && observedPrimary.remaining !== null
        ? [observedAtMs ?? nowMs, observedPrimary.remaining, observedPrimary.resetAtMs]
        : null,
  };
}

/**
 * The order `fill-first` routing tries credentials in: highest priority first,
 * then by credential id, which for file-backed credentials is the file name.
 */
export function compareRoutingOrder(a: OverviewCredential, b: OverviewCredential): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.entry.file.name < b.entry.file.name ? -1 : a.entry.file.name > b.entry.file.name ? 1 : 0;
}

export const isCredentialAvailable = (credential: OverviewCredential): boolean =>
  !credential.entry.file.disabled &&
  credential.cooldownUntilMs === null &&
  credential.backAtMs === null &&
  credential.quota?.status !== 'error';

/**
 * Per provider, the first available credential in routing order. New sessions
 * go there; existing sessions can stay on another credential through affinity.
 */
export function firstInLine(credentials: readonly OverviewCredential[]): Set<string> {
  const picked = new Map<QuotaProviderType, string>();
  [...credentials].sort(compareRoutingOrder).forEach((credential) => {
    if (picked.has(credential.entry.type) || !isCredentialAvailable(credential)) return;
    picked.set(credential.entry.type, credential.entry.file.name);
  });
  return new Set(picked.values());
}

export const OVERVIEW_SORT_MODES = ['routing', 'soonest', 'remaining', 'name'] as const;
export type OverviewSortMode = (typeof OVERVIEW_SORT_MODES)[number];

export function sortCredentials(
  credentials: readonly OverviewCredential[],
  mode: OverviewSortMode,
  nowMs: number
): OverviewCredential[] {
  const sorted = [...credentials];
  if (mode === 'routing') return sorted.sort(compareRoutingOrder);
  if (mode === 'name') {
    return sorted.sort((a, b) => a.entry.file.name.localeCompare(b.entry.file.name));
  }
  if (mode === 'remaining') {
    return sorted.sort(
      (a, b) =>
        (b.primary?.remaining ?? -1) - (a.primary?.remaining ?? -1) || compareRoutingOrder(a, b)
    );
  }
  const key = (credential: OverviewCredential) =>
    nextRecoveryMs(credential.entry.type, credential.quota, nowMs) ?? Number.POSITIVE_INFINITY;
  return sorted.sort((a, b) => key(a) - key(b) || compareRoutingOrder(a, b));
}

/**
 * Per provider, the credentials whose weekly limit is known, with recorded
 * history attached, ready for the pool chart.
 */
export function buildProviderPools(
  credentials: readonly OverviewCredential[],
  providerOrder: readonly QuotaProviderType[],
  history: QuotaHistory
): OverviewProviderPool[] {
  return providerOrder
    .map((provider) => {
      const own = credentials
        .filter((credential) => credential.entry.type === provider)
        .sort(compareRoutingOrder);
      if (own.length === 0) return null;
      const accounts = own.flatMap((credential): PoolAccount[] => {
        const primary = credential.primary;
        if (!primary || primary.remaining === null) return [];
        const key = historyKey(provider, getQuotaCacheKey(credential.entry.file));
        return [
          {
            key,
            name: credential.entry.file.name,
            label: credentialLabel(credential.entry.file),
            priority: credential.priority,
            enabled: !credential.entry.file.disabled,
            remaining: primary.remaining,
            resetAtMs: primary.resetAtMs,
            periodMs: primary.periodHours === null ? null : primary.periodHours * HOUR_MS,
            blockedUntilMs: maxOrNull(credential.backAtMs, credential.cooldownUntilMs),
            samples: history[key] ?? [],
          },
        ];
      });
      return { provider, credentialCount: own.length, accounts };
    })
    .filter((pool): pool is OverviewProviderPool => pool !== null);
}

/** History series key: one per provider credential identity. */
export const historyKey = (provider: QuotaProviderType, cacheKey: string) =>
  `${provider}:${cacheKey}`;

const maxOrNull = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.max(a, b);

const EMAIL_PATTERN = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** Mask the local part of every email address: `pdavis@x.com` becomes `p•••@x.com`. */
export const maskEmails = (text: string): string => text.replace(EMAIL_PATTERN, '$1•••@$2');

export const containsEmail = (text: string): boolean => new RegExp(EMAIL_PATTERN).test(text);

/** The account's Note when set (Auth Files › details), otherwise its email or file name. */
export const credentialLabel = (file: AuthFileItem): string =>
  file.note?.trim() || file.email?.trim() || file.name;

export type ResetUrgency = 'day' | 'week' | 'later' | 'none';

/** Reset credits expiring within a day are urgent; within a week, a warning. */
export function resetUrgency(expiresAtMs: number | null, nowMs: number): ResetUrgency {
  if (expiresAtMs === null) return 'none';
  const left = expiresAtMs - nowMs;
  if (left <= 24 * 3_600_000) return 'day';
  if (left <= 7 * 24 * 3_600_000) return 'week';
  return 'later';
}

/** "8 days", "5 hours", "40 minutes": the largest whole unit left, without "in". */
export function formatTimeLeft(targetMs: number, nowMs: number, locale?: string): string {
  const minutes = Math.max(0, Math.round((targetMs - nowMs) / 60000));
  const [value, unit] =
    minutes >= 2880
      ? [Math.floor(minutes / 1440), 'day']
      : minutes >= 120
        ? [Math.floor(minutes / 60), 'hour']
        : [minutes, 'minute'];
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(value);
}

/** "2d 3h", "4h 10m", "12m": compact time until an instant. */
export function formatCountdown(targetMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.round((targetMs - nowMs) / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** "Nov 8": month and day in the reader's locale. */
export const formatShortDate = (ms: number, locale?: string): string =>
  new Date(ms).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
