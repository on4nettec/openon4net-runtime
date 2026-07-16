import { NotFoundError, O2NError, PermissionDeniedError, ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { marketplaceClient } from './marketplace-client.js';
import { PluginGrantService } from './plugin-grant-service.js';
import { PluginSchemaService } from './plugin-schema-service.js';
import { invokePluginProvider, type PluginProviderResult } from '../connectors/plugin-provider-connector.js';

/**
 * RT-079 — the dispatch point for a Workflow `plugin` step. Three checks,
 * in order: (1) the plugin exists in Marketplace, (2) the invoking agent
 * has been granted access to it (RT-080's agent_plugin_grants — the first
 * real enforcement point for that grant, previously CRUD-only), (3) the
 * plugin actually declares itself as an HTTP-provider (the only kind of
 * Plugin Runtime can execute today — see plugin-provider-connector.ts).
 *
 * RT-076: since the provider is a stateless external HTTP endpoint (not
 * in-process code Runtime could hand a live memory object to), persistence
 * is threaded through the request/response body itself instead of a
 * callback API: prior state for this (org, plugin) pair is attached as
 * `_state` before the call, and if the provider's JSON response includes
 * its own `_state` object, that's persisted back — into a schema isolated
 * per (organizationId, pluginId), never a shared table (PluginSchemaService).
 */
export async function executePluginStep(
  ctx: AppContext,
  organizationId: string,
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

  const schemaService = new PluginSchemaService(ctx.db);
  const priorState = await schemaService.readAll(organizationId, pluginId);

  const result = await invokePluginProvider(provider.baseUrl, { ...params, _state: priorState });

  const returnedState = (result.body as { _state?: unknown } | null)?._state;
  if (returnedState && typeof returnedState === 'object') {
    await schemaService.writeAll(organizationId, pluginId, returnedState as Record<string, unknown>);
  }

  return result;
}
