import type { FastifyInstance } from 'fastify';
import { AgentCreateSchema, AgentKpisUpdateSchema, AgentUpdateSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { requirePermission } from '../lib/require-permission.js';
import { requireAgentAccessible, assertAgentAccessFeatureEnabled } from '../lib/agent-access.js';
import { getRateLimitStatus } from '../plugins/rate-limiter.js';
import { AgentService } from '../services/agent-service.js';
import { AgentAccessService, assertValidAccessRole } from '../services/agent-access-service.js';
import { AuditService } from '../services/audit-service.js';
import { MemoryService } from '../services/memory-service.js';
import { WorkspaceService } from '../services/workspace-service.js';
import { listKpiSnapshots } from '../services/kpi-computation-service.js';
import { generateInsights } from '../services/insight-generator.js';
import { detectAnomalies } from '../services/anomaly-detector.js';
import { predictNext } from '../services/trend-predictor.js';

export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const agentService = new AgentService(ctx.db);
  const agentAccessService = new AgentAccessService(ctx.db);
  const memoryService = new MemoryService(ctx.db, ctx.redis, ctx.env.SHORT_MEMORY_TTL_SECONDS, ctx.embeddingService);
  const workspaceService = new WorkspaceService(ctx.db);

  // Every write below runs in a transaction with its own audit_logs insert —
  // an agent mutation must never be committed without an audit trail
  // (docs/spect/09_TASKS/08-scope-guardrails-mvp.md: "audit_logs برای همه actionها").

  app.post('/v1/agents', async (request) => {
    requirePermission(request, 'agents:create');
    const parsed = AgentCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid agent payload', parsed.error.flatten());

    const workspaceActive = await workspaceService.isActive(request.auth.organizationId, parsed.data.workspaceId);
    if (!workspaceActive) throw new ValidationError('Cannot create an agent in an archived (or unknown) workspace');

    return withTransaction(ctx.db, async (client) => {
      const agent = await new AgentService(client).create(request.auth.organizationId, parsed.data);
      // RT-024: the creator always keeps access to what they made, even a
      // non-admin manager who won't otherwise have a binding for it yet.
      await new AgentAccessService(client).grantOwner(agent.id, request.auth.userId);
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: agent.id,
        userId: request.auth.userId,
        actionType: 'agent-create',
        actionData: { traceId: request.traceId, name: agent.name, role: agent.role },
      });
      return agent;
    });
  });

  app.get('/v1/agents', async (request) => {
    requirePermission(request, 'agents:read');
    const agents = await agentService.list(request.auth.organizationId);
    if (request.auth.role === 'admin') return agents;
    const accessibleIds = await agentAccessService.listAccessibleAgentIds(
      request.auth.organizationId,
      request.auth.userId,
    );
    return agents.filter((a) => accessibleIds.has(a.id));
  });

  app.get<{ Params: { id: string } }>('/v1/agents/:id', async (request) => {
    requirePermission(request, 'agents:read');
    await requireAgentAccessible(ctx, request, request.params.id);
    return agentService.getById(request.auth.organizationId, request.params.id);
  });

  app.patch<{ Params: { id: string } }>('/v1/agents/:id', async (request) => {
    requirePermission(request, 'agents:update');
    await requireAgentAccessible(ctx, request, request.params.id);
    const parsed = AgentUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid agent payload', parsed.error.flatten());

    return withTransaction(ctx.db, async (client) => {
      const agent = await new AgentService(client).update(
        request.auth.organizationId,
        request.params.id,
        parsed.data,
      );
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: agent.id,
        userId: request.auth.userId,
        actionType: 'agent-update',
        actionData: { traceId: request.traceId, changes: parsed.data },
      });
      return agent;
    });
  });

  // Direct reports + transitive team (roadmap items 13/18 — "team" is just the reports_to subtree, no separate table).
  app.get<{ Params: { id: string } }>('/v1/agents/:id/reports', async (request) => {
    requirePermission(request, 'agents:read');
    await requireAgentAccessible(ctx, request, request.params.id);
    await agentService.getById(request.auth.organizationId, request.params.id); // org-scope check, 404s otherwise
    return agentService.listReports(request.auth.organizationId, request.params.id);
  });

  app.get<{ Params: { id: string } }>('/v1/agents/:id/team', async (request) => {
    requirePermission(request, 'agents:read');
    await requireAgentAccessible(ctx, request, request.params.id);
    await agentService.getById(request.auth.organizationId, request.params.id); // org-scope check, 404s otherwise
    return agentService.listTeam(request.auth.organizationId, request.params.id);
  });

  app.patch<{ Params: { id: string } }>('/v1/agents/:id/kpis', async (request) => {
    requirePermission(request, 'agents:update');
    await requireAgentAccessible(ctx, request, request.params.id);
    const parsed = AgentKpisUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid KPI payload', parsed.error.flatten());

    return withTransaction(ctx.db, async (client) => {
      const agent = await new AgentService(client).updateKpis(request.auth.organizationId, request.params.id, parsed.data.kpis);
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: agent.id,
        userId: request.auth.userId,
        actionType: 'agent-kpis-update',
        actionData: { traceId: request.traceId, kpis: parsed.data.kpis },
      });
      return agent;
    });
  });

  app.get<{ Params: { id: string }; Querystring: { kpiName?: string } }>('/v1/agents/:id/kpi-snapshots', async (request) => {
    requirePermission(request, 'agents:read');
    await requireAgentAccessible(ctx, request, request.params.id);
    if (!request.query.kpiName) throw new ValidationError('kpiName query parameter is required');
    await agentService.getById(request.auth.organizationId, request.params.id); // org-scope check, 404s otherwise
    return listKpiSnapshots(ctx.db, request.params.id, request.query.kpiName);
  });

  /**
   * RT-059/060/062/063 — the Outcomes dashboard's single data source per
   * KPI: raw snapshots + everything derived from them (insights, anomaly
   * flags, next-period prediction). Folded into one route instead of three
   * separate ones (insights/anomalies/prediction) since all three are pure
   * functions over the exact same snapshot array the dashboard already
   * needs — a real API surface for each would just mean the client re-fetches
   * the same data three times.
   */
  app.get<{ Params: { id: string }; Querystring: { kpiName?: string } }>('/v1/agents/:id/kpi-outcomes', async (request) => {
    requirePermission(request, 'agents:read');
    await requireAgentAccessible(ctx, request, request.params.id);
    if (!request.query.kpiName) throw new ValidationError('kpiName query parameter is required');
    await agentService.getById(request.auth.organizationId, request.params.id);

    const snapshots = await listKpiSnapshots(ctx.db, request.params.id, request.query.kpiName);
    const insights = generateInsights(request.query.kpiName, snapshots);
    const anomalies = detectAnomalies(snapshots.map((s) => ({ date: s.recordedAt, value: s.value })));
    const prediction = predictNext(snapshots.map((s, i) => ({ x: i, y: s.value })));

    return { snapshots, insights, anomalies, prediction };
  });

  app.post<{ Params: { id: string } }>('/v1/agents/:id/pause', async (request) => {
    requirePermission(request, 'agents:update');
    await requireAgentAccessible(ctx, request, request.params.id);
    return withTransaction(ctx.db, async (client) => {
      const agent = await new AgentService(client).setStatus(
        request.auth.organizationId,
        request.params.id,
        'paused',
      );
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: agent.id,
        userId: request.auth.userId,
        actionType: 'agent-pause',
        actionData: { traceId: request.traceId },
      });
      return agent;
    });
  });

  app.post<{ Params: { id: string } }>('/v1/agents/:id/resume', async (request) => {
    requirePermission(request, 'agents:update');
    await requireAgentAccessible(ctx, request, request.params.id);
    return withTransaction(ctx.db, async (client) => {
      const agent = await new AgentService(client).setStatus(
        request.auth.organizationId,
        request.params.id,
        'active',
      );
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: agent.id,
        userId: request.auth.userId,
        actionType: 'agent-resume',
        actionData: { traceId: request.traceId },
      });
      return agent;
    });
  });

  // Read-only, doesn't consume a request against the limit itself.
  app.get<{ Params: { id: string } }>('/v1/agents/:id/rate-limit', async (request) => {
    requirePermission(request, 'agents:read');
    await requireAgentAccessible(ctx, request, request.params.id);
    await agentService.getById(request.auth.organizationId, request.params.id); // org-scope check, 404s otherwise
    return getRateLimitStatus(ctx.redis, request.params.id, ctx.env.RATE_LIMIT_PER_MINUTE);
  });

  // Used by the dashboard to resume a chat on page load instead of starting empty every time.
  app.get<{ Params: { id: string } }>('/v1/agents/:id/conversation', async (request) => {
    requirePermission(request, 'agents:read');
    await requireAgentAccessible(ctx, request, request.params.id);
    await agentService.getById(request.auth.organizationId, request.params.id); // org-scope check, 404s otherwise
    const conversation = await memoryService.getLatestConversation(request.params.id);
    if (!conversation) return { conversation: null, messages: [] };
    const messages = await memoryService.getRecentMessages(conversation.id, 50);
    return { conversation, messages };
  });

  // Soft-delete: sets status='terminated' rather than a physical DELETE, to
  // preserve FK integrity with conversations/audit_logs.
  app.delete<{ Params: { id: string } }>('/v1/agents/:id', async (request, reply) => {
    requirePermission(request, 'agents:update');
    await requireAgentAccessible(ctx, request, request.params.id);
    await withTransaction(ctx.db, async (client) => {
      const agent = await new AgentService(client).setStatus(
        request.auth.organizationId,
        request.params.id,
        'terminated',
      );
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: agent.id,
        userId: request.auth.userId,
        actionType: 'agent-terminate',
        actionData: { traceId: request.traceId },
      });
    });
    return reply.status(204).send();
  });

  // RT-024: agent access management (admin-only — see migrations/0014_agent_access.sql).
  app.get<{ Params: { id: string } }>('/v1/agents/:id/access', async (request) => {
    requirePermission(request, 'agents:access:grant');
    await assertAgentAccessFeatureEnabled(ctx.db, request.auth.organizationId);
    await agentService.getById(request.auth.organizationId, request.params.id); // org-scope check, 404s otherwise
    return agentAccessService.listForAgent(request.auth.organizationId, request.params.id);
  });

  app.post<{ Params: { id: string } }>('/v1/agents/:id/access/grant', async (request) => {
    requirePermission(request, 'agents:access:grant');
    await assertAgentAccessFeatureEnabled(ctx.db, request.auth.organizationId);
    await agentService.getById(request.auth.organizationId, request.params.id); // org-scope check, 404s otherwise

    const body = request.body as { userId?: unknown; accessRole?: unknown };
    if (typeof body.userId !== 'string' || body.userId.length === 0) {
      throw new ValidationError('userId is required');
    }
    const accessRole = body.accessRole ?? 'member';
    assertValidAccessRole(accessRole);

    return withTransaction(ctx.db, async (client) => {
      const binding = await new AgentAccessService(client).grant(
        request.auth.organizationId,
        request.params.id,
        body.userId as string,
        accessRole,
        request.auth.userId,
      );
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: request.params.id,
        userId: request.auth.userId,
        actionType: 'agent-access-grant',
        actionData: { traceId: request.traceId, targetUserId: body.userId, accessRole },
      });
      return binding;
    });
  });

  app.delete<{ Params: { id: string; userId: string } }>('/v1/agents/:id/access/:userId', async (request, reply) => {
    requirePermission(request, 'agents:access:revoke');
    await assertAgentAccessFeatureEnabled(ctx.db, request.auth.organizationId);
    await agentService.getById(request.auth.organizationId, request.params.id); // org-scope check, 404s otherwise

    await withTransaction(ctx.db, async (client) => {
      await new AgentAccessService(client).revoke(request.auth.organizationId, request.params.id, request.params.userId);
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: request.params.id,
        userId: request.auth.userId,
        actionType: 'agent-access-revoke',
        actionData: { traceId: request.traceId, targetUserId: request.params.userId },
      });
    });
    return reply.status(204).send();
  });
}
