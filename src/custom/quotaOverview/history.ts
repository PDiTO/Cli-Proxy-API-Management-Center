/**
 * Quota history recorded in this browser.
 *
 * CLIProxy keeps only each credential's latest quota reading, so the pool
 * chart's recorded line comes from readings the Quota Overview saves while it
 * is open: one sample per new reading, stamped with when CLIProxy observed it.
 * History is per backend address and per browser.
 */

import { useSyncExternalStore } from 'react';
import { useAuthStore } from '@/stores';

/** One observation: when, weekly percent remaining, and the window's reset instant. */
export type HistorySample = [tMs: number, remaining: number, resetAtMs: number | null];

/** Samples per credential, keyed by `historyKey`. */
export type QuotaHistory = Readonly<Record<string, readonly HistorySample[]>>;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Keep three weeks: the chart shows two, and the date range can step back one. */
export const HISTORY_RETENTION_MS = 21 * DAY_MS;
/** Recent samples closer together than this replace each other. */
const RECENT_SPACING_MS = 10 * MINUTE_MS;
/** Older than this, samples thin out to `OLD_SPACING_MS`. */
const RECENT_WINDOW_MS = 2 * DAY_MS;
const OLD_SPACING_MS = 30 * MINUTE_MS;
const SAVE_DELAY_MS = 1000;
const STORAGE_PREFIX = 'pd-quota-history:v1:';

const sameReset = (a: HistorySample, b: HistorySample) => a[2] === b[2];

/**
 * Whether `middle` can go: it sits less than `spacingMs` after `first`, in the
 * same window, on a steady decline to `next`. Dropping it only loses curvature.
 */
const isRedundant = (
  first: HistorySample | undefined,
  middle: HistorySample,
  next: HistorySample,
  spacingMs: number
) =>
  first !== undefined &&
  middle[0] - first[0] < spacingMs &&
  sameReset(first, middle) &&
  sameReset(middle, next) &&
  first[1] >= middle[1] &&
  middle[1] >= next[1];

/**
 * Append a sample, keeping the series sorted and sparse: while samples arrive
 * faster than `RECENT_SPACING_MS`, the newest replaces the previous tip so the
 * series keeps one anchor per interval plus the latest reading.
 */
export function appendSample(
  samples: readonly HistorySample[],
  sample: HistorySample
): HistorySample[] {
  const last = samples[samples.length - 1];
  if (!last) return [sample];
  if (sample[0] < last[0]) return [...samples];
  if (sample.every((part, index) => part === last[index])) return [...samples];
  if (sample[0] === last[0]) return [...samples.slice(0, -1), sample];
  if (isRedundant(samples[samples.length - 2], last, sample, RECENT_SPACING_MS)) {
    return [...samples.slice(0, -1), sample];
  }
  return [...samples, sample];
}

/**
 * Drop samples past retention, thin old ones, and collapse runs of identical
 * readings to their endpoints (an idle account stores two points, not hundreds).
 */
export function compactSamples(samples: readonly HistorySample[], nowMs: number): HistorySample[] {
  const kept: HistorySample[] = [];
  for (const sample of samples) {
    if (sample[0] < nowMs - HISTORY_RETENTION_MS) continue;
    const prev = kept[kept.length - 1];
    const beforePrev = kept[kept.length - 2];
    const old = sample[0] < nowMs - RECENT_WINDOW_MS;
    const flat = prev !== undefined && beforePrev !== undefined && beforePrev[1] === sample[1];
    if (
      prev &&
      isRedundant(
        beforePrev,
        prev,
        sample,
        flat ? Number.POSITIVE_INFINITY : old ? OLD_SPACING_MS : 0
      )
    ) {
      kept[kept.length - 1] = sample;
      continue;
    }
    kept.push(sample);
  }
  return kept;
}

/* ---------- storage ---------- */

const isSample = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every((part) => typeof part === 'number' && Number.isFinite(part));

/** Stored as whole minutes, with 0 for "no reset", to keep localStorage small. */
export function parseHistory(raw: string | null): Record<string, HistorySample[]> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, HistorySample[]> = {};
    for (const [key, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const samples = list
        .filter(isSample)
        .map(([t, remaining, reset]): HistorySample => [
          t * MINUTE_MS,
          remaining,
          reset > 0 ? reset * MINUTE_MS : null,
        ])
        .sort((a, b) => a[0] - b[0]);
      if (samples.length > 0) out[key] = samples;
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeHistory(history: QuotaHistory): string {
  const out: Record<string, [number, number, number][]> = {};
  for (const [key, samples] of Object.entries(history)) {
    if (samples.length === 0) continue;
    out[key] = samples.map(([t, remaining, reset]) => [
      Math.round(t / MINUTE_MS),
      Math.round(remaining * 10) / 10,
      reset === null ? 0 : Math.round(reset / MINUTE_MS),
    ]);
  }
  return JSON.stringify(out);
}

/* ---------- in-memory store ---------- */

let currentBase: string | null = null;
let current: Record<string, HistorySample[]> = {};
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const EMPTY: QuotaHistory = {};

const storageKey = (base: string) => `${STORAGE_PREFIX}${base}`;

const flush = () => {
  saveTimer = null;
  if (currentBase === null) return;
  const nowMs = Date.now();
  const compacted: Record<string, HistorySample[]> = {};
  for (const [key, samples] of Object.entries(current)) {
    const kept = compactSamples(samples, nowMs);
    if (kept.length > 0) compacted[key] = kept;
  }
  current = compacted;
  try {
    localStorage.setItem(storageKey(currentBase), serializeHistory(current));
  } catch {
    // Storage full or unavailable: history lives for this session only.
  }
};

/** Switch to the history of another backend, flushing the previous one first. */
const ensureBase = (base: string) => {
  if (currentBase === base) return;
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    flush();
  }
  currentBase = base;
  try {
    current = parseHistory(localStorage.getItem(storageKey(base)));
  } catch {
    current = {};
  }
};

const emit = () => listeners.forEach((listener) => listener());

const toMinute = (ms: number) => Math.round(ms / MINUTE_MS) * MINUTE_MS;

export function recordSample(base: string, key: string, reading: HistorySample) {
  ensureBase(base);
  // Store resolution, so a reading seen again after a reload compares equal.
  const sample: HistorySample = [
    toMinute(reading[0]),
    Math.round(reading[1] * 10) / 10,
    reading[2] === null ? null : toMinute(reading[2]),
  ];
  const last = current[key]?.[current[key].length - 1];
  if (last && sample[0] <= last[0]) {
    // Already recorded (the same reading seen again), or older than what we have.
    if (sample[0] < last[0] || sample.every((part, index) => part === last[index])) return;
  }
  current = { ...current, [key]: appendSample(current[key] ?? [], sample) };
  if (saveTimer === null) saveTimer = setTimeout(flush, SAVE_DELAY_MS);
  emit();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getSnapshot = (): QuotaHistory => {
  const base = useAuthStore.getState().apiBase;
  if (!base) return EMPTY;
  ensureBase(base);
  return current;
};

/** Recorded history for the connected backend; re-renders when a sample lands. */
export function useQuotaHistory(): QuotaHistory {
  // apiBase is read in the snapshot; subscribing here re-renders on a switch.
  useAuthStore((state) => state.apiBase);
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}
