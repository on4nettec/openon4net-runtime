import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FeatureNotAvailableError, ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { requireAgentAccessible } from '../lib/agent-access.js';
import { AgentService } from '../services/agent-service.js';
import { AuditService } from '../services/audit-service.js';
import { executePluginStep } from '../services/plugin-invoker.js';
import { hasFeature, MANAGED_AI_GATEWAY_FEATURE, PROGRAMMER_AGENT_ROLE } from '../services/license-service.js';

const ExecuteBody = z.object({
  params: z.record(z.unknown()).default({}),
});

/**
 * RT-078 — direct Plugin execution outside of a Workflow context (RT-079's
 * executePluginStep so far was only reachable from WorkflowExecutor).
 * Scoped specifically to the Programmer Agent role: per
 * 02_ARCHITECTURE/02-ai-gateway.md §1.2, "ایجنت برنامه‌نویس فقط با AI
 * Gateway واقعی قابل‌استفاده است" — a plugin a Programmer Agent produces
 * needs a way to actually run without first being wrapped in a Workflow,
 * but only once the org's plan proves it (CP-012's managedAiGateway flag).
 * Reuses plugin-invoker.ts's exact grant-check/invoke/state-persist logic —
 * this route only adds the license gate and its own audit trail on top.
 */
export function registerPluginExecuteRoutes(app: FastifyInstance, ctx: AppContext): void {
  const agentService = new AgentService(ctx.db);

  app.post<{ Params: { agentId: string; pluginId: string } }>(
    '/v1/agents/:agentId/plugins/:pluginId/execute',
    async (request) => {
      requirePermission(request, 'plugins:execute');
      await requireAgentAccessible(ctx, request, request.params.agentId);

      const parsed = ExecuteBody.safeParse(request.body);
      if (!parsed.success) throw new ValidationError('Invalid execute payload', parsed.error.flatten());

      const agent = await agentService.getById(request.auth.organizationId, request.params.agentId);
      if (agent.role !== PROGRAMMER_AGENT_ROLE) {
        throw new ValidationError(
          `Direct plugin execution is only available to agents with the "${PROGRAMMER_AGENT_ROLE}" role`,
        );
      }
      if (!hasFeature(ctx.activationState, MANAGED_AI_GATEWAY_FEATURE)) {
        await new AuditService(ctx.db).logAction({
          organizationId: request.auth.organizationId,
          agentId: agent.id,
          userId: request.auth.userId,
          actionType: 'plugin-direct-execute-denied-no-license',
          actionData: { traceId: request.traceId, pluginId: request.params.pluginId, feature: MANAGED_AI_GATEWAY_FEATURE },
          status: 'failed',
        });
        throw new FeatureNotAvailableError('Direct Plugin execution (requires Managed AI Gateway)');
      }

      try {
        const result = await executePluginStep(
          ctx,
          request.auth.organizationId,
          agent.id,
          request.params.pluginId,
          parsed.data.params,
        );
        await new AuditService(ctx.db).logAction({
          organizationId: request.auth.organizationId,
          agentId: agent.id,
          userId: request.auth.userId,
          actionType: 'plugin-direct-execute',
          actionData: { traceId: request.traceId, pluginId: request.params.pluginId },
        });
        return result;
      } catch (err) {
        await new AuditService(ctx.db).logAction({
          organizationId: request.auth.organizationId,
          agentId: agent.id,
          userId: request.auth.userId,
          actionType: 'plugin-direct-execute',
          actionData: { traceId: request.traceId, pluginId: request.params.pluginId },
          status: 'failed',
        });
        throw err;
      }
    },
  );
}
