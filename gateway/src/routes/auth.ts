import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { AuthTokenRequestSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { OrgService } from '../services/org-service.js';

/**
 * Sprint 0 has no real user registration/password flow (build pack §5:
 * "Auth: در MVP می‌تواند ساده باشد"). This single dev-mode endpoint both
 * logs in AND bootstraps an org/workspace/admin-user on first use for a
 * given organizationSlug — see services/org-service.ts for why.
 */
export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
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

    const token = jwt.sign(
      { sub: user.id, organizationId: organization.id, role: user.role },
      ctx.env.JWT_SECRET,
      { expiresIn: '24h' },
    );

    return {
      token,
      organizationId: organization.id,
      organizationName: organization.name,
      workspaceId: workspace.id,
      userId: user.id,
      role: user.role,
    };
  });
}
