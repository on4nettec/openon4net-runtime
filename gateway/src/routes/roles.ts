import type { FastifyInstance } from 'fastify';
import { RoleCreateSchema, RolePermissionsUpdateSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';

/**
 * DB-backed RBAC management (migrations/0007_rbac.sql). Custom roles
 * created here are assignable to users (not just the 4 system roles) and
 * bindable to any active workspace in the org, not just the first one — see
 * services/user-service.ts / role-workspace-resolver.ts (RT-040).
 */
export function registerRoleRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/roles', async (request) => {
    requirePermission(request, 'roles:read');
    return ctx.permissionService.listRoles(request.auth.organizationId);
  });

  app.post('/v1/roles', async (request) => {
    requirePermission(request, 'roles:write');
    const parsed = RoleCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid role payload', parsed.error.flatten());

    return ctx.permissionService.createRole(request.auth.organizationId, parsed.data.name);
  });

  app.delete<{ Params: { id: string } }>('/v1/roles/:id', async (request, reply) => {
    requirePermission(request, 'roles:write');
    await ctx.permissionService.deleteRole(request.auth.organizationId, request.params.id);
    return reply.status(204).send();
  });

  app.put<{ Params: { id: string } }>('/v1/roles/:id/permissions', async (request) => {
    requirePermission(request, 'roles:write');
    const parsed = RolePermissionsUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid role-permissions payload', parsed.error.flatten());

    return ctx.permissionService.setRolePermissions(
      request.auth.organizationId,
      request.params.id,
      parsed.data.permissions,
    );
  });
}
