import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { AppContext } from './context.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerAuth } from './plugins/auth.js';
import { registerHealthRoute } from './routes/health.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerConfigRoutes } from './routes/config.js';

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });

  registerErrorHandler(app);
  registerHealthRoute(app);
  registerAuth(app, ctx.env.JWT_SECRET);
  registerAuthRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerMemoryRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerConfigRoutes(app, ctx);

  return app;
}
