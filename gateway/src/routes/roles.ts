import type { FastifyInstance } from 'fastify';
import { RolePermissionsUpdateSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';

/**
 * DB-backed RBAC management (migrations/0007_rbac.sql). Custom role
 * creation/deletion and workspace-scoped assignment UI are not implemented
 * in this pass — only editing an existing (system-seeded) role's
 * permissions, which is what makes the DB-backed model actually different
 * from the old hardcoded map: an admin can now change what "editor" can do
 * without a code deploy.
 */
export function registerRoleRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/roles', async (request) => {
    requirePermission(request, 'roles:read');
    return ctx.permissionService.listRoles(request.auth.organizationId);
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
