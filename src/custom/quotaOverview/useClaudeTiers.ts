/**
 * Claude subscription tier ("Max 20x") per credential.
 *
 * Upstream reads the OAuth profile but keeps only plan_max/plan_pro, dropping
 * `organization.rate_limit_tier`. This reads the same profile endpoint once per
 * credential and session, through the management API's api-call relay.
 */

import { useEffect, useState } from 'react';
import { apiCallApi } from '@/services/api';
import type { AuthFileItem } from '@/types';
import { CLAUDE_PROFILE_URL, CLAUDE_REQUEST_HEADERS, normalizeAuthIndex } from '@/utils/quota';

/** `default_claude_max_20x` → `Max 20x`; `..._pro` → `Pro`; unknown shapes → null. */
export function formatClaudeTier(tier: unknown): string | null {
  if (typeof tier !== 'string') return null;
  const max = /max_(\d+)x/i.exec(tier);
  if (max) return `Max ${max[1]}x`;
  if (/max/i.test(tier)) return 'Max';
  if (/pro/i.test(tier)) return 'Pro';
  if (/team/i.test(tier)) return 'Team';
  return null;
}

const tierCache = new Map<string, string | null>();

const readTier = async (authIndex: string): Promise<string | null> => {
  const result = await apiCallApi.request({
    authIndex,
    method: 'GET',
    url: CLAUDE_PROFILE_URL,
    header: { ...CLAUDE_REQUEST_HEADERS },
  });
  if (result.statusCode < 200 || result.statusCode >= 300) return null;
  const body = (typeof result.body === 'string' ? JSON.parse(result.body) : result.body) as {
    organization?: { rate_limit_tier?: unknown };
  } | null;
  return formatClaudeTier(body?.organization?.rate_limit_tier);
};

/** Map of file name → tier label for the given Claude credentials. */
export function useClaudeTiers(files: readonly AuthFileItem[], enabled: boolean) {
  const [tiers, setTiers] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(tierCache)
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    files.forEach((file) => {
      const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
      if (!authIndex || tierCache.has(file.name)) return;
      tierCache.set(file.name, null);
      readTier(authIndex)
        .then((tier) => {
          tierCache.set(file.name, tier);
          if (!cancelled) setTiers(Object.fromEntries(tierCache));
        })
        .catch(() => tierCache.delete(file.name));
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, files]);

  return tiers;
}
