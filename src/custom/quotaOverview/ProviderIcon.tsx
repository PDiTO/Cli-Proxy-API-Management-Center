import type { ResolvedTheme } from '@/types';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import styles from './QuotaOverviewPage.module.scss';

export function ProviderIcon({
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
