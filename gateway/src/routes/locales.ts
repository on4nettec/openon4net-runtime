import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { getLocale } from '../services/locale-service.js';

/**
 * RT-083 — public (no auth): the login/first-login language picker needs UI
 * strings before a session exists, same reasoning as Control Plane's
 * CP-028 GET /v1/locales/:lang.
 */
export function registerLocaleRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { lang: string } }>('/v1/locales/:lang', async (request) => {
    return getLocale(ctx.env, request.params.lang);
  });
}
