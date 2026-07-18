import type { FastifyInstance } from 'fastify';
import { SkillPackageCreateSchema, SkillPackageUpdateSchema, SkillPackageImportSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { requirePermission } from '../lib/require-permission.js';
import { requireAgentAccessible } from '../lib/agent-access.js';
import { SkillPackageService } from '../services/skill-package-service.js';
import { SkillPackageGrantService } from '../services/skill-package-grant-service.js';
import { AuditService } from '../services/audit-service.js';

/**
 * RT-087 — Agent Skills open standard (agentskills.io), v1 instructions-only
 * scope. Mirrors routes/skills.ts's shape closely (same permission prefix,
 * same grant/list conventions) — this is an additive sibling to the
 * existing JSON-steps Skill system, not a replacement, so both route files
 * coexist. Permission strings use the `skills:` prefix deliberately (e.g.
 * `skills:package-create`) so they're covered by the admin role's existing
 * `skills:*` wildcard without any RBAC seed migration.
 */
export function registerSkillPackageRoutes(app: FastifyInstance, ctx: AppContext): void {
  const skillPackageService = new SkillPackageService(ctx.db);
  const skillPackageGrantService = new SkillPackageGrantService(ctx.db);

  app.post('/v1/skill-packages', async (request) => {
    requirePermission(request, 'skills:package-create');
    const parsed = SkillPackageCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid skill package payload', parsed.error.flatten());
    if (parsed.data.agentId) await requireAgentAccessible(ctx, request, parsed.data.agentId);

    return withTransaction(ctx.db, async (client) => {
      const pkg = await new SkillPackageService(client).create(request.auth.organizationId, parsed.data);
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: pkg.agentId,
        userId: request.auth.userId,
        actionType: 'skill-package-create',
        actionData: { traceId: request.traceId, name: pkg.name },
      });
      return pkg;
    });
  });

  // Imports a raw SKILL.md file's text (frontmatter + body) — the open
  // standard's actual interop format, e.g. for a community skill downloaded
  // from agentskills.io, rather than filling the structured form fields.
  app.post('/v1/skill-packages/import', async (request) => {
    requirePermission(request, 'skills:package-create');
    const parsed = SkillPackageImportSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid skill package import payload', parsed.error.flatten());
    if (parsed.data.agentId) await requireAgentAccessible(ctx, request, parsed.data.agentId);

    return withTransaction(ctx.db, async (client) => {
      const pkg = await new SkillPackageService(client).importFromMarkdown(
        request.auth.organizationId,
        parsed.data.agentId,
        parsed.data.markdown,
      );
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: pkg.agentId,
        userId: request.auth.userId,
        actionType: 'skill-package-import',
        actionData: { traceId: request.traceId, name: pkg.name },
      });
      return pkg;
    });
  });

  app.get('/v1/skill-packages', async (request) => {
    requirePermission(request, 'skills:package-read');
    return skillPackageService.list(request.auth.organizationId);
  });

  app.get<{ Params: { id: string } }>('/v1/skill-packages/:id', async (request) => {
    requirePermission(request, 'skills:package-read');
    return skillPackageService.getById(request.auth.organizationId, request.params.id);
  });

  app.patch<{ Params: { id: string } }>('/v1/skill-packages/:id', async (request) => {
    requirePermission(request, 'skills:package-update');
    const parsed = SkillPackageUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid skill package payload', parsed.error.flatten());

    return withTransaction(ctx.db, async (client) => {
      const pkg = await new SkillPackageService(client).update(request.auth.organizationId, request.params.id, parsed.data);
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: pkg.agentId,
        userId: request.auth.userId,
        actionType: 'skill-package-update',
        actionData: { traceId: request.traceId, changes: parsed.data },
      });
      return pkg;
    });
  });

  app.delete<{ Params: { id: string } }>('/v1/skill-packages/:id', async (request, reply) => {
    requirePermission(request, 'skills:package-delete');
    const pkg = await skillPackageService.getById(request.auth.organizationId, request.params.id);
    await withTransaction(ctx.db, async (client) => {
      await new SkillPackageService(client).delete(request.auth.organizationId, request.params.id);
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: pkg.agentId,
        userId: request.auth.userId,
        actionType: 'skill-package-delete',
        actionData: { traceId: request.traceId },
      });
    });
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string; packageId: string } }>('/v1/agents/:id/skill-packages/:packageId/grant', async (request) => {
    requirePermission(request, 'skills:package-grant');
    await requireAgentAccessible(ctx, request, request.params.id);
    await skillPackageService.getById(request.auth.organizationId, request.params.packageId); // org-scope check, 404s otherwise

    return withTransaction(ctx.db, async (client) => {
      const grant = await new SkillPackageGrantService(client).grant(
        request.params.id,
        request.params.packageId,
        request.auth.userId,
      );
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: request.params.id,
        userId: request.auth.userId,
        actionType: 'skill-package-grant',
        actionData: { traceId: request.traceId, skillPackageId: request.params.packageId },
      });
      return grant;
    });
  });

  app.delete<{ Params: { id: string; packageId: string } }>(
    '/v1/agents/:id/skill-packages/:packageId/grant',
    async (request, reply) => {
      requirePermission(request, 'skills:package-grant');
      await requireAgentAccessible(ctx, request, request.params.id);

      await withTransaction(ctx.db, async (client) => {
        await new SkillPackageGrantService(client).revoke(request.params.id, request.params.packageId);
        await new AuditService(client).logAction({
          organizationId: request.auth.organizationId,
          agentId: request.params.id,
          userId: request.auth.userId,
          actionType: 'skill-package-revoke',
          actionData: { traceId: request.traceId, skillPackageId: request.params.packageId },
        });
      });
      return reply.status(204).send();
    },
  );

  app.get<{ Params: { id: string } }>('/v1/agents/:id/skill-packages', async (request) => {
    requirePermission(request, 'skills:package-read');
    await requireAgentAccessible(ctx, request, request.params.id);
    return skillPackageGrantService.listForAgent(request.params.id);
  });
}
