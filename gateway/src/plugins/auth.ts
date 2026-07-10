import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { PermissionDeniedError, ValidationError } from '@o2n/governance';
import type { UserRole } from '@o2n/shared';
import type { PermissionService } from '../services/permission-service.js';

export interface AuthContext {
  userId: string;
  organizationId: string;
  role: UserRole;
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
  role: UserRole;
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
]);

export function registerAuth(app: FastifyInstance, jwtSecret: string, permissionService: PermissionService): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    request.traceId = randomUUID();
    void reply.header('X-Trace-Id', request.traceId);

    if (PUBLIC_ROUTES.has(request.routeOptions?.url ?? request.url)) {
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new ValidationError('Missing Authorization: Bearer <token> header');
    }

    const orgHeader = request.headers['x-organization-id'];
    if (typeof orgHeader !== 'string' || orgHeader.length === 0) {
      throw new ValidationError('Missing X-Organization-Id header');
    }

    let claims: AccessTokenClaims;
    try {
      claims = jwt.verify(authHeader.slice('Bearer '.length), jwtSecret) as AccessTokenClaims;
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
