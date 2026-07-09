import type { FastifyInstance } from 'fastify';
import { registry } from '../observability/metrics.js';

/** Unauthenticated by design (see PUBLIC_ROUTES in plugins/auth.ts) — Prometheus scrapers don't carry a JWT. */
export function registerMetricsRoute(app: FastifyInstance): void {
  app.get('/metrics', async (request, reply) => {
    void reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });
}
