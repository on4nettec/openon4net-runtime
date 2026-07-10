import type { FastifyInstance } from 'fastify';
import { PolicyCreateSchema, PolicyUpdateSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';

/**
 * ABAC Policy Layer (RT-008) admin management. Evaluated automatically
 * during chat's approval gate (see services/chat-service.ts) — this route
 * is just CRUD, no separate "test a policy" endpoint in this pass.
 */
export function registerPolicyRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/policies', async (request) => {
    requirePermission(request, 'policies:read');
    return ctx.policyService.list(request.auth.organizationId);
  });

  app.post('/v1/policies', async (request) => {
    requirePermission(request, 'policies:write');
    const parsed = PolicyCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid policy payload', parsed.error.flatten());

    return ctx.policyService.create(request.auth.organizationId, parsed.data.name, parsed.data.condition);
  });

  app.patch<{ Params: { id: string } }>('/v1/policies/:id', async (request) => {
    requirePermission(request, 'policies:write');
    const parsed = PolicyUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid policy payload', parsed.error.flatten());

    return ctx.policyService.setActive(request.auth.organizationId, request.params.id, parsed.data.isActive);
  });

  app.delete<{ Params: { id: string } }>('/v1/policies/:id', async (request, reply) => {
    requirePermission(request, 'policies:write');
    await ctx.policyService.delete(request.auth.organizationId, request.params.id);
    return reply.status(204).send();
  });
}
