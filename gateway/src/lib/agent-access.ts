import type { FastifyRequest } from 'fastify';
import { NotFoundError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { AgentAccessService } from '../services/agent-access-service.js';

/**
 * RT-024 — gates every agent-specific action (not just the CRUD routes) on
 * agent_access_bindings, not just the role-level agents:* permission. admin
 * bypasses entirely — role permissions alone (agents:update, agents:chat,
 * ...) are no longer sufficient for a non-admin to touch a *specific*
 * agent they haven't been granted. 404s rather than 403s on denial, same as
 * a wrong-org agent id, so this can't be used to probe which agent ids
 * exist in the org.
 */
export async function requireAgentAccessible(ctx: AppContext, request: FastifyRequest, agentId: string): Promise<void> {
  if (request.auth.role === 'admin') return;
  const hasAccess = await new AgentAccessService(ctx.db).hasAccess(agentId, request.auth.userId);
  if (!hasAccess) throw new NotFoundError('Agent', agentId);
}
