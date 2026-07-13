import type { FastifyInstance } from 'fastify';
import { WorkspaceCreateSchema, WorkspaceUpdateSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { WorkspaceService } from '../services/workspace-service.js';

export function registerWorkspaceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const workspaceService = new WorkspaceService(ctx.db);

  app.get('/v1/workspaces', async (request) => {
    requirePermission(request, 'workspaces:read');
    const query = request.query as { includeArchived?: string };
    return workspaceService.list(request.auth.organizationId, { includeArchived: query.includeArchived === 'true' });
  });

  app.post('/v1/workspaces', async (request) => {
    requirePermission(request, 'workspaces:write');
    const parsed = WorkspaceCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid workspace payload', parsed.error.flatten());

    return workspaceService.create(request.auth.organizationId, parsed.data);
  });

  app.patch<{ Params: { id: string } }>('/v1/workspaces/:id', async (request) => {
    requirePermission(request, 'workspaces:write');
    const parsed = WorkspaceUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid workspace payload', parsed.error.flatten());

    return workspaceService.update(request.auth.organizationId, request.params.id, parsed.data);
  });

  app.post<{ Params: { id: string } }>('/v1/workspaces/:id/archive', async (request) => {
    requirePermission(request, 'workspaces:write');
    return workspaceService.archive(request.auth.organizationId, request.params.id);
  });
}
