import type { FastifyInstance } from 'fastify';
import nodemailer from 'nodemailer';
import { InvitationCreateSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { InvitationService } from '../services/invitation-service.js';
import { OrgService } from '../services/org-service.js';
import { AuditService } from '../services/audit-service.js';

export function registerInvitationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const invitationService = new InvitationService(ctx.db);
  const orgService = new OrgService(ctx.db);
  const auditService = new AuditService(ctx.db);
  const transport = nodemailer.createTransport({
    host: ctx.env.SMTP_HOST,
    port: ctx.env.SMTP_PORT,
    secure: ctx.env.SMTP_SECURE,
    auth: ctx.env.SMTP_USER ? { user: ctx.env.SMTP_USER, pass: ctx.env.SMTP_PASS } : undefined,
  });

  app.get('/v1/invitations', async (request) => {
    requirePermission(request, 'invitations:read');
    return invitationService.listPending(request.auth.organizationId);
  });

  app.post('/v1/invitations', async (request) => {
    requirePermission(request, 'invitations:create');
    const parsed = InvitationCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid invitation payload', parsed.error.flatten());

    const organization = await orgService.getById(request.auth.organizationId);
    const { invitation, token } = await invitationService.create(
      request.auth.organizationId,
      request.auth.userId,
      parsed.data,
    );

    const acceptLink = ctx.env.WEB_URL
      ? `${ctx.env.WEB_URL}/accept-invite?token=${token}`
      : null;
    await transport.sendMail({
      from: ctx.env.EMAIL_FROM,
      to: parsed.data.email,
      subject: `You've been invited to join ${organization.name} on Open on4net`,
      text: acceptLink
        ? `You've been invited to join ${organization.name}. Accept your invitation: ${acceptLink}`
        : `You've been invited to join ${organization.name}. Use this invitation token (valid for 7 days) at /accept-invite: ${token}`,
    });

    await auditService.logAction({
      organizationId: request.auth.organizationId,
      userId: request.auth.userId,
      actionType: 'invitation-create',
      actionData: { traceId: request.traceId, email: parsed.data.email, role: parsed.data.role },
    });

    return invitation;
  });

  app.delete<{ Params: { id: string } }>('/v1/invitations/:id', async (request, reply) => {
    requirePermission(request, 'invitations:revoke');
    await invitationService.revoke(request.auth.organizationId, request.params.id);
    await auditService.logAction({
      organizationId: request.auth.organizationId,
      userId: request.auth.userId,
      actionType: 'invitation-revoke',
      actionData: { traceId: request.traceId, invitationId: request.params.id },
    });
    return reply.status(204).send();
  });
}
