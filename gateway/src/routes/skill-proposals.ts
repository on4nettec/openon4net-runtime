import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { requirePermission } from '../lib/require-permission.js';
import { SkillProposalService } from '../services/skill-proposal-service.js';
import { SkillService } from '../services/skill-service.js';
import { AuditService } from '../services/audit-service.js';

export function registerSkillProposalRoutes(app: FastifyInstance, ctx: AppContext): void {
  const skillProposalService = new SkillProposalService(ctx.db);

  app.get('/v1/skill-proposals', async (request) => {
    requirePermission(request, 'skill-proposals:read');
    return skillProposalService.listPending(request.auth.organizationId);
  });

  app.post<{ Params: { id: string } }>('/v1/skill-proposals/:id/approve', async (request) => {
    requirePermission(request, 'skill-proposals:approve');
    const proposal = await skillProposalService.getPendingById(request.auth.organizationId, request.params.id);

    return withTransaction(ctx.db, async (client) => {
      const skill = await new SkillService(client).create(
        request.auth.organizationId,
        {
          agentId: proposal.agentId,
          name: `Auto-detected: ${proposal.patternMetadata.actionType ?? 'skill'}`,
          definition: proposal.proposedDefinition,
        },
        'auto',
      );
      await new SkillProposalService(client).resolve(request.auth.organizationId, proposal.id, 'approved', request.auth.userId);
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: proposal.agentId,
        userId: request.auth.userId,
        actionType: 'skill-proposal-approve',
        actionData: { traceId: request.traceId, proposalId: proposal.id, skillId: skill.id },
      });
      return skill;
    });
  });

  app.post<{ Params: { id: string } }>('/v1/skill-proposals/:id/reject', async (request) => {
    requirePermission(request, 'skill-proposals:approve');
    const proposal = await skillProposalService.getPendingById(request.auth.organizationId, request.params.id);

    await withTransaction(ctx.db, async (client) => {
      await new SkillProposalService(client).resolve(request.auth.organizationId, proposal.id, 'rejected', request.auth.userId);
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: proposal.agentId,
        userId: request.auth.userId,
        actionType: 'skill-proposal-reject',
        actionData: { traceId: request.traceId, proposalId: proposal.id },
      });
    });

    return { status: 'rejected', proposalId: proposal.id };
  });
}
