import type { FastifyRequest } from 'fastify';
import { PermissionDeniedError, hasPermission } from '@o2n/governance';

export function requirePermission(request: FastifyRequest, permission: string): void {
  if (!hasPermission(request.auth.role, permission)) {
    throw new PermissionDeniedError(permission);
  }
}
