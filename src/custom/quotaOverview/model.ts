/**
 * Quota Overview model: pure functions over the upstream quota cache.
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
}

export interface OverviewSummaryLine {
  id: string;
  label: string;
  /** Sum of percent remaining over credentials reporting this limit. */
  remaining: number;
  /** 100 per credential reporting this limit. */
  total: number;
  /** Per-credential remaining in routing order; null = not loaded or not reported. */
  segments: (number | null)[];
  soonestResetMs: number | null;
}

export interface OverviewProviderSummary {
  provider: QuotaProviderType;
  credentialCount: number;
  loadedCount: number;
  primary: OverviewSummaryLine | null;
  secondary: OverviewSummaryLine[];
}

const WEEKLY_HOURS = 168;

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

export function buildOverviewCredential(
  entry: QuotaFileEntry,
  quota: QuotaCardState | undefined,
  nowMs: number
): OverviewCredential {
  const windows = overviewWindows(entry.type, quota, entry.file.name);
  return {
    entry,
    quota,
    windows,
    primary: pickPrimaryWindow(windows),
    plan: readPlan(quota),
    backAtMs: backAtMs(windows, nowMs),
    cooldownUntilMs: cooldownUntilMs(entry.file, nowMs),
    priority: typeof entry.file.priority === 'number' ? entry.file.priority : 0,
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

const summarize = (
  id: string,
  credentials: readonly OverviewCredential[],
  pick: (credential: OverviewCredential) => OverviewWindow | null,
  nowMs: number
): OverviewSummaryLine | null => {
  let label = '';
  let remaining = 0;
  let total = 0;
  let soonestResetMs: number | null = null;
  const segments = credentials.map((credential) => {
    const window = pick(credential);
    if (!window || window.remaining === null) return null;
    label ||= window.label;
    remaining += window.remaining;
    total += 100;
    if (window.resetAtMs !== null && window.resetAtMs > nowMs) {
      soonestResetMs =
        soonestResetMs === null ? window.resetAtMs : Math.min(soonestResetMs, window.resetAtMs);
    }
    return window.remaining;
  });
  if (total === 0) return null;
  return { id, label, remaining, total, segments, soonestResetMs };
};

/** Provider cards: pooled weekly capacity plus each other weekly limit. */
export function buildProviderSummaries(
  credentials: readonly OverviewCredential[],
  providerOrder: readonly QuotaProviderType[],
  nowMs: number
): OverviewProviderSummary[] {
  return providerOrder
    .map((provider) => {
      const own = credentials.filter((credential) => credential.entry.type === provider);
      if (own.length === 0) return null;
      const ordered = [...own].sort(compareRoutingOrder);
      const primary = summarize('primary', ordered, (credential) => credential.primary, nowMs);
      const primaryId = ordered.find((credential) => credential.primary)?.primary?.id;
      const secondaryIds: string[] = [];
      ordered.forEach((credential) =>
        credential.windows.forEach((window) => {
          if (window.id === primaryId || secondaryIds.includes(window.id)) return;
          if (window.periodHours !== WEEKLY_HOURS) return;
          secondaryIds.push(window.id);
        })
      );
      const secondary = secondaryIds
        .map((id) =>
          summarize(
            id,
            ordered,
            (credential) => credential.windows.find((window) => window.id === id) ?? null,
            nowMs
          )
        )
        .filter((line): line is OverviewSummaryLine => line !== null);
      return {
        provider,
        credentialCount: own.length,
        loadedCount: own.filter((credential) => credential.quota?.status === 'success').length,
        primary,
        secondary,
      };
    })
    .filter((summary): summary is OverviewProviderSummary => summary !== null);
}

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
