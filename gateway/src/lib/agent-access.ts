import type { FastifyRequest } from 'fastify';
import { NotFoundError, ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import type { Db } from '../db.js';
import { AgentAccessService } from '../services/agent-access-service.js';
import { OrgService } from '../services/org-service.js';

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

/**
 * RT-082 — a personal activation is capped at exactly one user (RT-081's
 * assertSeatAvailable), and that one user is always the org's bootstrap
 * admin (OrgService.createNew), so agent_access_bindings has no one else
 * to ever grant/revoke. Rather than leave the grant/revoke/list routes
 * technically reachable-but-pointless, they're disabled outright — matches
 * the UI side (agents/page.tsx), which hides the same routes' only caller.
 */
export async function assertAgentAccessFeatureEnabled(db: Db, organizationId: string): Promise<void> {
  const organization = await new OrgService(db).getById(organizationId);
  if (organization.activationType === 'personal') {
    throw new ValidationError('Agent Access is not available for personal activations — they support exactly one user');
  }
}
