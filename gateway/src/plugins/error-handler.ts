import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { O2NError } from '@o2n/governance';
import type { ErrorEnvelope } from '@o2n/shared';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: Error, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof O2NError) {
      const envelope: ErrorEnvelope = {
        error: { code: error.code, message: error.message, details: error.details },
      };
      void reply.status(error.statusCode).send(envelope);
      return;
    }

    request.log.error({ err: error }, 'Unhandled error');
    const envelope: ErrorEnvelope = {
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
    };
    void reply.status(500).send(envelope);
  });
}
