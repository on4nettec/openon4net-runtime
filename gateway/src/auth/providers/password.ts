import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { PasswordLoginRequestSchema, PasswordSetRequestSchema } from '@o2n/shared';
import { RateLimitedError, ValidationError } from '@o2n/governance';
import type { AppContext } from '../../context.js';
import { OrgService } from '../../services/org-service.js';
import { UserService } from '../../services/user-service.js';
import type { AuthProvider } from '../types.js';
import { issueSession, logLoginAudit } from '../session.js';

const LOCKOUT_MAX_ATTEMPTS = 5;
const LOCKOUT_WINDOW_SECONDS = 900; // 15 minutes

/** Same "don't reveal which part was wrong" message for org/user/password mismatches — avoids user/org enumeration. */
const INVALID_CREDENTIALS = 'Invalid email or password';

export const passwordProvider: AuthProvider = {
  name: 'password',
  register(app: FastifyInstance, ctx: AppContext): void {
    const orgService = new OrgService(ctx.db);
    const userService = new UserService(ctx.db);

    app.post('/v1/auth/password/login', async (request) => {
      const parsed = PasswordLoginRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError('Invalid login payload', parsed.error.flatten());
      const { organizationSlug, email, password } = parsed.data;

      const lockKey = `login_fail:${organizationSlug}:${email}`;
      const attempts = await ctx.redis.get(lockKey);
      if (attempts && Number(attempts) >= LOCKOUT_MAX_ATTEMPTS) {
        throw new RateLimitedError(`login:${organizationSlug}:${email}`);
      }

      const orgAndWorkspace = await orgService.findOrgAndWorkspaceBySlug(organizationSlug);
      if (!orgAndWorkspace) {
        throw new ValidationError(INVALID_CREDENTIALS);
      }
      const { organization, workspace } = orgAndWorkspace;

      const authRecord = await userService.findAuthRecordByEmail(organization.id, email);
      const passwordOk =
        authRecord?.passwordHash && authRecord.isActive
          ? await argon2Verify(authRecord.passwordHash, password)
          : false;

      if (!authRecord || !authRecord.isActive || !authRecord.passwordHash || !passwordOk) {
        await recordFailure(ctx, lockKey);
        await logLoginAudit(ctx, request, {
          organizationId: organization.id,
          userId: authRecord?.id ?? null,
          authMethod: 'password',
          status: 'failed',
          reason: !authRecord ? 'no_such_user' : !authRecord.isActive ? 'deactivated' : 'wrong_password',
        });
        throw new ValidationError(INVALID_CREDENTIALS);
      }

      await ctx.redis.del(lockKey);
      const session = issueSession(ctx, organization, workspace, { id: authRecord.id, role: authRecord.role });
      await logLoginAudit(ctx, request, {
        organizationId: organization.id,
        userId: authRecord.id,
        authMethod: 'password',
        status: 'success',
      });
      return session;
    });

    // Self-service set/change password — requires an existing session from
    // ANY enabled method (not just password), so e.g. a dev_api_key or
    // magic_link user can opt into password login. See registerAuth's
    // onRequest hook for how request.auth gets populated; this route is
    // intentionally NOT in PUBLIC_ROUTES.
    app.post('/v1/auth/password/set', async (request) => {
      const parsed = PasswordSetRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError('Invalid payload', parsed.error.flatten());
      if (parsed.data.password.length < ctx.env.PASSWORD_MIN_LENGTH) {
        throw new ValidationError(`Password must be at least ${ctx.env.PASSWORD_MIN_LENGTH} characters`);
      }

      const passwordHash = await argon2Hash(parsed.data.password);
      await userService.setPasswordHash(request.auth.userId, passwordHash);
      return { ok: true };
    });
  },
};

async function recordFailure(ctx: AppContext, lockKey: string): Promise<void> {
  const count = await ctx.redis.incr(lockKey);
  if (count === 1) {
    await ctx.redis.expire(lockKey, LOCKOUT_WINDOW_SECONDS);
  }
}
