import type { FastifyInstance } from 'fastify';
import { InvitationAcceptSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { InvitationService } from '../services/invitation-service.js';
import { OrgService } from '../services/org-service.js';
import { issueSession, logLoginAudit } from '../auth/session.js';

/** Public (see plugins/auth.ts's PUBLIC_ROUTES) — the invitation token is the only credential, same trust model as magic-link's verify endpoint. */
export function registerAuthInvitationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const invitationService = new InvitationService(ctx.db);
  const orgService = new OrgService(ctx.db);

  app.post<{ Params: { token: string } }>('/v1/auth/invitations/:token/accept', async (request) => {
    const parsed = InvitationAcceptSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid payload', parsed.error.flatten());
    if (parsed.data.password.length < ctx.env.PASSWORD_MIN_LENGTH) {
      throw new ValidationError(`Password must be at least ${ctx.env.PASSWORD_MIN_LENGTH} characters`);
    }

    const result = await invitationService.accept(request.params.token, parsed.data);
    const organization = await orgService.getById(result.organizationId);

    const session = issueSession(
      ctx,
      { id: organization.id, name: organization.name },
      { id: result.workspaceId },
      { id: result.user.id, role: result.user.role },
    );
    await logLoginAudit(ctx, request, {
      organizationId: result.organizationId,
      userId: result.user.id,
      authMethod: 'password',
      status: 'success',
    });
    return session;
  });
}
