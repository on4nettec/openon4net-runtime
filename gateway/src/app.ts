import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { AppContext } from './context.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerAuth } from './plugins/auth.js';
import { httpRequestDurationSeconds, httpRequestsTotal } from './observability/metrics.js';
import { registerHealthRoute } from './routes/health.js';
import { registerMetricsRoute } from './routes/metrics.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerAuthMethods } from './auth/registry.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerToolRoutes } from './routes/tools.js';
import { registerRoleRoutes } from './routes/roles.js';
import { registerUserRoutes } from './routes/users.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerPolicyRoutes } from './routes/policies.js';
import { registerSkillRoutes } from './routes/skills.js';
import { registerSkillProposalRoutes } from './routes/skill-proposals.js';
import { registerMarketplaceRoutes } from './routes/marketplace.js';
import { registerOrganizationRoutes } from './routes/organizations.js';
import { registerInvitationRoutes } from './routes/invitations.js';
import { registerAuthInvitationRoutes } from './routes/auth-invitations.js';
import { registerWalletRoutes } from './routes/wallet.js';

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions?.url ?? request.url;
    const labels = { method: request.method, route, status_code: String(reply.statusCode) };
    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, reply.elapsedTime / 1000);
  });

  registerErrorHandler(app);
  registerHealthRoute(app);
  registerMetricsRoute(app);
  registerAuth(app, ctx.env.JWT_SECRET, ctx.permissionService);
  registerAuthMethods(app, ctx);
  registerAgentRoutes(app, ctx);
  registerMemoryRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  registerApprovalRoutes(app, ctx);
  registerToolRoutes(app, ctx);
  registerRoleRoutes(app, ctx);
  registerUserRoutes(app, ctx);
  registerAuditRoutes(app, ctx);
  registerWorkspaceRoutes(app, ctx);
  registerPolicyRoutes(app, ctx);
  registerSkillRoutes(app, ctx);
  registerSkillProposalRoutes(app, ctx);
  registerMarketplaceRoutes(app, ctx);
  registerOrganizationRoutes(app, ctx);
  registerInvitationRoutes(app, ctx);
  registerAuthInvitationRoutes(app, ctx);
  registerWalletRoutes(app, ctx);

  return app;
}
