import type { Env } from '../env.js';

export interface MarketplacePluginSummary {
  pluginId: string;
  packageName: string;
  name: string;
  description: string | null;
  publisherSlug: string;
  publisherVerified: boolean;
  latestVersion: string | null;
  manifest: { configSchema?: { key: string; label: string; type: string }[] } | null;
  /** Declared permissions of the latest approved version (MKT-020) — shown as a consent prompt before install. */
  permissions: string[];
  installCount: number;
  avgRating: number | null;
  ratingCount: number;
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

async function marketplaceRequest<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  if (!env.MARKETPLACE_SERVICE_URL) {
    throw new Error('MARKETPLACE_SERVICE_URL is not configured');
  }
  const headers = new Headers(init?.headers);
  if (env.MARKETPLACE_API_KEY) headers.set('Authorization', `Bearer ${env.MARKETPLACE_API_KEY}`);
  if (init?.body !== undefined) headers.set('Content-Type', 'application/json');

  const response = await fetch(`${env.MARKETPLACE_SERVICE_URL}${path}`, {
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
    throw new Error(body?.error?.message ?? `Marketplace request failed with status ${response.status}`);
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

  installPlugin: (env: Env, pluginId: string, organizationId: string, opts: InstallPluginOptions = {}) =>
    marketplaceRequest<Record<string, unknown>>(env, `/marketplace/plugins/${pluginId}/install`, {
      method: 'POST',
      body: JSON.stringify({
        organizationId,
        version: opts.version,
        acknowledgePermissionDiff: opts.acknowledgePermissionDiff,
      }),
    }),

  installSkill: (env: Env, skillId: string, organizationId: string) =>
    marketplaceRequest<InstallSkillResult>(env, `/marketplace/skills/${skillId}/install`, {
      method: 'POST',
      body: JSON.stringify({ organizationId }),
    }),

  updatePluginInstallConfig: (env: Env, installId: string, organizationId: string, config: Record<string, unknown>) =>
    marketplaceRequest<{ installId: string; config: Record<string, unknown> }>(env, `/marketplace/installs/${installId}/config`, {
      method: 'PATCH',
      body: JSON.stringify({ organizationId, config }),
    }),

  ratePlugin: (env: Env, pluginId: string, organizationId: string, rating: number, review?: string) =>
    marketplaceRequest<{ pluginId: string; organizationId: string; rating: number; review: string | null }>(
      env,
      `/marketplace/plugins/${pluginId}/rate`,
      { method: 'POST', body: JSON.stringify({ organizationId, rating, review }) },
    ),

  rateSkill: (env: Env, skillId: string, organizationId: string, rating: number, review?: string) =>
    marketplaceRequest<{ skillId: string; organizationId: string; rating: number; review: string | null }>(
      env,
      `/marketplace/skills/${skillId}/rate`,
      { method: 'POST', body: JSON.stringify({ organizationId, rating, review }) },
    ),

  submitPlugin: (env: Env, input: SubmitPluginInput) =>
    marketplaceRequest<{ pluginId: string; versionId: string }>(env, '/publisher/plugins', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  listPublisherPlugins: (env: Env, publisherSlug: string) =>
    marketplaceRequest<{ plugins: PublisherPluginSummary[]; total: number }>(
      env,
      `/publisher/plugins?publisherSlug=${encodeURIComponent(publisherSlug)}`,
    ),

  submitSkill: (env: Env, input: SubmitSkillInput) =>
    marketplaceRequest<{ skillId: string }>(env, '/publisher/skills', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  listPublisherSkills: (env: Env, publisherSlug: string) =>
    marketplaceRequest<{ skills: PublisherSkillSummary[]; total: number }>(
      env,
      `/publisher/skills?publisherSlug=${encodeURIComponent(publisherSlug)}`,
    ),
};
