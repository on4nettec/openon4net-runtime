import type { WorkflowConditionStep, WorkflowStep } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { AgentService } from './agent-service.js';
import { ApprovalService } from './approval-service.js';
import { ChatService } from './chat-service.js';
import { executeTool } from './tool-dispatcher.js';
import { executePluginStep } from './plugin-invoker.js';
import { WorkflowRunService, type WorkflowRun } from './workflow-run-service.js';
import { WorkflowService } from './workflow-service.js';

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in acc) return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function evaluateCondition(step: WorkflowConditionStep, context: Record<string, unknown>): boolean {
  const actual = getByPath(context, step.field);
  switch (step.op) {
    case 'eq':
      return actual === step.value;
    case 'neq':
      return actual !== step.value;
    case 'gt':
      return typeof actual === 'number' && typeof step.value === 'number' && actual > step.value;
    case 'lt':
      return typeof actual === 'number' && typeof step.value === 'number' && actual < step.value;
    case 'gte':
      return typeof actual === 'number' && typeof step.value === 'number' && actual >= step.value;
    case 'lte':
      return typeof actual === 'number' && typeof step.value === 'number' && actual <= step.value;
  }
}

/**
 * v1 DAG executor — see packages/shared/src/schemas/workflow.ts's scoping
 * comment. Reuses three already-built subsystems instead of new
 * infrastructure: ChatService (agent step), tool-dispatcher's executeTool
 * (tool step), ApprovalService (human step — the same generalized queue
 * from RT-042).
 */
export class WorkflowExecutor {
  constructor(private ctx: AppContext) {}

  async start(organizationId: string, workflowId: string, userId: string | null): Promise<WorkflowRun> {
    const workflow = await new WorkflowService(this.ctx.db).getById(organizationId, workflowId);
    const runService = new WorkflowRunService(this.ctx.db);
    const run = await runService.create(organizationId, workflowId);
    await this.walk(run, workflow.definition.steps, 0, userId);
    return runService.getById(run.id);
  }

  /** Called from routes/approvals.ts when a human-step approval is resolved. */
  async resumeFromApproval(runId: string, approved: boolean, userId: string | null): Promise<void> {
    const runService = new WorkflowRunService(this.ctx.db);
    const run = await runService.getById(runId);
    const workflow = await new WorkflowService(this.ctx.db).getById(run.organizationId, run.workflowId);

    if (!approved) {
      await runService.logStep(run.id, run.currentStepId ?? 'unknown', 'failed', { reason: 'human step rejected' });
      await runService.complete(run.id, 'failed');
      return;
    }

    await runService.markRunning(run.id);
    const steps = workflow.definition.steps;
    const currentIndex = steps.findIndex((s) => s.id === run.currentStepId);
    await this.walk(run, steps, currentIndex === -1 ? steps.length : currentIndex + 1, userId);
  }

  private async walk(run: WorkflowRun, steps: WorkflowStep[], startIndex: number, userId: string | null): Promise<void> {
    const runService = new WorkflowRunService(this.ctx.db);
    let context = run.context;
    let index = startIndex;

    try {
      while (index < steps.length) {
        const step = steps[index];
        if (!step) break;

        if (step.type === 'human') {
          await runService.logStep(run.id, step.id, 'running');
          const approval = await new ApprovalService(this.ctx.db).create(run.organizationId, {
            actionData: { traceId: run.id, workflowRunId: run.id, stepId: step.id, reason: step.reason },
            reason: step.reason,
            expiresAt: step.timeoutMs ? new Date(Date.now() + step.timeoutMs) : undefined,
          });
          await runService.updateProgress(run.id, step.id, context);
          await runService.pauseForApproval(run.id, approval.id);
          return; // stop here — resumeFromApproval() continues later
        }

        const result = await this.runStep(step, run.organizationId, context, userId);
        context = { ...context, [step.id]: result };
        await runService.logStep(run.id, step.id, 'completed', result);

        if (step.type === 'condition') {
          const targetId = evaluateCondition(step, context) ? step.then : step.else;
          if (!targetId) {
            index += 1;
            continue;
          }
          const targetIndex = steps.findIndex((s) => s.id === targetId);
          if (targetIndex === -1) throw new ValidationError(`Workflow references an unknown step id: ${targetId}`);
          index = targetIndex;
          continue;
        }

        index += 1;
      }

      await runService.updateProgress(run.id, null, context);
      await runService.complete(run.id, 'success');
    } catch (err) {
      await runService.updateProgress(run.id, steps[index]?.id ?? null, context);
      await runService.complete(run.id, 'failed');
      throw err;
    }
  }

  private async runStep(
    step: Exclude<WorkflowStep, { type: 'human' }>,
    organizationId: string,
    context: Record<string, unknown>,
    userId: string | null,
  ): Promise<unknown> {
    if (step.type === 'agent') {
      const agent = await new AgentService(this.ctx.db).findByRole(organizationId, step.agentRole);
      if (!agent) throw new ValidationError(`No active agent with role "${step.agentRole}" found for this step`);

      const chatService = new ChatService(
        this.ctx.db,
        this.ctx.redis,
        this.ctx.providerConfigService,
        this.ctx.env,
        this.ctx.embeddingService,
        this.ctx.policyService,
      );
      const outcome = await chatService.chat({
        organizationId,
        userId,
        agentId: agent.id,
        message: step.prompt,
        traceId: step.id,
      });
      // v1 doesn't chain the workflow's own human-step approvals with a
      // target agent's own chat-cost approval gate — if the underlying
      // chat itself needs approval, this step simply fails; documented
      // limitation, not a silent no-op.
      if (outcome.kind !== 'success') {
        throw new ValidationError(`Agent step "${step.id}" requires a separate chat approval — not supported in workflow v1`);
      }
      return { response: outcome.response, agentId: agent.id };
    }

    if (step.type === 'tool') {
      return executeTool(step, this.ctx);
    }

    if (step.type === 'plugin') {
      const agent = await new AgentService(this.ctx.db).findByRole(organizationId, step.agentRole);
      if (!agent) throw new ValidationError(`No active agent with role "${step.agentRole}" found for this step`);
      return executePluginStep(this.ctx, organizationId, agent.id, step.pluginId, step.params);
    }

    if (step.type === 'parallel') {
      const results = await Promise.all(step.steps.map((subStep) => this.runStep(subStep, organizationId, context, userId)));
      return Object.fromEntries(step.steps.map((subStep, i) => [subStep.id, results[i]]));
    }

    // condition: no side effect of its own, just records what was evaluated
    return { field: step.field, op: step.op };
  }
}
