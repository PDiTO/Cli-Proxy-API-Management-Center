/**
 * Pooled weekly quota over time: what was recorded, and where it is heading.
 *
 * Pure functions, clock passed in. A provider's pool is the sum of its loaded
 * credentials' weekly percent remaining (100 per credential). The recorded
 * series comes from browser history (see history.ts); the projection drains
 * the pool at a burn rate the way CPA routes requests: the highest priority
 * tier with an available credential takes the traffic, either all on its first
 * credential (fill-first) or spread evenly (round-robin), and each credential's
 * weekly window refills to 100% at its reset.
 */

import type { HistorySample } from './history';

const HOUR_MS = 3_600_000;
const EPSILON = 1e-6;
/** Rises smaller than this are measurement noise, not resets. */
const MIN_JUMP = 0.5;

export interface PoolAccount {
  key: string;
  /** File name; breaks ties inside a priority tier. */
  name: string;
  label: string;
  priority: number;
  /** Disabled credentials keep their quota but take no traffic. */
  enabled: boolean;
  /** Current weekly percent remaining, 0..100. */
  remaining: number;
  resetAtMs: number | null;
  periodMs: number | null;
  /** Cooldown or exhausted short window; no traffic until then. */
  blockedUntilMs: number | null;
  samples: readonly HistorySample[];
}

/** Values per account, in the accounts' order. A repeated `t` is a vertical jump. */
export interface SeriesPoint {
  t: number;
  values: number[];
}

export interface JumpMark {
  t: number;
  /** Pool percent gained at once, summed over accounts. */
  gain: number;
}

export interface RecordedSeries {
  points: SeriesPoint[];
  jumps: JumpMark[];
}

export interface DrainStep {
  /** Step start; the rate holds until the next step. */
  t: number;
  /** Pool percent per hour. */
  rate: number;
}

export interface Projection {
  points: SeriesPoint[];
  jumps: JumpMark[];
  drain: DrainStep[];
  /** First credential to run out, by index into the accounts. */
  firstEmpty: { t: number; index: number } | null;
  /** When no enabled credential has quota left. */
  poolEmptyMs: number | null;
  nextReset: JumpMark | null;
}

export type RoutingMode = 'fill-first' | 'spread';

interface PathPoint {
  t: number;
  v: number;
}

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

export const sumValues = (values: readonly number[]) =>
  values.reduce((total, value) => total + value, 0);

/**
 * One account's recorded line. Between samples the line is straight; a reset
 * that fell between two samples is drawn at its instant (hold, then jump to
 * 100%), and a rise with no reset (a reset credit) jumps at the later sample.
 * The line holds its last reading until now.
 */
export function accountPath(account: PoolAccount, nowMs: number): PathPoint[] {
  const samples = account.samples.filter((sample) => sample[0] <= nowMs);
  if (samples.length === 0) return [{ t: nowMs, v: clampPercent(account.remaining) }];
  const points: PathPoint[] = [];
  samples.forEach(([t, value], index) => {
    const prev = samples[index - 1];
    if (prev) {
      const [prevT, prevValue, reset] = prev;
      if (reset !== null && reset > prevT && reset <= t) {
        points.push({ t: reset, v: prevValue }, { t: reset, v: 100 });
      } else if (value > prevValue + EPSILON) {
        points.push({ t, v: prevValue });
      }
    }
    points.push({ t, v: clampPercent(value) });
  });
  const [lastT, lastValue, lastReset] = samples[samples.length - 1];
  let tail = lastValue;
  if (lastReset !== null && lastReset > lastT && lastReset <= nowMs) {
    points.push({ t: lastReset, v: lastValue }, { t: lastReset, v: 100 });
    tail = 100;
  }
  if (points[points.length - 1].t < nowMs) points.push({ t: nowMs, v: tail });
  return points;
}

/** Last index whose time is <= t (or < t when `strict`); -1 when none. */
const lastIndexAt = (times: readonly { t: number }[], t: number, strict: boolean) => {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const ok = strict ? times[mid].t < t : times[mid].t <= t;
    if (ok) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
};

/**
 * Value of a path at t. At a jump, `left` is the value just before it and
 * `right` just after. Before the first point the path holds its first value,
 * so a credential added later doesn't show up as a jump in the pool.
 */
export function pathValueAt(path: readonly PathPoint[], t: number, side: 'left' | 'right'): number {
  if (path.length === 0) return 0;
  const index = lastIndexAt(path, t, side === 'left');
  if (index === -1) return path[0].v;
  const a = path[index];
  const b = path[index + 1];
  if (!b) return a.v;
  if (b.t === a.t) return side === 'left' ? a.v : b.v;
  if (side === 'left' && b.t === t) return b.v;
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

/** The pooled recorded series, from the earliest sample to now. */
export function recordedSeries(accounts: readonly PoolAccount[], nowMs: number): RecordedSeries {
  if (!accounts.some((account) => account.samples.length > 0)) return { points: [], jumps: [] };
  const paths = accounts.map((account) => accountPath(account, nowMs));
  const times = [...new Set(paths.flatMap((path) => path.map((point) => point.t)))].sort(
    (a, b) => a - b
  );
  const points: SeriesPoint[] = [];
  const jumps: JumpMark[] = [];
  for (const t of times) {
    const left = paths.map((path) => pathValueAt(path, t, 'left'));
    const right = paths.map((path) => pathValueAt(path, t, 'right'));
    points.push({ t, values: left });
    if (right.some((value, index) => value !== left[index])) {
      points.push({ t, values: right });
      const gain = right.reduce(
        (total, value, index) => total + Math.max(0, value - left[index]),
        0
      );
      if (gain >= MIN_JUMP) jumps.push({ t, gain });
    }
  }
  return { points, jumps };
}

/** Pool percent consumed per path segment inside [fromMs, toMs], ignoring rises. */
function consumedBetween(paths: readonly PathPoint[][], fromMs: number, toMs: number): number {
  let consumed = 0;
  for (const path of paths) {
    for (let index = 1; index < path.length; index += 1) {
      const a = path[index - 1];
      const b = path[index];
      const drop = a.v - b.v;
      if (drop <= 0 || b.t <= a.t) continue;
      const overlap = Math.min(b.t, toMs) - Math.max(a.t, fromMs);
      if (overlap > 0) consumed += (drop * overlap) / (b.t - a.t);
    }
  }
  return consumed;
}

const earliestSample = (accounts: readonly PoolAccount[]): number | null => {
  let earliest: number | null = null;
  for (const account of accounts) {
    const first = account.samples[0]?.[0];
    if (first !== undefined && (earliest === null || first < earliest)) earliest = first;
  }
  return earliest;
};

/**
 * Pool percent consumed per hour over the last `hours`, from recorded history.
 * Null until at least half an hour is recorded. Shorter history than asked for
 * is averaged over what exists.
 */
export function burnRate(
  accounts: readonly PoolAccount[],
  nowMs: number,
  hours: number
): number | null {
  const earliest = earliestSample(accounts);
  if (earliest === null) return null;
  const fromMs = Math.max(nowMs - hours * HOUR_MS, earliest);
  const covered = nowMs - fromMs;
  if (covered < HOUR_MS / 2) return null;
  const paths = accounts.map((account) => accountPath(account, nowMs));
  return consumedBetween(paths, fromMs, nowMs) / (covered / HOUR_MS);
}

/** Recorded drain in hourly steps, from the first sample to now. */
export function recordedDrain(accounts: readonly PoolAccount[], nowMs: number): DrainStep[] {
  const earliest = earliestSample(accounts);
  if (earliest === null) return [];
  const paths = accounts.map((account) => accountPath(account, nowMs));
  const steps: DrainStep[] = [];
  const first = Math.floor(earliest / HOUR_MS) * HOUR_MS;
  for (let t = first; t < nowMs; t += HOUR_MS) {
    const from = Math.max(t, earliest);
    const to = Math.min(t + HOUR_MS, nowMs);
    if (to <= from) continue;
    steps.push({ t, rate: consumedBetween(paths, from, to) / ((to - from) / HOUR_MS) });
  }
  return steps;
}

/** The next reset strictly after `nowMs`, stepping a stale anchor forward by whole periods. */
const nextResetAfter = (account: PoolAccount, nowMs: number): number | null => {
  const { resetAtMs, periodMs } = account;
  if (resetAtMs === null) return null;
  if (resetAtMs > nowMs) return resetAtMs;
  if (!periodMs || periodMs <= 0) return null;
  return resetAtMs + (Math.floor((nowMs - resetAtMs) / periodMs) + 1) * periodMs;
};

/** Which accounts take traffic right now, and at what share of the burn. */
function activeAccounts(
  accounts: readonly PoolAccount[],
  remaining: readonly number[],
  blockedUntil: readonly (number | null)[],
  mode: RoutingMode
): number[] {
  const available = accounts
    .map((account, index) => ({ account, index }))
    .filter(
      ({ account, index }) =>
        account.enabled && remaining[index] > EPSILON && blockedUntil[index] === null
    );
  if (available.length === 0) return [];
  const top = Math.max(...available.map(({ account }) => account.priority));
  const tier = available
    .filter(({ account }) => account.priority === top)
    .sort((a, b) =>
      a.account.name < b.account.name ? -1 : a.account.name > b.account.name ? 1 : 0
    )
    .map(({ index }) => index);
  return mode === 'fill-first' ? tier.slice(0, 1) : tier;
}

/**
 * Simulate the pool from now until `untilMs`, draining `burnPerHour` percent
 * per hour through the routing rules above. Event-driven, so jumps and empties
 * land on their exact instants.
 */
export function projectPool({
  accounts,
  nowMs,
  untilMs,
  burnPerHour,
  mode,
}: {
  accounts: readonly PoolAccount[];
  nowMs: number;
  untilMs: number;
  burnPerHour: number;
  mode: RoutingMode;
}): Projection {
  const remaining = accounts.map((account) => clampPercent(account.remaining));
  const resets = accounts.map((account) => nextResetAfter(account, nowMs));
  const blocked = accounts.map((account) =>
    account.blockedUntilMs !== null && account.blockedUntilMs > nowMs
      ? account.blockedUntilMs
      : null
  );
  const burn = Math.max(0, burnPerHour);
  const points: SeriesPoint[] = [{ t: nowMs, values: [...remaining] }];
  const jumps: JumpMark[] = [];
  const drain: DrainStep[] = [];
  let firstEmpty: Projection['firstEmpty'] = null;
  let poolEmptyMs: number | null = null;
  let nextReset: JumpMark | null = null;
  const anyEnabled = accounts.some((account) => account.enabled);

  let t = nowMs;
  for (let guard = 0; t < untilMs && guard < 10_000; guard += 1) {
    const active = burn > 0 ? activeAccounts(accounts, remaining, blocked, mode) : [];
    const share = active.length > 0 ? burn / active.length : 0;

    let next = untilMs;
    for (const at of [...resets, ...blocked]) {
      if (at !== null && at > t && at < next) next = at;
    }
    for (const index of active) {
      const emptyAt = t + (remaining[index] / share) * HOUR_MS;
      if (emptyAt < next) next = emptyAt;
    }

    const rate = active.length > 0 ? burn : 0;
    if (drain[drain.length - 1]?.rate !== rate) drain.push({ t, rate });

    const hours = (next - t) / HOUR_MS;
    for (const index of active) {
      remaining[index] = Math.max(0, remaining[index] - share * hours);
      if (remaining[index] < EPSILON) {
        remaining[index] = 0;
        if (firstEmpty === null) firstEmpty = { t: next, index };
      }
    }
    t = next;
    points.push({ t, values: [...remaining] });

    if (
      poolEmptyMs === null &&
      burn > 0 &&
      anyEnabled &&
      accounts.every((account, index) => !account.enabled || remaining[index] < EPSILON)
    ) {
      poolEmptyMs = t;
    }

    let gain = 0;
    let resetHere = false;
    resets.forEach((at, index) => {
      if (at === null || at > t) return;
      resetHere = true;
      gain += 100 - remaining[index];
      remaining[index] = 100;
      const period = accounts[index].periodMs;
      resets[index] = period && period > 0 ? at + period : null;
    });
    blocked.forEach((at, index) => {
      if (at !== null && at <= t) blocked[index] = null;
    });
    if (resetHere) {
      if (nextReset === null) nextReset = { t, gain };
      if (gain >= MIN_JUMP) {
        points.push({ t, values: [...remaining] });
        jumps.push({ t, gain });
      }
    }
  }

  return { points, jumps, drain, firstEmpty, poolEmptyMs, nextReset };
}

/** Values of a series at t (right-hand side of a jump), holding the ends. */
export function seriesValuesAt(points: readonly SeriesPoint[], t: number): number[] | null {
  if (points.length === 0 || t < points[0].t) return null;
  const index = lastIndexAt(points, t, false);
  const a = points[index];
  const b = points[index + 1];
  if (!b || b.t === a.t) return a.values;
  const f = (t - a.t) / (b.t - a.t);
  return a.values.map((value, i) => value + (b.values[i] - value) * f);
}

/** Rate of a step series at t. */
export function drainAt(steps: readonly DrainStep[], t: number): number | null {
  if (steps.length === 0 || t < steps[0].t) return null;
  return steps[lastIndexAt(steps, t, false)].rate;
}
