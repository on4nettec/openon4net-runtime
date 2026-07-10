import type { FastifyInstance } from 'fastify';
import { AuthTokenRequestSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../../context.js';
import { OrgService } from '../../services/org-service.js';
import type { AuthProvider } from '../types.js';
import { issueSession, logLoginAudit } from '../session.js';

/**
 * RT-018 hardened version of the original Sprint-0-only dev auth: one
 * shared org-wide API key that also bootstraps an org/workspace/admin-user
 * on first use for a given slug (see services/org-service.ts for why it's
 * folded into login instead of a separate registration flow). Route stays
 * `/v1/auth/token` for backward compatibility with the existing dashboard
 * login page.
 *
 * The actual hardening (never reachable unless AUTH_ALLOW_DEV_METHODS=true
 * and NODE_ENV!=production) lives in env.ts's superRefine — this file just
 * assumes it already passed, since auth/registry.ts only registers this
 * provider when env.authMethods includes 'dev_api_key'.
 */
export const devApiKeyProvider: AuthProvider = {
  name: 'dev_api_key',
  register(app: FastifyInstance, ctx: AppContext): void {
    const orgService = new OrgService(ctx.db);

    app.post('/v1/auth/token', async (request) => {
      const parsed = AuthTokenRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError('Invalid login payload', parsed.error.flatten());

      if (parsed.data.apiKey !== ctx.env.DEV_API_KEY) {
        throw new ValidationError('Invalid API key');
      }

      const { organization, workspace, user } = await orgService.getOrCreateBootstrapped(
        parsed.data.organizationSlug,
        parsed.data.organizationName ?? parsed.data.organizationSlug,
        parsed.data.email,
      );

      const session = issueSession(ctx, organization, workspace, user);
      await logLoginAudit(ctx, request, {
        organizationId: organization.id,
        userId: user.id,
        authMethod: 'dev_api_key',
        status: 'success',
      });
      return session;
    });
  },
};
