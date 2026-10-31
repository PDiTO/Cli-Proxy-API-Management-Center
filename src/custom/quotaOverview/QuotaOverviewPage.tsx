/**
 * Quota Overview: pooled provider capacity over time (recorded and projected),
 * a compact ledger in routing order, and upstream's cards and timeline.
 *
 * Fork-only page (see src/custom/README.md). Data loading reuses the upstream
 * quota store, loader and actions, so both quota pages share one cache.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { authFilesApi } from '@/services/api';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  IconChevronLeft,
  IconEye,
  IconEyeOff,
  IconRefreshCw,
  IconSearch,
  IconX,
} from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { normalizeRoutingStrategy } from '@/services/api/routing';
import {
  useAuthStore,
  useConfigStore,
  useNotificationStore,
  useQuotaStore,
  useThemeStore,
} from '@/stores';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { ProviderTabs } from '@/features/authFiles/components/ProviderTabs';
import { QuotaCard } from '@/features/quota/components/QuotaCard';
import { QuotaTimeline } from '@/features/quota/components/QuotaTimeline';
import { QUOTA_TAB_ORDER, type QuotaTabId } from '@/features/quota/constants';
import {
  buildTabCounts,
  classifyQuotaFiles,
  filterEntriesByTab,
  type QuotaFileEntry,
} from '@/features/quota/logic';
import { QUOTA_ADAPTERS, type QuotaCardState } from '@/features/quota/providers';
import type { QuotaProviderType } from '@/features/quota/providers/types';
import { useQuotaActions } from '@/features/quota/hooks/useQuotaActions';
import { useQuotaBatchLoader } from '@/features/quota/hooks/useQuotaBatchLoader';
import { LedgerHeader, LedgerRow } from './components';
import { recordSample, useQuotaHistory } from './history';
import {
  OVERVIEW_SORT_MODES,
  buildOverviewCredential,
  buildProviderPools,
  credentialLabel,
  maskEmails,
  firstInLine,
  formatShortDate,
  historyKey,
  sortCredentials,
  type OverviewSortMode,
} from './model';
import {
  BURN_WINDOWS,
  CHART_MODES,
  FUTURE_USAGE,
  PoolChart,
  type BurnWindow,
  type ChartMode,
  type FutureUsage,
} from './PoolChart';
import { useClaudeTiers } from './useClaudeTiers';
import styles from './QuotaOverviewPage.module.scss';

const TAB_IDS: string[] = ['all', ...QUOTA_TAB_ORDER];
const VIEW_MODES = ['ledger', 'cards'] as const;
type ViewMode = (typeof VIEW_MODES)[number];
const UI_STATE_KEY = 'pd-quota-overview';
/**
 * Re-read the credential list while the page is visible. It's answered by CLIProxy alone and
 * carries the quota it observed on proxied traffic, so this never calls Anthropic or OpenAI.
 */
const PROXY_POLL_MS = 2 * 60 * 1000;
/** Background refresh while the page is visible; quota endpoints are rate-limited upstream. */
const AUTO_REFRESH_MS = 15 * 60 * 1000;
/** The chart shows two weeks, starting three days back; the arrows step a week. */
const RANGE_DAYS = 14;
const RANGE_PAST_DAYS = 3;
const RANGE_STEP_DAYS = 7;

interface UiState {
  tab: QuotaTabId;
  sort: OverviewSortMode;
  view: ViewMode;
  hideEmails: boolean;
  chartMode: ChartMode;
  burnHours: BurnWindow;
  futureUsage: FutureUsage;
}

const oneOf = <T,>(values: readonly T[], value: unknown, fallback: T): T =>
  values.includes(value as T) ? (value as T) : fallback;

const readUiState = (): UiState => {
  const fallback: UiState = {
    tab: 'all',
    sort: 'routing',
    view: 'ledger',
    hideEmails: true,
    chartMode: 'remaining',
    burnHours: 3,
    futureUsage: 'current',
  };
  try {
    const parsed = JSON.parse(localStorage.getItem(UI_STATE_KEY) ?? '{}') as Partial<UiState>;
    return {
      tab: TAB_IDS.includes(String(parsed.tab)) ? (parsed.tab as QuotaTabId) : fallback.tab,
      sort: OVERVIEW_SORT_MODES.includes(parsed.sort as OverviewSortMode)
        ? (parsed.sort as OverviewSortMode)
        : fallback.sort,
      view: VIEW_MODES.includes(parsed.view as ViewMode)
        ? (parsed.view as ViewMode)
        : fallback.view,
      hideEmails: typeof parsed.hideEmails === 'boolean' ? parsed.hideEmails : fallback.hideEmails,
      chartMode: oneOf(CHART_MODES, parsed.chartMode, fallback.chartMode),
      burnHours: oneOf(BURN_WINDOWS, parsed.burnHours, fallback.burnHours),
      futureUsage: oneOf(FUTURE_USAGE, parsed.futureUsage, fallback.futureUsage),
    };
  } catch {
    return fallback;
  }
};

const firstSeen = new WeakMap<object, number>();
/** A stable timestamp for a reading object: when this page first saw it. */
const firstSeenMs = (reading: object): number => {
  const seen = firstSeen.get(reading);
  if (seen !== undefined) return seen;
  const now = Date.now();
  firstSeen.set(reading, now);
  return now;
};

const matchesSearch = (file: AuthFileItem, query: string) => {
  if (!query) return true;
  const haystack = [file.name, file.email, file.note].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(query);
};

export function QuotaOverviewPage() {
  const { t, i18n } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const disableControls = connectionStatus !== 'connected';
  const nowMs = useNow();

  const [ui, setUi] = useState<UiState>(readUiState);
  const updateUi = useCallback((patch: Partial<UiState>) => {
    setUi((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(UI_STATE_KEY, JSON.stringify(next));
      } catch {
        // Storage can be unavailable; the view still works for this session.
      }
      return next;
    });
  }, []);
  const [search, setSearch] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  /* ---------- credentials ---------- */

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sessionGeneration = useQuotaStore((state) => state.cacheGeneration);
  const listRequestRef = useRef(0);

  /** `quiet` re-reads in the background without the loading state or clearing errors. */
  const loadFiles = useCallback(
    async (quiet = false) => {
      const requestId = ++listRequestRef.current;
      if (connectionStatus !== 'connected') {
        setFiles([]);
        setLoading(false);
        return;
      }
      const isCurrent = () =>
        requestId === listRequestRef.current &&
        sessionGeneration === useQuotaStore.getState().cacheGeneration;
      if (!quiet) {
        setLoading(true);
        setError('');
      }
      try {
        const data = await authFilesApi.list();
        if (isCurrent()) setFiles(data?.files || []);
      } catch (err: unknown) {
        if (isCurrent() && !quiet) {
          setError(err instanceof Error ? err.message : t('notification.refresh_failed'));
        }
      } finally {
        if (isCurrent() && !quiet) setLoading(false);
      }
    },
    [connectionStatus, sessionGeneration, t]
  );

  const refreshFiles = useCallback(() => loadFiles(), [loadFiles]);
  useHeaderRefresh(refreshFiles);

  useEffect(() => {
    void loadFiles();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadFiles(true);
    }, PROXY_POLL_MS);
    return () => {
      window.clearInterval(timer);
      listRequestRef.current += 1;
    };
  }, [loadFiles]);

  /* ---------- quota cache (shared with the upstream Quota page) ---------- */

  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const devinQuota = useQuotaStore((state) => state.devinQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const metaQuota = useQuotaStore((state) => state.metaQuota);
  const pluginQuota = useQuotaStore((state) => state.pluginQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);

  const quotaByType = useMemo(
    () =>
      ({
        antigravity: antigravityQuota,
        claude: claudeQuota,
        codex: codexQuota,
        devin: devinQuota,
        kimi: kimiQuota,
        meta: metaQuota,
        plugin: pluginQuota,
        xai: xaiQuota,
      }) as unknown as Record<QuotaProviderType, Record<string, QuotaCardState>>,
    [
      antigravityQuota,
      claudeQuota,
      codexQuota,
      devinQuota,
      kimiQuota,
      metaQuota,
      pluginQuota,
      xaiQuota,
    ]
  );

  const getQuota = useCallback(
    (entry: QuotaFileEntry): QuotaCardState | undefined =>
      quotaByType[entry.type][getQuotaCacheKey(entry.file)],
    [quotaByType]
  );

  const entries = useMemo(() => classifyQuotaFiles(files), [files]);
  const credentials = useMemo(
    () => entries.map((entry) => buildOverviewCredential(entry, getQuota(entry), nowMs)),
    [entries, getQuota, nowMs]
  );
  // Save each new weekly reading. Readings without an observation time (live
  // quota from providers that don't report one) are stamped when first seen.
  const apiBase = useAuthStore((state) => state.apiBase);
  useEffect(() => {
    if (!apiBase) return;
    credentials.forEach((credential) => {
      if (!credential.sample) return;
      const [, remaining, resetAtMs] = credential.sample;
      const at = credential.observedAtMs ?? firstSeenMs(credential.quota ?? credential);
      recordSample(
        apiBase,
        historyKey(credential.entry.type, getQuotaCacheKey(credential.entry.file)),
        [at, remaining, resetAtMs]
      );
    });
  }, [apiBase, credentials]);
  const history = useQuotaHistory();
  const pools = useMemo(
    () => buildProviderPools(credentials, QUOTA_TAB_ORDER, history),
    [credentials, history]
  );
  const visiblePools = pools.filter((pool) => ui.tab === 'all' || ui.tab === pool.provider);

  // Projection follows CPA's routing strategy; anything but fill-first spreads load.
  const routingStrategy = useConfigStore((state) => state.config?.routingStrategy);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  useEffect(() => {
    if (connectionStatus === 'connected') fetchConfig().catch(() => {});
  }, [connectionStatus, fetchConfig]);
  const routingMode =
    normalizeRoutingStrategy(routingStrategy) === 'fill-first' ? 'fill-first' : 'spread';

  const [rangeOffset, setRangeOffset] = useState(0);
  const rangeStartMs = useMemo(() => {
    const start = new Date(nowMs);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - RANGE_PAST_DAYS + rangeOffset * RANGE_STEP_DAYS);
    return start.getTime();
  }, [nowMs, rangeOffset]);
  const rangeEndMs = useMemo(() => {
    const end = new Date(rangeStartMs);
    end.setDate(end.getDate() + RANGE_DAYS);
    return end.getTime();
  }, [rangeStartMs]);
  const firstNames = useMemo(() => firstInLine(credentials), [credentials]);
  const tabCounts = useMemo(() => buildTabCounts(entries), [entries]);
  // Timeline lanes are labelled by file name; show the account's Note, masking emails.
  const displayNameFor = useMemo(() => {
    const labels = new Map(entries.map((entry) => [entry.file.name, credentialLabel(entry.file)]));
    return (name: string) => {
      const label = labels.get(name) ?? name;
      return ui.hideEmails ? maskEmails(label) : label;
    };
  }, [entries, ui.hideEmails]);

  const query = search.trim().toLowerCase();
  const visible = useMemo(() => {
    const inTab = new Set(filterEntriesByTab(entries, ui.tab));
    return sortCredentials(
      credentials.filter(
        (credential) => inTab.has(credential.entry) && matchesSearch(credential.entry.file, query)
      ),
      ui.sort,
      nowMs
    );
  }, [credentials, entries, nowMs, query, ui.sort, ui.tab]);
  const visibleEntries = useMemo(() => visible.map((credential) => credential.entry), [visible]);

  const { loadedCount, attentionCount } = useMemo(() => {
    let loaded = 0;
    let attention = 0;
    credentials.forEach((credential) => {
      if (credential.windows.length > 0) loaded += 1;
      if (credential.quota?.status === 'error') attention += 1;
    });
    return { loadedCount: loaded, attentionCount: attention };
  }, [credentials]);

  /* ---------- loading and actions ---------- */

  const claudeFiles = useMemo(
    () => entries.filter((entry) => entry.type === 'claude').map((entry) => entry.file),
    [entries]
  );
  const claudeTiers = useClaudeTiers(claudeFiles, connectionStatus === 'connected');

  const showNotification = useNotificationStore((state) => state.showNotification);
  const renameCredential = useCallback(
    async (file: AuthFileItem, note: string) => {
      try {
        await authFilesApi.patchFields(file.name, { note });
        showNotification(t('pd_overview.name_saved'), 'success');
        await loadFiles();
      } catch (err) {
        showNotification(t('pd_overview.name_failed'), 'error');
        throw err;
      }
    },
    [loadFiles, showNotification, t]
  );

  const { batchLoading, loadQuota } = useQuotaBatchLoader();
  const { resettingQuotaName, refreshQuota, resetQuota } = useQuotaActions(disableControls);
  const canUseActions = !disableControls && !loading;

  // This page is meant to stay open: load credentials that have never been
  // fetched, and refresh everything on an interval while the tab is visible.
  const loadableEntries = useMemo(() => entries.filter((entry) => !entry.file.disabled), [entries]);
  useEffect(() => {
    if (!canUseActions || batchLoading) return;
    const idle = loadableEntries.filter((entry) => !getQuota(entry));
    if (idle.length > 0) void loadQuota(idle);
  }, [batchLoading, canUseActions, getQuota, loadQuota, loadableEntries]);

  useEffect(() => {
    if (!canUseActions) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadQuota(loadableEntries);
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [canUseActions, loadQuota, loadableEntries]);

  const handleRefreshAll = useCallback(() => {
    if (!canUseActions) return;
    void loadQuota(loadableEntries);
  }, [canUseActions, loadQuota, loadableEntries]);

  const sortOptions = useMemo(
    () =>
      OVERVIEW_SORT_MODES.map((mode) => ({ value: mode, label: t(`pd_overview.sort_${mode}`) })),
    [t]
  );
  const viewOptions = useMemo(
    () => VIEW_MODES.map((mode) => ({ value: mode, label: t(`pd_overview.view_${mode}`) })),
    [t]
  );
  const futureOptions = useMemo(
    () => FUTURE_USAGE.map((mode) => ({ value: mode, label: t(`pd_overview.future_${mode}`) })),
    [t]
  );

  /* ---------- render ---------- */

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>{t('pd_overview.title')}</h1>
          <div className={styles.headerMeta}>
            <span>{t('pd_overview.credentials', { count: entries.length })}</span>
            <span>{t('pd_overview.loaded', { count: loadedCount })}</span>
            {attentionCount > 0 && (
              <span className={styles.danger}>
                {t('pd_overview.attention', { count: attentionCount })}
              </span>
            )}
            <Link to="/quota" className={styles.linkButton}>
              {t('pd_overview.official_page')}
            </Link>
          </div>
        </div>
        <Button
          size="sm"
          onClick={handleRefreshAll}
          loading={batchLoading}
          disabled={!canUseActions || loadableEntries.length === 0}
        >
          <IconRefreshCw size={14} aria-hidden="true" /> {t('pd_overview.refresh_all')}
        </Button>
      </header>

      {error && (
        <div className={styles.errorBanner} role="alert">
          {error}
        </div>
      )}

      {loading && entries.length === 0 ? (
        <div className={styles.poolList} aria-hidden="true">
          {Array.from({ length: 2 }, (_, index) => (
            <Skeleton key={index} height={420} rounded={14} />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          title={t('pd_overview.empty_title')}
          description={t('pd_overview.empty_desc')}
        />
      ) : (
        <>
          <ProviderTabs
            types={TAB_IDS}
            counts={tabCounts}
            active={ui.tab}
            resolvedTheme={resolvedTheme}
            onChange={(tab) => updateUi({ tab: tab as QuotaTabId })}
          />

          <div className={styles.chartControls}>
            <div className={styles.segmented} role="group" aria-label={t('pd_overview.chart_mode')}>
              {CHART_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={ui.chartMode === mode}
                  onClick={() => updateUi({ chartMode: mode })}
                >
                  {t(`pd_overview.mode_${mode}`)}
                </button>
              ))}
            </div>
            <div className={styles.controlGroup}>
              <span id="pd-burn-window" className={styles.controlLabel}>
                {t('pd_overview.burn_rate')}
              </span>
              <div className={styles.segmented} role="group" aria-labelledby="pd-burn-window">
                {BURN_WINDOWS.map((hours) => (
                  <button
                    key={hours}
                    type="button"
                    aria-pressed={ui.burnHours === hours}
                    onClick={() => updateUi({ burnHours: hours })}
                  >
                    {t('pd_overview.hours_short', { count: hours })}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.controlGroup}>
              <span id="pd-future-usage" className={styles.controlLabel}>
                {t('pd_overview.future_usage')}
              </span>
              <Select
                value={ui.futureUsage}
                options={futureOptions}
                onChange={(value) => updateUi({ futureUsage: value as FutureUsage })}
                ariaLabelledBy="pd-future-usage"
                size="sm"
              />
            </div>
            <div className={styles.rangeNav}>
              <span className={styles.rangeLabel}>
                {t('pd_overview.range', {
                  from: formatShortDate(rangeStartMs, i18n.language),
                  to: formatShortDate(rangeEndMs - 1, i18n.language),
                })}
              </span>
              <div className={styles.segmented}>
                <button
                  type="button"
                  onClick={() => setRangeOffset((value) => value - 1)}
                  aria-label={t('pd_overview.range_prev')}
                  title={t('pd_overview.range_prev')}
                >
                  <IconChevronLeft size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => setRangeOffset(0)}
                  disabled={rangeOffset === 0}
                >
                  {t('pd_overview.today')}
                </button>
                <button
                  type="button"
                  onClick={() => setRangeOffset((value) => value + 1)}
                  aria-label={t('pd_overview.range_next')}
                  title={t('pd_overview.range_next')}
                >
                  <IconChevronLeft size={14} aria-hidden="true" className={styles.flip} />
                </button>
              </div>
            </div>
          </div>

          <div className={styles.poolList}>
            {visiblePools.map((pool) => (
              <PoolChart
                key={pool.provider}
                provider={pool.provider}
                accounts={pool.accounts}
                credentialCount={pool.credentialCount}
                nowMs={nowMs}
                rangeStartMs={rangeStartMs}
                rangeEndMs={rangeEndMs}
                mode={ui.chartMode}
                burnHours={ui.burnHours}
                futureUsage={ui.futureUsage}
                routing={routingMode}
                hideEmails={ui.hideEmails}
                resolvedTheme={resolvedTheme}
              />
            ))}
          </div>

          <div className={styles.toolbar}>
            <div className={styles.search}>
              <IconSearch size={16} className={styles.searchIcon} aria-hidden="true" />
              <input
                ref={searchInputRef}
                className={styles.searchInput}
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('pd_overview.search_placeholder')}
                aria-label={t('pd_overview.search_label')}
              />
              {search && (
                <button
                  type="button"
                  className={styles.clearSearch}
                  aria-label={t('quota_management.search_clear')}
                  onClick={() => {
                    setSearch('');
                    searchInputRef.current?.focus();
                  }}
                >
                  <IconX size={14} aria-hidden="true" />
                </button>
              )}
            </div>
            <div className={styles.toolbarSelects}>
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => updateUi({ hideEmails: !ui.hideEmails })}
                aria-pressed={ui.hideEmails}
                aria-label={
                  ui.hideEmails ? t('pd_overview.show_emails') : t('pd_overview.hide_emails')
                }
                title={`${ui.hideEmails ? t('pd_overview.show_emails') : t('pd_overview.hide_emails')}. ${t('pd_overview.name_hint')}`}
              >
                {ui.hideEmails ? (
                  <IconEyeOff size={16} aria-hidden="true" />
                ) : (
                  <IconEye size={16} aria-hidden="true" />
                )}
              </button>
              <Select
                value={ui.view}
                options={viewOptions}
                onChange={(view) => updateUi({ view: view as ViewMode })}
                ariaLabel={t('pd_overview.view_label')}
                size="sm"
              />
              <Select
                value={ui.sort}
                options={sortOptions}
                onChange={(sort) => updateUi({ sort: sort as OverviewSortMode })}
                ariaLabel={t('pd_overview.sort_label')}
                size="sm"
              />
            </div>
          </div>

          {visible.length === 0 ? (
            <EmptyState title={t('pd_overview.search_empty_title')} />
          ) : ui.view === 'ledger' ? (
            <div className={styles.ledger}>
              <LedgerHeader />
              {visible.map((credential) => (
                <LedgerRow
                  key={`${credential.entry.type}:${getQuotaCacheKey(credential.entry.file)}`}
                  credential={credential}
                  resolvedTheme={resolvedTheme}
                  nowMs={nowMs}
                  firstInLine={firstNames.has(credential.entry.file.name)}
                  hideEmails={ui.hideEmails}
                  tier={
                    credential.entry.type === 'claude'
                      ? claudeTiers[credential.entry.file.name]
                      : null
                  }
                  onRename={(note) => renameCredential(credential.entry.file, note)}
                  canRefresh={canUseActions && !credential.entry.file.disabled}
                  resetting={resettingQuotaName === getQuotaCacheKey(credential.entry.file)}
                  onRefresh={() =>
                    void refreshQuota(credential.entry.file, QUOTA_ADAPTERS[credential.entry.type])
                  }
                  onReset={() =>
                    resetQuota(credential.entry.file, QUOTA_ADAPTERS[credential.entry.type])
                  }
                />
              ))}
            </div>
          ) : (
            <div className={`${styles.cardGrid} ${ui.hideEmails ? styles.redactCards : ''}`}>
              {visible.map((credential) => (
                <QuotaCard
                  key={`${credential.entry.type}:${getQuotaCacheKey(credential.entry.file)}`}
                  entry={credential.entry}
                  quota={credential.quota}
                  resolvedTheme={resolvedTheme}
                  canRefresh={canUseActions && !credential.entry.file.disabled}
                  resetting={resettingQuotaName === getQuotaCacheKey(credential.entry.file)}
                  entranceDelayMs={null}
                  onRefresh={() =>
                    void refreshQuota(credential.entry.file, QUOTA_ADAPTERS[credential.entry.type])
                  }
                  onReset={() =>
                    resetQuota(credential.entry.file, QUOTA_ADAPTERS[credential.entry.type])
                  }
                />
              ))}
            </div>
          )}

          <QuotaTimeline
            entries={visibleEntries}
            quotaFor={getQuota}
            displayNameFor={displayNameFor}
            resolvedTheme={resolvedTheme}
          />
        </>
      )}
    </div>
  );
}
