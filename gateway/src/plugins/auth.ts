import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { PermissionDeniedError, ValidationError } from '@o2n/governance';
import type { PermissionService } from '../services/permission-service.js';

export interface AuthContext {
  userId: string;
  organizationId: string;
  role: string;
  /** Resolved once per request from the DB (migrations/0007_rbac.sql) — see lib/require-permission.ts. */
  permissions: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
    traceId: string;
  }
}

interface AccessTokenClaims {
  sub: string;
  organizationId: string;
  role: string;
}

// RT-014..018: every login entrypoint across all auth providers is
// unauthenticated by definition (that's the point) — /v1/auth/password/set
// is deliberately NOT here, since changing your own password requires an
// existing session (see auth/providers/password.ts).
const PUBLIC_ROUTES = new Set([
  '/health',
  '/metrics',
  '/v1/auth/methods',
  '/v1/auth/token',
  '/v1/auth/password/login',
  '/v1/auth/magic-link/request',
  '/v1/auth/magic-link/verify',
  '/v1/auth/oauth/:provider/start',
  '/v1/auth/oauth/:provider/callback',
  '/v1/auth/invitations/:token/accept',
  // RT-065: inbound webhook — the unguessable token in the path is itself
  // the auth, same trust model as the invitation-accept route above.
  '/v1/webhooks/:token',
  // RT-068/069: enterprise SSO login entrypoints — unauthenticated by
  // definition, same as every other auth provider's start/callback routes.
  '/v1/auth/oidc/start',
  '/v1/auth/oidc/callback',
  '/v1/auth/saml/start',
  '/v1/auth/saml/acs',
  // RT-083: the first-login language picker needs UI strings before a
  // session exists (same reasoning as /v1/auth/methods above).
  '/v1/locales/:lang',
]);

export function registerAuth(app: FastifyInstance, jwtSecret: string, permissionService: PermissionService): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    request.traceId = randomUUID();
    void reply.header('X-Trace-Id', request.traceId);

    if (PUBLIC_ROUTES.has(request.routeOptions?.url ?? request.url)) {
      return;
    }
    // RT-074: Swagger UI registers a whole sub-tree of routes (static
    // assets, /docs/json, /docs/yaml, ...) under routePrefix — a prefix
    // check instead of enumerating every one of them in PUBLIC_ROUTES,
    // same reasoning as the token-in-path routes above: public API docs
    // are meant to be browsable without a session.
    if (request.url === '/docs' || request.url.startsWith('/docs/')) {
      return;
    }

    // RT-090: a browser's native WebSocket constructor can't set custom
    // request headers, so the chat WS handshake (routes/chat.ts) carries the
    // same bearer token/org id as query params instead. Restricted to actual
    // upgrade requests so a normal REST call can't sidestep header auth by
    // passing credentials in the URL (which would land in access logs).
    const isWsUpgrade = request.headers.upgrade?.toLowerCase() === 'websocket';
    const query = request.query as Record<string, unknown>;

    const rawToken = isWsUpgrade && typeof query.token === 'string' ? query.token : undefined;
    const authHeader = request.headers.authorization;
    const token = rawToken ?? (authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined);
    if (!token) {
      throw new ValidationError('Missing Authorization: Bearer <token> header');
    }

    const orgHeader =
      rawToken !== undefined && typeof query.organizationId === 'string'
        ? query.organizationId
        : request.headers['x-organization-id'];
    if (typeof orgHeader !== 'string' || orgHeader.length === 0) {
      throw new ValidationError('Missing X-Organization-Id header');
    }

    let claims: AccessTokenClaims;
    try {
      claims = jwt.verify(token, jwtSecret) as AccessTokenClaims;
    } catch {
      throw new ValidationError('Invalid or expired token');
    }

    if (claims.organizationId !== orgHeader) {
      throw new PermissionDeniedError('organization-scope');
    }

    const permissions = await permissionService.getPermissions(claims.sub);
    request.auth = { userId: claims.sub, organizationId: claims.organizationId, role: claims.role, permissions };
  });
}
