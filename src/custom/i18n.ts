/**
 * Fork-only strings, registered at runtime so upstream locale files stay untouched.
 * Every language gets the English text; add a translation here to override it.
 */

import i18n from '@/i18n';

const en = {
  nav: 'Quota Overview',
  nav_meta: 'Pooled quota and routing order',
  title: 'Quota Overview',
  credentials_one: '{{count}} credential',
  credentials_other: '{{count}} credentials',
  loaded: '{{count}} loaded',
  attention: '{{count}} need attention',
  refresh_all: 'Refresh all',
  refresh: 'Refresh quota',
  search_placeholder: 'Search by filename, email or note',
  search_label: 'Search credentials',
  sort_label: 'Sort',
  sort_routing: 'Routing order',
  sort_soonest: 'Soonest recovery',
  sort_remaining: 'Most remaining',
  sort_name: 'Name',
  view_label: 'View',
  view_ledger: 'Ledger',
  view_cards: 'Cards',
  of_total: 'of {{total}}%',
  credential_count_one: '{{count}} credential',
  credential_count_other: '{{count}} credentials',
  not_loaded: '{{count}} not loaded',
  resets: '{{relative}} · {{date}}',
  show_more: 'Show',
  show_less: 'Hide',
  first_in_line: 'First in line',
  first_in_line_hint:
    'New sessions use this credential first under fill-first routing. Running sessions can stay on another one.',
  priority: 'P{{value}}',
  priority_hint: 'Routing priority: higher is used first',
  back_in: 'back in {{time}}',
  parked: 'parked {{time}}',
  parked_hint: 'The proxy has parked this credential after a limit response',
  disabled: 'disabled',
  not_loaded_row: 'Quota not loaded',
  load: 'Load quota',
  error: 'Quota request failed',
  no_reset: 'No reset pending',
  resets_remaining: 'Resets remaining: {{count}}',
  reset_expires: 'Expires {{date}}',
  reset_limits: 'Reset limits',
  empty_title: 'No quota-capable credentials',
  empty_desc: 'Add Claude, Codex or another quota-capable account under OAuth Login.',
  search_empty_title: 'No matching credentials',
  official_page: 'Official quota page',
};

for (const language of Object.keys(i18n.options.resources ?? {})) {
  i18n.addResourceBundle(language, 'translation', { pd_overview: en }, true, false);
}
