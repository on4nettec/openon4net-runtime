import jwt from 'jsonwebtoken';
import type { FastifyRequest } from 'fastify';
import type { AuthMethod, AuthTokenResponse } from '@o2n/shared';
import type { AppContext } from '../context.js';
import { AuditService } from '../services/audit-service.js';

interface SessionOrg {
  id: string;
  name: string;
}
interface SessionWorkspace {
  id: string;
}
interface SessionUser {
  id: string;
  role: string;
}

/**
 * The one place a JWT gets signed, so every auth provider (dev_api_key,
 * password, magic_link, oauth) produces byte-identical session shape and
 * expiry — the design doc's "خروجی همه روش‌ها یکسان باشد" requirement.
 */
export function issueSession(
  ctx: AppContext,
  organization: SessionOrg,
  workspace: SessionWorkspace,
  user: SessionUser,
): AuthTokenResponse {
  const token = jwt.sign({ sub: user.id, organizationId: organization.id, role: user.role }, ctx.env.JWT_SECRET, {
    expiresIn: '24h',
  });
  return {
    token,
    organizationId: organization.id,
    organizationName: organization.name,
    workspaceId: workspace.id,
    userId: user.id,
    role: user.role,
  };
}

/**
 * §7 of the design doc: every login (success or failure) should record
 * auth_method + user/org/ip/user-agent. Skipped entirely when the
 * organization itself couldn't be resolved (unknown slug) — there is no
 * meaningful org to scope the row to, and logging one anyway would let the
 * audit log double as an org-existence oracle.
 */
export async function logLoginAudit(
  ctx: AppContext,
  request: FastifyRequest,
  input: {
    organizationId: string;
    userId: string | null;
    authMethod: AuthMethod;
    status: 'success' | 'failed';
    reason?: string;
  },
): Promise<void> {
  const auditService = new AuditService(ctx.db);
  await auditService.logAction({
    organizationId: input.organizationId,
    userId: input.userId,
    actionType: 'user-login',
    actionData: { authMethod: input.authMethod, ...(input.reason ? { reason: input.reason } : {}) },
    status: input.status === 'success' ? 'success' : 'failed',
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  });
}
