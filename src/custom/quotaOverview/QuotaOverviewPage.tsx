/**
 * Quota Overview: pooled provider capacity, a compact ledger in routing order,
 * and upstream's cards and timeline as alternatives.
 *
 * Fork-only page (see src/custom/README.md). Data loading reuses the upstream
 * quota store, loader and actions, so both quota pages share one cache.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { authFilesApi } from '@/services/api';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconEye, IconEyeOff, IconRefreshCw, IconSearch, IconX } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { useAuthStore, useQuotaStore, useThemeStore } from '@/stores';
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
import { LedgerHeader, LedgerRow, ProviderSummaryCard } from './components';
import {
  OVERVIEW_SORT_MODES,
  buildOverviewCredential,
  buildProviderSummaries,
  credentialLabel,
  maskEmails,
  firstInLine,
  sortCredentials,
  type OverviewSortMode,
} from './model';
import styles from './QuotaOverviewPage.module.scss';

const TAB_IDS: string[] = ['all', ...QUOTA_TAB_ORDER];
const VIEW_MODES = ['ledger', 'cards'] as const;
type ViewMode = (typeof VIEW_MODES)[number];
const UI_STATE_KEY = 'pd-quota-overview';
/** Background refresh while the page is visible; quota endpoints are rate-limited upstream. */
const AUTO_REFRESH_MS = 15 * 60 * 1000;

interface UiState {
  tab: QuotaTabId;
  sort: OverviewSortMode;
  view: ViewMode;
  hideEmails: boolean;
}

const readUiState = (): UiState => {
  const fallback: UiState = { tab: 'all', sort: 'routing', view: 'ledger', hideEmails: true };
  try {
    const parsed = JSON.parse(localStorage.getItem(UI_STATE_KEY) ?? '{}') as Partial<UiState>;
    return {
      tab: TAB_IDS.includes(String(parsed.tab)) ? (parsed.tab as QuotaTabId) : fallback.tab,
      sort: OVERVIEW_SORT_MODES.includes(parsed.sort as OverviewSortMode)
        ? (parsed.sort as OverviewSortMode)
        : fallback.sort,
      view: VIEW_MODES.includes(parsed.view as ViewMode) ? (parsed.view as ViewMode) : fallback.view,
      hideEmails: typeof parsed.hideEmails === 'boolean' ? parsed.hideEmails : fallback.hideEmails,
    };
  } catch {
    return fallback;
  }
};

const matchesSearch = (file: AuthFileItem, query: string) => {
  if (!query) return true;
  const haystack = [file.name, file.email, file.note].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(query);
};

export function QuotaOverviewPage() {
  const { t } = useTranslation();
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

  const loadFiles = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    if (connectionStatus !== 'connected') {
      setFiles([]);
      setLoading(false);
      return;
    }
    const isCurrent = () =>
      requestId === listRequestRef.current &&
      sessionGeneration === useQuotaStore.getState().cacheGeneration;
    setLoading(true);
    setError('');
    try {
      const data = await authFilesApi.list();
      if (isCurrent()) setFiles(data?.files || []);
    } catch (err: unknown) {
      if (isCurrent()) {
        setError(err instanceof Error ? err.message : t('notification.refresh_failed'));
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [connectionStatus, sessionGeneration, t]);

  useHeaderRefresh(loadFiles);

  useEffect(() => {
    void loadFiles();
    return () => {
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
  const summaries = useMemo(
    () => buildProviderSummaries(credentials, QUOTA_TAB_ORDER, nowMs),
    [credentials, nowMs]
  );
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
      if (credential.quota?.status === 'success') loaded += 1;
      else if (credential.quota?.status === 'error') attention += 1;
    });
    return { loadedCount: loaded, attentionCount: attention };
  }, [credentials]);

  /* ---------- loading and actions ---------- */

  const { batchLoading, loadQuota } = useQuotaBatchLoader();
  const { resettingQuotaName, refreshQuota, resetQuota } = useQuotaActions(disableControls);
  const canUseActions = !disableControls && !loading;

  // This page is meant to stay open: load credentials that have never been
  // fetched, and refresh everything on an interval while the tab is visible.
  const loadableEntries = useMemo(
    () => entries.filter((entry) => !entry.file.disabled),
    [entries]
  );
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
    () => OVERVIEW_SORT_MODES.map((mode) => ({ value: mode, label: t(`pd_overview.sort_${mode}`) })),
    [t]
  );
  const viewOptions = useMemo(
    () => VIEW_MODES.map((mode) => ({ value: mode, label: t(`pd_overview.view_${mode}`) })),
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
        <div className={styles.summaryGrid} aria-hidden="true">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} height={170} rounded={14} />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState title={t('pd_overview.empty_title')} description={t('pd_overview.empty_desc')} />
      ) : (
        <>
          <div
            className={styles.summaryGrid}
            style={{ '--summary-columns': Math.min(summaries.length, 4) } as CSSProperties}
          >
            {summaries.map((summary) => (
              <ProviderSummaryCard
                key={summary.provider}
                summary={summary}
                resolvedTheme={resolvedTheme}
                nowMs={nowMs}
                active={ui.tab === summary.provider}
                onSelect={(provider) => updateUi({ tab: ui.tab === provider ? 'all' : provider })}
              />
            ))}
          </div>

          <ProviderTabs
            types={TAB_IDS}
            counts={tabCounts}
            active={ui.tab}
            resolvedTheme={resolvedTheme}
            onChange={(tab) => updateUi({ tab: tab as QuotaTabId })}
          />

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
                aria-label={ui.hideEmails ? t('pd_overview.show_emails') : t('pd_overview.hide_emails')}
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
