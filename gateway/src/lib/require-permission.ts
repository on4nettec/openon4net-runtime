import type { FastifyRequest } from 'fastify';
import { PermissionDeniedError, hasPermission } from '@o2n/governance';

/** Checks against request.auth.permissions, resolved once per request from the DB in plugins/auth.ts. */
export function requirePermission(request: FastifyRequest, permission: string): void {
  if (!hasPermission(request.auth.permissions, permission)) {
    throw new PermissionDeniedError(permission);
  }
}
