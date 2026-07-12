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
  createdAt: string;
}

export interface MarketplaceSkillSummary {
  skillId: string;
  slug: string;
  name: string;
  description: string | null;
  priceCents: number;
  publisherSlug: string;
  createdAt: string;
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
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Marketplace request failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

/** Thin fetch-wrapper over apps/openon4net-marketplace's HTTP API — a separate service/repo, not a library import. */
export const marketplaceClient = {
  listPlugins: (env: Env) => marketplaceRequest<{ plugins: MarketplacePluginSummary[]; total: number }>(env, '/marketplace/plugins'),

  listSkills: (env: Env) => marketplaceRequest<{ skills: MarketplaceSkillSummary[]; total: number }>(env, '/marketplace/skills'),

  installPlugin: (env: Env, pluginId: string, organizationId: string) =>
    marketplaceRequest<Record<string, unknown>>(env, `/marketplace/plugins/${pluginId}/install`, {
      method: 'POST',
      body: JSON.stringify({ organizationId }),
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
};
