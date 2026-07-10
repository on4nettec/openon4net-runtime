import type { FastifyInstance } from 'fastify';
import { UserCreateSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { UserService } from '../services/user-service.js';

/**
 * Sprint 0 auth is still one shared org-wide API key (routes/auth.ts) — this
 * doesn't add per-user passwords. It lets an admin create additional named
 * users and bind them to a role, so someone can sign in (with the same
 * shared key + their email, see AuthTokenRequestSchema) as a non-admin.
 */
export function registerUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  const userService = new UserService(ctx.db);

  app.get('/v1/users', async (request) => {
    requirePermission(request, 'users:read');
    return userService.list(request.auth.organizationId);
  });

  app.post('/v1/users', async (request) => {
    requirePermission(request, 'users:write');
    const parsed = UserCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid user payload', parsed.error.flatten());

    return userService.create(request.auth.organizationId, parsed.data);
  });
}
