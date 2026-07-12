import type { FastifyInstance } from 'fastify';
import { SkillCreateSchema, SkillUpdateSchema, SkillExecuteSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { requirePermission } from '../lib/require-permission.js';
import { requireAgentAccessible } from '../lib/agent-access.js';
import { SkillService } from '../services/skill-service.js';
import { SkillGrantService } from '../services/skill-grant-service.js';
import { AuditService } from '../services/audit-service.js';
import { executeSkill } from '../services/skill-executor.js';

export function registerSkillRoutes(app: FastifyInstance, ctx: AppContext): void {
  const skillService = new SkillService(ctx.db);
  const skillGrantService = new SkillGrantService(ctx.db);

  app.post('/v1/skills', async (request) => {
    requirePermission(request, 'skills:create');
    const parsed = SkillCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid skill payload', parsed.error.flatten());
    await requireAgentAccessible(ctx, request, parsed.data.agentId);

    return withTransaction(ctx.db, async (client) => {
      const skill = await new SkillService(client).create(request.auth.organizationId, parsed.data, 'manual');
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: skill.agentId,
        userId: request.auth.userId,
        actionType: 'skill-create',
        actionData: { traceId: request.traceId, name: skill.name },
      });
      return skill;
    });
  });

  app.get('/v1/skills', async (request) => {
    requirePermission(request, 'skills:read');
    return skillService.list(request.auth.organizationId);
  });

  app.get<{ Params: { id: string } }>('/v1/skills/:id', async (request) => {
    requirePermission(request, 'skills:read');
    return skillService.getById(request.auth.organizationId, request.params.id);
  });

  app.patch<{ Params: { id: string } }>('/v1/skills/:id', async (request) => {
    requirePermission(request, 'skills:update');
    const parsed = SkillUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid skill payload', parsed.error.flatten());

    return withTransaction(ctx.db, async (client) => {
      const skill = await new SkillService(client).update(request.auth.organizationId, request.params.id, parsed.data);
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: skill.agentId,
        userId: request.auth.userId,
        actionType: 'skill-update',
        actionData: { traceId: request.traceId, changes: parsed.data },
      });
      return skill;
    });
  });

  app.delete<{ Params: { id: string } }>('/v1/skills/:id', async (request, reply) => {
    requirePermission(request, 'skills:delete');
    const skill = await skillService.getById(request.auth.organizationId, request.params.id);
    await withTransaction(ctx.db, async (client) => {
      await new SkillService(client).delete(request.auth.organizationId, request.params.id);
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: skill.agentId,
        userId: request.auth.userId,
        actionType: 'skill-delete',
        actionData: { traceId: request.traceId },
      });
    });
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string; skillId: string } }>('/v1/agents/:id/skills/:skillId/grant', async (request) => {
    requirePermission(request, 'skills:grant');
    await requireAgentAccessible(ctx, request, request.params.id);
    await skillService.getById(request.auth.organizationId, request.params.skillId); // org-scope check, 404s otherwise

    return withTransaction(ctx.db, async (client) => {
      const grant = await new SkillGrantService(client).grant(request.params.id, request.params.skillId, request.auth.userId);
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: request.params.id,
        userId: request.auth.userId,
        actionType: 'skill-grant',
        actionData: { traceId: request.traceId, skillId: request.params.skillId },
      });
      return grant;
    });
  });

  app.delete<{ Params: { id: string; skillId: string } }>('/v1/agents/:id/skills/:skillId/grant', async (request, reply) => {
    requirePermission(request, 'skills:grant');
    await requireAgentAccessible(ctx, request, request.params.id);

    await withTransaction(ctx.db, async (client) => {
      await new SkillGrantService(client).revoke(request.params.id, request.params.skillId);
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: request.params.id,
        userId: request.auth.userId,
        actionType: 'skill-revoke',
        actionData: { traceId: request.traceId, skillId: request.params.skillId },
      });
    });
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>('/v1/agents/:id/skills', async (request) => {
    requirePermission(request, 'skills:read');
    await requireAgentAccessible(ctx, request, request.params.id);
    return skillGrantService.listForAgent(request.params.id);
  });

  app.post<{ Params: { id: string; skillId: string } }>('/v1/agents/:id/skills/:skillId/execute', async (request) => {
    requirePermission(request, 'skills:execute');
    await requireAgentAccessible(ctx, request, request.params.id);
    const parsed = SkillExecuteSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid skill execute payload', parsed.error.flatten());

    const hasGrant = await skillGrantService.hasGrant(request.params.id, request.params.skillId);
    if (!hasGrant) throw new ValidationError('This agent has not been granted this skill');

    return executeSkill(ctx, request.auth.organizationId, request.params.id, request.params.skillId, parsed.data.params);
  });
}
