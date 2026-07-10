import type { FastifyInstance } from 'fastify';
import { UserCreateSchema, UserUpdateSchema } from '@o2n/shared';
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

  // Self-modification is blocked here rather than left to the honor system:
  // an admin changing their own role or deactivating themselves is almost
  // always a mistake (accidental self-lockout), and since it's blocked
  // unconditionally, whoever is acting always stays active - no separate
  // "last admin" check is needed.
  app.patch<{ Params: { id: string } }>('/v1/users/:id', async (request) => {
    requirePermission(request, 'users:write');
    if (request.params.id === request.auth.userId) {
      throw new ValidationError('Cannot change your own role or active status');
    }
    const parsed = UserUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid user payload', parsed.error.flatten());

    return userService.update(request.auth.organizationId, request.params.id, parsed.data);
  });

  app.delete<{ Params: { id: string } }>('/v1/users/:id', async (request, reply) => {
    requirePermission(request, 'users:write');
    if (request.params.id === request.auth.userId) {
      throw new ValidationError('Cannot deactivate your own account');
    }
    // Soft delete only (is_active=false) - audit_logs.user_id and
    // conversations.user_id are plain FK references with no ON DELETE
    // CASCADE, so a physical delete would fail once the user has any
    // history. Mirrors agents' soft-delete via status (routes/agents.ts).
    await userService.update(request.auth.organizationId, request.params.id, { isActive: false });
    return reply.status(204).send();
  });
}
