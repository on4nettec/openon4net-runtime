import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { PermissionDeniedError, ValidationError } from '@o2n/governance';
import type { UserRole } from '@o2n/shared';

export interface AuthContext {
  userId: string;
  organizationId: string;
  role: UserRole;
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

const PUBLIC_ROUTES = new Set(['/health', '/v1/auth/token']);

export function registerAuth(app: FastifyInstance, jwtSecret: string): void {
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

    request.auth = { userId: claims.sub, organizationId: claims.organizationId, role: claims.role };
  });
}
