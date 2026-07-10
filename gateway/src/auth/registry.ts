import type { FastifyInstance } from 'fastify';
import type { AuthMethodsResponse } from '@o2n/shared';
import type { AppContext } from '../context.js';
import type { AuthProvider } from './types.js';
import { devApiKeyProvider } from './providers/dev-api-key.js';
import { passwordProvider } from './providers/password.js';
import { magicLinkProvider } from './providers/magic-link.js';
import { oauthProvider } from './providers/oauth.js';

const ALL_PROVIDERS: AuthProvider[] = [devApiKeyProvider, passwordProvider, magicLinkProvider, oauthProvider];

/**
 * RT-014 — Auth Method Registry (docs/spect/02_ARCHITECTURE/16-authentication-modes.md).
 * env.ts's superRefine already rejected an invalid/unsafe AUTH_METHODS_ENABLED
 * at startup, so by the time this runs, ctx.env.authMethods is trustworthy —
 * this function just registers each enabled provider's routes and adds the
 * one discovery route the design doc's "multi-active login UI" needs.
 */
export function registerAuthMethods(app: FastifyInstance, ctx: AppContext): void {
  for (const provider of ALL_PROVIDERS) {
    if (ctx.env.authMethods.includes(provider.name)) {
      provider.register(app, ctx);
    }
  }

  app.get('/v1/auth/methods', async () => {
    const response: AuthMethodsResponse = {
      enabled: [...ctx.env.authMethods],
      ...(ctx.env.AUTH_METHODS_DEFAULT ? { default: ctx.env.AUTH_METHODS_DEFAULT as AuthMethodsResponse['default'] } : {}),
      ...(ctx.env.authMethods.includes('oauth') ? { oauthProviders: [...ctx.env.oauthProviders] } : {}),
    };
    return response;
  });
}
