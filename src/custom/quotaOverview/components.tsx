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
  containsEmail,
  credentialLabel,
  formatCountdown,
  maskEmails,
  resetUrgency,
  type ResetUrgency,
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

/** Text that may contain an email: blurred when emails are hidden. */
function Private({ text, hide, className }: { text: string; hide: boolean; className?: string }) {
  const redact = hide && containsEmail(text);
  return (
    <span
      className={`${className ?? ''} ${redact ? styles.redacted : ''}`}
      title={redact ? undefined : text}
      aria-label={redact ? maskEmails(text) : undefined}
    >
      {text}
    </span>
  );
}

const urgencyClass: Record<ResetUrgency, string> = {
  day: styles.urgencyDay,
  week: styles.urgencyWeek,
  later: '',
  none: '',
};

interface ResetCreditView {
  id: string;
  count: number;
  label: string | null;
  expiresAtMs: number | null;
}

function ResetsCell({
  credits,
  nowMs,
  canUse,
  onUse,
  readError,
}: {
  credits: ResetCreditView[] | null;
  nowMs: number;
  canUse: boolean;
  onUse: () => void;
  readError?: boolean;
}) {
  const { t } = useTranslation();
  if (credits === null) {
    return (
      <div className={styles.rowResets}>
        {readError && <span className={styles.muted}>{t('pd_overview.resets_unreadable')}</span>}
      </div>
    );
  }
  const sorted = [...credits].sort(
    (a, b) => (a.expiresAtMs ?? Infinity) - (b.expiresAtMs ?? Infinity)
  );
  return (
    <div className={styles.rowResets}>
      {sorted.length === 0 ? (
        <span className={styles.muted}>{t('pd_overview.no_resets')}</span>
      ) : (
        <ul className={styles.resetList}>
          {sorted.map((credit) => (
            <li
              key={credit.id}
              className={urgencyClass[resetUrgency(credit.expiresAtMs, nowMs)]}
              title={credit.label ?? undefined}
            >
              {credit.count > 1 && (
                <strong>{t('pd_overview.reset_count', { count: credit.count })} </strong>
              )}
              {credit.expiresAtMs === null ? (
                t('pd_overview.no_expiry')
              ) : (
                <>
                  <span className={styles.resetDate}>{formatInstantShort(credit.expiresAtMs)}</span>
                  {' · '}
                  {formatRelativeInstant(credit.expiresAtMs, nowMs)}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {sorted.length > 0 && (
        <button type="button" className={styles.ghostButton} disabled={!canUse} onClick={onUse}>
          {t('pd_overview.use_reset')}
        </button>
      )}
    </div>
  );
}

export function LedgerHeader() {
  const { t } = useTranslation();
  return (
    <div className={`${styles.row} ${styles.rowHeader}`} aria-hidden="true">
      <span>{t('pd_overview.col_account')}</span>
      <span>{t('pd_overview.col_limits')}</span>
      <span>{t('pd_overview.col_resets')}</span>
      <span />
    </div>
  );
}

export interface LedgerRowProps {
  credential: OverviewCredential;
  resolvedTheme: ResolvedTheme;
  nowMs: number;
  firstInLine: boolean;
  hideEmails: boolean;
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
  hideEmails,
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

  let credits: ResetCreditView[] | null = null;
  let canUseReset = false;
  let useReset = () => {};
  if (entry.type === 'claude' && claudeReset.count !== null) {
    credits = claudeReset.grants
      .filter((grant) => grant.resetsLeft > 0)
      .map((grant) => {
        const ends = grant.endsAt ? Date.parse(grant.endsAt) : NaN;
        return {
          id: grant.id,
          count: grant.resetsLeft,
          label: grant.label || null,
          expiresAtMs: Number.isFinite(ends) ? ends : null,
        };
      });
    canUseReset = !claudeReset.blocked;
    useReset = claudeReset.confirm;
  } else if (entry.type === 'codex' && quota?.status === 'success') {
    const raw =
      (quota as { rateLimitResetCredits?: { id?: string; status?: string; expiresAt?: string }[] })
        .rateLimitResetCredits ?? [];
    credits = raw
      .filter((credit) => credit.status === 'available')
      .map((credit, index) => {
        const ends = Date.parse(credit.expiresAt ?? '');
        return {
          id: credit.id || `credit-${index}`,
          count: 1,
          label: null,
          expiresAtMs: Number.isFinite(ends) ? ends : null,
        };
      });
    canUseReset = Boolean(
      adapter.resetQuota && adapter.canResetQuota?.(quota) && canRefresh && !resetting
    );
    useReset = onReset;
  }

  const name = credentialLabel(file);
  const planLabel = credential.plan
    ? [`${adapter.i18nPrefix}.${credential.plan}`, `${adapter.i18nPrefix}.plan_${credential.plan}`]
        .filter((key) => i18n.exists(key))
        .map((key) => t(key))[0] ?? credential.plan
    : null;
  const refreshLabel = status === 'idle' ? t('pd_overview.load') : t('pd_overview.refresh');

  return (
    <div className={styles.row} data-first={firstInLine || undefined}>
      <div className={styles.rowIdentity}>
        <div className={styles.rowName}>
          <ProviderIcon provider={entry.type} resolvedTheme={resolvedTheme} />
          <Private text={name} hide={hideEmails} className={styles.mono} />
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
        {name !== file.name && (
          <Private text={file.name} hide={hideEmails} className={styles.rowFile} />
        )}
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

      <ResetsCell
        credits={credits}
        nowMs={nowMs}
        canUse={canUseReset}
        onUse={useReset}
        readError={entry.type === 'claude' && claudeReset.message === 'read_error'}
      />

      <button
        type="button"
        className={styles.iconButton}
        disabled={!canRefresh || loading}
        onClick={onRefresh}
        aria-label={refreshLabel}
        title={refreshLabel}
      >
        <IconRefreshCw size={16} aria-hidden="true" className={loading ? styles.spin : undefined} />
      </button>
    </div>
  );
}
