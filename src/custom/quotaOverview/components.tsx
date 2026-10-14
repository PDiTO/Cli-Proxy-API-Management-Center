/**
 * Quota Overview building blocks: provider summary cards and ledger rows.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import type { ResolvedTheme } from '@/types';
import { formatInstantShort, formatRelativeInstant } from '@/utils/quota';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import {
  QUOTA_PROGRESS_HIGH_THRESHOLD,
  QUOTA_PROGRESS_MEDIUM_THRESHOLD,
} from '@/features/quota/components/QuotaMeter';
import { QUOTA_ADAPTERS } from '@/features/quota/providers';
import { useClaudeResetGrants } from '@/features/quota/providers/claude/ClaudeResetGrants';
import type { QuotaProviderType } from '@/features/quota/providers/types';
import {
  formatCountdown,
  type OverviewCredential,
  type OverviewProviderSummary,
  type OverviewSummaryLine,
} from './model';
import styles from './QuotaOverviewPage.module.scss';

const levelClass = (percent: number | null) =>
  percent === null
    ? styles.levelNone
    : percent >= QUOTA_PROGRESS_HIGH_THRESHOLD
      ? styles.levelHigh
      : percent >= QUOTA_PROGRESS_MEDIUM_THRESHOLD
        ? styles.levelMedium
        : styles.levelLow;

function Bar({ percent }: { percent: number | null }) {
  const width = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div className={styles.bar}>
      <div className={`${styles.barFill} ${levelClass(percent)}`} style={{ width: `${width}%` }} />
    </div>
  );
}

function ProviderIcon({
  provider,
  resolvedTheme,
}: {
  provider: string;
  resolvedTheme: ResolvedTheme;
}) {
  const icon = getAuthFileIcon(provider, resolvedTheme);
  if (!icon) return <span className={styles.iconFallback} aria-hidden="true" />;
  const surface = isThemeSurfaceIconProvider(provider)
    ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
    : undefined;
  return <img className={styles.icon} src={icon} alt="" style={surface} aria-hidden="true" />;
}

function ResetWhen({ atMs, nowMs }: { atMs: number | null; nowMs: number }) {
  const { t, i18n } = useTranslation();
  if (atMs === null || atMs <= nowMs) {
    return <span className={styles.muted}>{t('pd_overview.no_reset')}</span>;
  }
  return (
    <span className={styles.muted}>
      <strong className={styles.relative}>{formatRelativeInstant(atMs, nowMs, i18n.language)}</strong>
      {' · '}
      {formatInstantShort(atMs)}
    </span>
  );
}

function SummaryLine({ line, nowMs }: { line: OverviewSummaryLine; nowMs: number }) {
  const { t } = useTranslation();
  return (
    <div className={styles.summaryLine}>
      <div className={styles.summaryLabel}>{line.label}</div>
      <div className={styles.summaryValue}>
        <span className={styles.summaryBig}>{Math.round(line.remaining)}%</span>
        <span className={styles.muted}>{t('pd_overview.of_total', { total: line.total })}</span>
      </div>
      <div className={styles.segments}>
        {line.segments.map((segment, index) => (
          <Bar key={index} percent={segment} />
        ))}
      </div>
      <ResetWhen atMs={line.soonestResetMs} nowMs={nowMs} />
    </div>
  );
}

export function ProviderSummaryCard({
  summary,
  resolvedTheme,
  nowMs,
  active,
  onSelect,
}: {
  summary: OverviewProviderSummary;
  resolvedTheme: ResolvedTheme;
  nowMs: number;
  active: boolean;
  onSelect: (provider: QuotaProviderType) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const notLoaded = summary.credentialCount - summary.loadedCount;
  return (
    <section className={`${styles.summaryCard} ${active ? styles.summaryCardActive : ''}`}>
      <button
        type="button"
        className={styles.summaryHead}
        onClick={() => onSelect(summary.provider)}
        aria-pressed={active}
      >
        <ProviderIcon provider={summary.provider} resolvedTheme={resolvedTheme} />
        <span className={styles.summaryName}>{getTypeLabel(t, summary.provider)}</span>
        <span className={styles.muted}>
          {t('pd_overview.credential_count', { count: summary.credentialCount })}
        </span>
      </button>
      {summary.primary ? (
        <SummaryLine line={summary.primary} nowMs={nowMs} />
      ) : (
        <div className={styles.muted}>{t('pd_overview.not_loaded_row')}</div>
      )}
      {notLoaded > 0 && summary.primary && (
        <div className={styles.muted}>{t('pd_overview.not_loaded', { count: notLoaded })}</div>
      )}
      {summary.secondary.length > 0 && (
        <div className={styles.secondary}>
          {expanded ? (
            summary.secondary.map((line) => (
              <SummaryLine key={line.id} line={line} nowMs={nowMs} />
            ))
          ) : (
            <div className={styles.secondaryCollapsed}>
              {summary.secondary.map((line) => (
                <span key={line.id}>
                  {line.label} <strong>{Math.round(line.remaining)}%</strong>
                </span>
              ))}
            </div>
          )}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            {expanded ? t('pd_overview.show_less') : t('pd_overview.show_more')}
          </button>
        </div>
      )}
    </section>
  );
}

const displayName = (credential: OverviewCredential): string => {
  const file = credential.entry.file;
  return file.note?.trim() || file.email?.trim() || file.name;
};

export interface LedgerRowProps {
  credential: OverviewCredential;
  resolvedTheme: ResolvedTheme;
  nowMs: number;
  firstInLine: boolean;
  canRefresh: boolean;
  resetting: boolean;
  onRefresh: () => void;
  onReset: () => void;
}

export function LedgerRow({
  credential,
  resolvedTheme,
  nowMs,
  firstInLine,
  canRefresh,
  resetting,
  onRefresh,
  onReset,
}: LedgerRowProps) {
  const { t, i18n } = useTranslation();
  const { entry, quota } = credential;
  const file = entry.file;
  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';
  const claudeReset = useClaudeResetGrants(
    file,
    entry.type === 'claude' && status !== 'idle',
    !canRefresh || loading || resetting,
    quota,
    onRefresh
  );
  const adapter = QUOTA_ADAPTERS[entry.type];
  const codexCredits =
    entry.type === 'codex'
      ? (quota as { rateLimitResetCreditsAvailableCount?: number | null } | undefined)
          ?.rateLimitResetCreditsAvailableCount ?? null
      : null;
  const canCodexReset = Boolean(
    adapter.resetQuota && quota && adapter.canResetQuota?.(quota) && canRefresh && !loading
  );
  const soonestGrantExpiry = claudeReset.grants
    .filter((grant) => grant.resetsLeft > 0 && grant.endsAt)
    .map((grant) => Date.parse(grant.endsAt ?? ''))
    .filter((ms) => Number.isFinite(ms) && ms > nowMs)
    .sort((a, b) => a - b)[0];
  const name = displayName(credential);
  const planLabel = credential.plan
    ? [`${adapter.i18nPrefix}.${credential.plan}`, `${adapter.i18nPrefix}.plan_${credential.plan}`]
        .filter((key) => i18n.exists(key))
        .map((key) => t(key))[0] ?? credential.plan
    : null;

  return (
    <div className={styles.row} data-first={firstInLine || undefined}>
      <div className={styles.rowIdentity}>
        <div className={styles.rowName}>
          <ProviderIcon provider={entry.type} resolvedTheme={resolvedTheme} />
          <span className={styles.mono} title={file.name}>
            {name}
          </span>
        </div>
        <div className={styles.rowMeta}>
          <span
            className={styles.badge}
            title={t('pd_overview.priority_hint')}
            aria-label={t('pd_overview.priority_hint')}
          >
            {t('pd_overview.priority', { value: credential.priority })}
          </span>
          {planLabel && <span>{planLabel}</span>}
          {firstInLine && (
            <span className={styles.badgeActive} title={t('pd_overview.first_in_line_hint')}>
              {t('pd_overview.first_in_line')}
            </span>
          )}
          {file.disabled && <span className={styles.danger}>{t('pd_overview.disabled')}</span>}
          {credential.backAtMs !== null && (
            <span className={styles.danger}>
              {t('pd_overview.back_in', { time: formatCountdown(credential.backAtMs, nowMs) })}
            </span>
          )}
          {credential.backAtMs === null && credential.cooldownUntilMs !== null && (
            <span className={styles.warning} title={t('pd_overview.parked_hint')}>
              {t('pd_overview.parked', {
                time: formatCountdown(credential.cooldownUntilMs, nowMs),
              })}
            </span>
          )}
        </div>
        {name !== file.name && <div className={styles.rowFile}>{file.name}</div>}
      </div>

      <div className={styles.rowWindows}>
        {status === 'success' && credential.windows.length > 0 ? (
          credential.windows.map((window) => (
            <div key={window.id} className={styles.window}>
              <div className={styles.windowHead}>
                <span className={styles.windowLabel} title={window.label}>
                  {window.label}
                </span>
                <strong>{window.remaining === null ? '–' : `${Math.round(window.remaining)}%`}</strong>
              </div>
              <Bar percent={window.remaining} />
              <ResetWhen atMs={window.resetAtMs} nowMs={nowMs} />
            </div>
          ))
        ) : (
          <div className={styles.rowState}>
            {loading
              ? '…'
              : status === 'error'
                ? `${t('pd_overview.error')}${quota?.error ? `: ${quota.error}` : ''}`
                : t('pd_overview.not_loaded_row')}
          </div>
        )}
      </div>

      <div className={styles.rowActions}>
        {entry.type === 'claude' && claudeReset.count !== null && (
          <div className={styles.resetInfo}>
            <span>{t('pd_overview.resets_remaining', { count: claudeReset.count })}</span>
            {soonestGrantExpiry !== undefined && (
              <span className={styles.muted}>
                {t('pd_overview.reset_expires', { date: formatInstantShort(soonestGrantExpiry) })}
              </span>
            )}
          </div>
        )}
        {codexCredits !== null && (
          <div className={styles.resetInfo}>
            <span>{t('pd_overview.resets_remaining', { count: codexCredits })}</span>
          </div>
        )}
        <div className={styles.rowButtons}>
          {entry.type === 'claude' && claudeReset.count !== null && (
            <button
              type="button"
              className={styles.ghostButton}
              disabled={claudeReset.blocked}
              onClick={claudeReset.confirm}
            >
              <IconRefreshCw size={13} aria-hidden="true" />
              {t('pd_overview.reset_limits')}
            </button>
          )}
          {codexCredits !== null && (
            <button
              type="button"
              className={styles.ghostButton}
              disabled={!canCodexReset || resetting}
              onClick={onReset}
            >
              <IconRefreshCw size={13} aria-hidden="true" />
              {t('pd_overview.reset_limits')}
            </button>
          )}
          <button
            type="button"
            className={styles.ghostButton}
            disabled={!canRefresh || loading}
            onClick={onRefresh}
          >
            <IconRefreshCw size={13} aria-hidden="true" />
            {status === 'idle' ? t('pd_overview.load') : t('pd_overview.refresh')}
          </button>
        </div>
      </div>
    </div>
  );
}
