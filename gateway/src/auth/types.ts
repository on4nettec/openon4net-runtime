import type { FastifyInstance } from 'fastify';
import type { AuthMethod } from '@o2n/shared';
import type { AppContext } from '../context.js';

export interface AuthProvider {
  name: AuthMethod;
  /** Registers this provider's routes. Only called when ctx.env.authMethods includes `name` (see auth/registry.ts). */
  register(app: FastifyInstance, ctx: AppContext): void;
}
