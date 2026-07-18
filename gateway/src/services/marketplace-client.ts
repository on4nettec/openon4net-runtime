import type { Env } from '../env.js';

export interface MarketplacePluginSummary {
  pluginId: string;
  packageName: string;
  name: string;
  description: string | null;
  publisherSlug: string;
  publisherVerified: boolean;
  latestVersion: string | null;
  manifest: {
    configSchema?: { key: string; label: string; type: string }[];
    /** RT-079 — declares this plugin as a thin HTTP-provider wrapper, invokable from a Workflow's `plugin` step. */
    provider?: { type: 'http'; baseUrl: string };
  } | null;
  /** Declared permissions of the latest approved version (MKT-020) — shown as a consent prompt before install. */
  permissions: string[];
  installCount: number;
  avgRating: number | null;
  ratingCount: number;
  /** From the latest approved version's pricing (RT-057) — null/0 means free. */
  priceCredits: number | null;
  createdAt: string;
}

export interface MarketplaceSkillSummary {
  skillId: string;
  slug: string;
  name: string;
  description: string | null;
  priceCents: number;
  publisherSlug: string;
  installCount: number;
  avgRating: number | null;
  ratingCount: number;
  createdAt: string;
}

export interface PublisherPluginSummary {
  pluginId: string;
  packageName: string;
  name: string;
  description: string | null;
  status: string;
  publisherId: string;
  publisherSlug: string;
  latestVersion: string | null;
  latestVersionStatus: string | null;
  createdAt: string;
}

export interface SubmitPluginInput {
  publisherSlug: string;
  publisherDisplayName: string;
  packageName: string;
  name: string;
  description?: string | undefined;
  version: string;
  manifest: Record<string, unknown>;
  permissions?: string[] | undefined;
}

export interface PublisherSkillSummary {
  skillId: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  priceCents: number;
  publisherId: string;
  publisherSlug: string;
  createdAt: string;
}

export interface SubmitSkillInput {
  publisherSlug: string;
  publisherDisplayName: string;
  skillSlug: string;
  name: string;
  description?: string | undefined;
  definition: Record<string, unknown>;
  priceCents?: number | undefined;
}

export interface InstallSkillResult {
  installId: string;
  organizationId: string;
  skillId: string;
  priceCents: number;
  definition: Record<string, unknown>;
  isActive: boolean;
  installedAt: string;
}

/** Thrown when the marketplace service responds with PERMISSION_DIFF_REQUIRED (409) — an upgrade widening permissions needs explicit re-consent (MKT-010). */
export class PermissionDiffRequiredError extends Error {
  constructor(
    public addedPermissions: string[],
    public fromVersion: string,
    public toVersion: string,
  ) {
    super(`Upgrading from ${fromVersion} to ${toVersion} requests new permissions: ${addedPermissions.join(', ')}`);
    this.name = 'PermissionDiffRequiredError';
  }
}

interface MarketplaceErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

/** Carries the marketplace service's own error `code` through, instead of a plain Error's message-only text — lets callers branch reliably (e.g. getPlugin/getSkill checking for NOT_FOUND) without regex-matching prose. */
export class MarketplaceRequestError extends Error {
  constructor(
    message: string,
    public code: string | undefined,
    public status: number,
  ) {
    super(message);
    this.name = 'MarketplaceRequestError';
  }
}

/**
 * RT-093 — when a caller passes a `securityToken` (only the authenticated
 * endpoints below ever do — CP-032's short-lived per-org token) AND
 * CONTROL_PLANE_URL is configured, the request goes through Platform's
 * CP-034 proxy instead of straight to Marketplace with the static
 * MARKETPLACE_API_KEY. `path` already starts with `/marketplace/...` for
 * every caller, and Platform's proxy route is registered at
 * `/v1/proxy/marketplace/*`, so switching just the base URL (not
 * transforming `path` itself) lands on the right upstream route either way.
 * Falls back to the original direct-to-Marketplace behavior when no token
 * is available — pure self-host orgs with no activation relationship keep
 * working exactly as before.
 */
async function marketplaceRequest<T>(
  env: Env,
  path: string,
  init?: RequestInit,
  securityToken?: string | null,
): Promise<T> {
  const useProxy = Boolean(securityToken && env.CONTROL_PLANE_URL);
  const baseUrl = useProxy ? `${env.CONTROL_PLANE_URL}/v1/proxy` : env.MARKETPLACE_SERVICE_URL;
  if (!baseUrl) {
    throw new Error('MARKETPLACE_SERVICE_URL is not configured');
  }
  const headers = new Headers(init?.headers);
  if (useProxy) {
    headers.set('Authorization', `Bearer ${securityToken}`);
  } else if (env.MARKETPLACE_API_KEY) {
    headers.set('Authorization', `Bearer ${env.MARKETPLACE_API_KEY}`);
  }
  if (init?.body !== undefined) headers.set('Content-Type', 'application/json');

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as MarketplaceErrorBody | null;
    if (body?.error?.code === 'PERMISSION_DIFF_REQUIRED') {
      const details = body.error.details as { addedPermissions?: string[]; fromVersion?: string; toVersion?: string } | undefined;
      throw new PermissionDiffRequiredError(details?.addedPermissions ?? [], details?.fromVersion ?? '?', details?.toVersion ?? '?');
    }
    throw new MarketplaceRequestError(
      body?.error?.message ?? `Marketplace request failed with status ${response.status}`,
      body?.error?.code,
      response.status,
    );
  }
  return (await response.json()) as T;
}

export interface InstallPluginOptions {
  version?: string | undefined;
  acknowledgePermissionDiff?: boolean | undefined;
}

/** Thin fetch-wrapper over apps/openon4net-marketplace's HTTP API — a separate service/repo, not a library import. */
export const marketplaceClient = {
  listPlugins: (env: Env) => marketplaceRequest<{ plugins: MarketplacePluginSummary[]; total: number }>(env, '/marketplace/plugins'),

  listSkills: (env: Env) => marketplaceRequest<{ skills: MarketplaceSkillSummary[]; total: number }>(env, '/marketplace/skills'),

  /** RT-057 — learn a plugin's price before deciding whether to debit the installing org's wallet. Returns null for an unknown/unapproved plugin. */
  getPlugin: async (env: Env, pluginId: string): Promise<MarketplacePluginSummary | null> => {
    try {
      return await marketplaceRequest<MarketplacePluginSummary>(env, `/marketplace/plugins/${pluginId}`);
    } catch (err) {
      if (err instanceof MarketplaceRequestError && err.status === 404) return null;
      throw err;
    }
  },

  /** RT-057 — same, for skills. Returns null for an unknown/delisted skill. */
  getSkill: async (env: Env, skillId: string): Promise<MarketplaceSkillSummary | null> => {
    try {
      return await marketplaceRequest<MarketplaceSkillSummary>(env, `/marketplace/skills/${skillId}`);
    } catch (err) {
      if (err instanceof MarketplaceRequestError && err.status === 404) return null;
      throw err;
    }
  },

  // RT-093 — the remaining methods below all require Marketplace auth
  // (install/rate/publish), so each takes an optional securityToken: when
  // the caller (routes/marketplace.ts) has one from a recent activation
  // check-in, the call is mediated through Platform's CP-034 proxy instead
  // of using the static MARKETPLACE_API_KEY directly.
  installPlugin: (
    env: Env,
    pluginId: string,
    organizationId: string,
    opts: InstallPluginOptions = {},
    securityToken?: string | null,
  ) =>
    marketplaceRequest<Record<string, unknown>>(
      env,
      `/marketplace/plugins/${pluginId}/install`,
      {
        method: 'POST',
        body: JSON.stringify({
          organizationId,
          version: opts.version,
          acknowledgePermissionDiff: opts.acknowledgePermissionDiff,
        }),
      },
      securityToken,
    ),

  installSkill: (env: Env, skillId: string, organizationId: string, securityToken?: string | null) =>
    marketplaceRequest<InstallSkillResult>(
      env,
      `/marketplace/skills/${skillId}/install`,
      { method: 'POST', body: JSON.stringify({ organizationId }) },
      securityToken,
    ),

  updatePluginInstallConfig: (
    env: Env,
    installId: string,
    organizationId: string,
    config: Record<string, unknown>,
    securityToken?: string | null,
  ) =>
    marketplaceRequest<{ installId: string; config: Record<string, unknown> }>(
      env,
      `/marketplace/installs/${installId}/config`,
      { method: 'PATCH', body: JSON.stringify({ organizationId, config }) },
      securityToken,
    ),

  ratePlugin: (
    env: Env,
    pluginId: string,
    organizationId: string,
    rating: number,
    review?: string,
    securityToken?: string | null,
  ) =>
    marketplaceRequest<{ pluginId: string; organizationId: string; rating: number; review: string | null }>(
      env,
      `/marketplace/plugins/${pluginId}/rate`,
      { method: 'POST', body: JSON.stringify({ organizationId, rating, review }) },
      securityToken,
    ),

  rateSkill: (
    env: Env,
    skillId: string,
    organizationId: string,
    rating: number,
    review?: string,
    securityToken?: string | null,
  ) =>
    marketplaceRequest<{ skillId: string; organizationId: string; rating: number; review: string | null }>(
      env,
      `/marketplace/skills/${skillId}/rate`,
      { method: 'POST', body: JSON.stringify({ organizationId, rating, review }) },
      securityToken,
    ),

  submitPlugin: (env: Env, input: SubmitPluginInput, securityToken?: string | null) =>
    marketplaceRequest<{ pluginId: string; versionId: string }>(
      env,
      '/publisher/plugins',
      { method: 'POST', body: JSON.stringify(input) },
      securityToken,
    ),

  listPublisherPlugins: (env: Env, publisherSlug: string, securityToken?: string | null) =>
    marketplaceRequest<{ plugins: PublisherPluginSummary[]; total: number }>(
      env,
      `/publisher/plugins?publisherSlug=${encodeURIComponent(publisherSlug)}`,
      undefined,
      securityToken,
    ),

  submitSkill: (env: Env, input: SubmitSkillInput, securityToken?: string | null) =>
    marketplaceRequest<{ skillId: string }>(
      env,
      '/publisher/skills',
      { method: 'POST', body: JSON.stringify(input) },
      securityToken,
    ),

  listPublisherSkills: (env: Env, publisherSlug: string, securityToken?: string | null) =>
    marketplaceRequest<{ skills: PublisherSkillSummary[]; total: number }>(
      env,
      `/publisher/skills?publisherSlug=${encodeURIComponent(publisherSlug)}`,
      undefined,
      securityToken,
    ),
};
