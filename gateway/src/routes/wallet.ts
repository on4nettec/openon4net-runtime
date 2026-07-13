import type { FastifyInstance } from 'fastify';
import { WalletCreditSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { WalletService } from '../services/wallet-service.js';

/** WalletService.credit()/debit() log their own audit_logs entries — routes here just validate/authorize and call through. */
export function registerWalletRoutes(app: FastifyInstance, ctx: AppContext): void {
  const walletService = new WalletService(ctx.db);

  app.get('/v1/wallet', async (request) => {
    requirePermission(request, 'billing:wallet:read');
    return (await walletService.find(request.auth.organizationId)) ?? {
      organizationId: request.auth.organizationId,
      workspaceId: null,
      ownerType: 'organization' as const,
      balanceCredits: 0,
      status: 'active' as const,
      initialized: false,
    };
  });

  app.post('/v1/wallet/credit', async (request) => {
    requirePermission(request, 'billing:wallet:credit');
    const parsed = WalletCreditSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid wallet credit payload', parsed.error.flatten());

    return walletService.credit(
      request.auth.organizationId,
      parsed.data.amountCredits,
      parsed.data.reason,
      request.auth.userId,
    );
  });
}
