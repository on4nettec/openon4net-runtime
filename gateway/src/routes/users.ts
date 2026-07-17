import type { FastifyInstance } from 'fastify';
import { UserCreateSchema, UserUpdateSchema, SelfLanguageUpdateSchema } from '@o2n/shared';
import { NotFoundError, ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { UserService } from '../services/user-service.js';

/**
 * Creates a named user and binds them to a role. Doesn't itself grant them
 * any way to sign in — that's a separate step per auth method (RT-014..018,
 * see auth/registry.ts): dev_api_key signs in as any known email with the
 * one shared org-wide key, while password/magic_link/oauth all require the
 * user to separately set a credential (auth/providers/password.ts's
 * `/v1/auth/password/set`, etc.) before they can use it.
 */
export function registerUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  const userService = new UserService(ctx.db);

  app.get('/v1/users', async (request) => {
    requirePermission(request, 'users:read');
    return userService.list(request.auth.organizationId);
  });

  // RT-083 — any signed-in user (no users:read needed, this is about
  // themselves). user.language === null is also the frontend's signal to
  // show the first-login language picker before continuing past login.
  app.get('/v1/users/me', async (request) => {
    const user = await userService.findById(request.auth.userId);
    if (!user) throw new NotFoundError('User', request.auth.userId);
    return user;
  });

  app.patch('/v1/users/me', async (request) => {
    const parsed = SelfLanguageUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid payload', parsed.error.flatten());
    return userService.updateOwnLanguage(request.auth.userId, parsed.data.language);
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
