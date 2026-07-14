import type { FastifyInstance } from 'fastify';
import { WorkflowCreateSchema, WorkflowUpdateSchema } from '@o2n/shared';
import { NotFoundError, ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { WorkflowService } from '../services/workflow-service.js';
import { WorkflowRunService } from '../services/workflow-run-service.js';
import { WorkflowExecutor } from '../services/workflow-executor.js';
import { AuditService } from '../services/audit-service.js';

/** Roadmap item 17 (Agent Teams, weeks 31-32) — v1 DAG workflow engine. Manual trigger only, see packages/shared/src/schemas/workflow.ts. */
export function registerWorkflowRoutes(app: FastifyInstance, ctx: AppContext): void {
  const workflowService = new WorkflowService(ctx.db);
  const workflowRunService = new WorkflowRunService(ctx.db);

  app.get('/v1/workflows', async (request) => {
    requirePermission(request, 'workflows:read');
    return workflowService.list(request.auth.organizationId);
  });

  app.post('/v1/workflows', async (request) => {
    requirePermission(request, 'workflows:create');
    const parsed = WorkflowCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid workflow payload', parsed.error.flatten());

    const workflow = await workflowService.create(request.auth.organizationId, parsed.data, request.auth.userId);
    await new AuditService(ctx.db).logAction({
      organizationId: request.auth.organizationId,
      userId: request.auth.userId,
      actionType: 'workflow-create',
      actionData: { traceId: request.traceId, workflowId: workflow.id, name: workflow.name },
    });
    return workflow;
  });

  app.get<{ Params: { id: string } }>('/v1/workflows/:id', async (request) => {
    requirePermission(request, 'workflows:read');
    return workflowService.getById(request.auth.organizationId, request.params.id);
  });

  app.patch<{ Params: { id: string } }>('/v1/workflows/:id', async (request) => {
    requirePermission(request, 'workflows:update');
    const parsed = WorkflowUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid workflow payload', parsed.error.flatten());

    const workflow = await workflowService.update(request.auth.organizationId, request.params.id, parsed.data);
    await new AuditService(ctx.db).logAction({
      organizationId: request.auth.organizationId,
      userId: request.auth.userId,
      actionType: 'workflow-update',
      actionData: { traceId: request.traceId, workflowId: workflow.id, changes: parsed.data },
    });
    return workflow;
  });

  app.get<{ Params: { id: string } }>('/v1/workflows/:id/runs', async (request) => {
    requirePermission(request, 'workflows:read');
    await workflowService.getById(request.auth.organizationId, request.params.id); // org-scope check, 404s otherwise
    return workflowRunService.listForWorkflow(request.auth.organizationId, request.params.id);
  });

  app.post<{ Params: { id: string } }>('/v1/workflows/:id/run', async (request) => {
    requirePermission(request, 'workflows:run');
    const run = await new WorkflowExecutor(ctx).start(request.auth.organizationId, request.params.id, request.auth.userId);
    await new AuditService(ctx.db).logAction({
      organizationId: request.auth.organizationId,
      userId: request.auth.userId,
      actionType: 'workflow-run',
      actionData: { traceId: request.traceId, workflowId: request.params.id, runId: run.id },
    });
    return run;
  });

  app.get<{ Params: { id: string } }>('/v1/workflow-runs/:id', async (request) => {
    requirePermission(request, 'workflows:read');
    const run = await workflowRunService.getById(request.params.id);
    if (run.organizationId !== request.auth.organizationId) {
      // Same 404-not-403 convention as lib/agent-access.ts's requireAgentAccessible.
      throw new NotFoundError('Workflow run', request.params.id);
    }
    return run;
  });
}
