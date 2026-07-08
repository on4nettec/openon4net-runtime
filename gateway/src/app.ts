import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { AppContext } from './context.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerAuth } from './plugins/auth.js';
import { registerHealthRoute } from './routes/health.js';

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });

  registerErrorHandler(app);
  registerHealthRoute(app);
  registerAuth(app, ctx.env.JWT_SECRET);

  return app;
}
