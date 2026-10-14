/**
 * Fork extension points. Upstream files reference only `customRoutes` and
 * `customObserveNavItems`; everything else stays inside src/custom.
 */

import { IconSidebarQuota } from '@/components/ui/icons';
import './i18n';
import { QuotaOverviewPage } from './quotaOverview/QuotaOverviewPage';

export const QUOTA_OVERVIEW_PATH = '/quota-overview';

export const customRoutes = [{ path: QUOTA_OVERVIEW_PATH, element: <QuotaOverviewPage /> }];

export const customObserveNavItems = [
  {
    path: QUOTA_OVERVIEW_PATH,
    labelKey: 'pd_overview.nav',
    metaKey: 'pd_overview.nav_meta',
    icon: <IconSidebarQuota size={18} />,
  },
];
