import type { FastifyInstance } from 'fastify';
import { OrganizationUpdateSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { OrgService } from '../services/org-service.js';

/** No :id in these routes — a session belongs to exactly one organization (request.auth.organizationId). */
export function registerOrganizationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const orgService = new OrgService(ctx.db);

  app.get('/v1/organization', async (request) => {
    requirePermission(request, 'organization:read');
    return orgService.getById(request.auth.organizationId);
  });

  app.patch('/v1/organization', async (request) => {
    requirePermission(request, 'organization:write');
    const parsed = OrganizationUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid organization payload', parsed.error.flatten());

    return orgService.update(request.auth.organizationId, parsed.data);
  });
}
