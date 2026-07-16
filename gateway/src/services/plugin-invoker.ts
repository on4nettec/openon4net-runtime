import { NotFoundError, O2NError, PermissionDeniedError, ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { marketplaceClient } from './marketplace-client.js';
import { PluginGrantService } from './plugin-grant-service.js';
import { invokePluginProvider, type PluginProviderResult } from '../connectors/plugin-provider-connector.js';

/**
 * RT-079 — the dispatch point for a Workflow `plugin` step. Three checks,
 * in order: (1) the plugin exists in Marketplace, (2) the invoking agent
 * has been granted access to it (RT-080's agent_plugin_grants — the first
 * real enforcement point for that grant, previously CRUD-only), (3) the
 * plugin actually declares itself as an HTTP-provider (the only kind of
 * Plugin Runtime can execute today — see plugin-provider-connector.ts).
 */
export async function executePluginStep(
  ctx: AppContext,
  agentId: string,
  pluginId: string,
  params: Record<string, unknown>,
): Promise<PluginProviderResult> {
  if (!ctx.env.MARKETPLACE_SERVICE_URL) {
    throw new O2NError('VALIDATION_ERROR', 'Marketplace integration is not configured (MARKETPLACE_SERVICE_URL unset)', 501);
  }

  const plugin = await marketplaceClient.getPlugin(ctx.env, pluginId);
  if (!plugin) throw new NotFoundError('Plugin', pluginId);

  const hasGrant = await new PluginGrantService(ctx.db).hasGrant(agentId, pluginId);
  if (!hasGrant) throw new PermissionDeniedError(`plugin-grant:${pluginId}`);

  const provider = plugin.manifest?.provider;
  if (!provider || provider.type !== 'http' || !provider.baseUrl) {
    throw new ValidationError(`Plugin ${pluginId} does not declare an executable http provider in its manifest`);
  }

  return invokePluginProvider(provider.baseUrl, params);
}
