import type { AppContext } from '../context.js';
import { SkillService } from './skill-service.js';
import { AuditService } from './audit-service.js';
import { executeTool } from './tool-dispatcher.js';

export interface SkillExecutionResult {
  skillId: string;
  succeeded: boolean;
  durationMs: number;
  stepResults: unknown[];
}

/**
 * Walks a Skill's `definition.steps` (tool-type only, v1 scope — see
 * SkillDefinitionSchema in packages/shared) in order, dispatching each
 * through tool-dispatcher.ts. Reuses each step's own tool-level permission
 * surface — a Skill only replays actions the executing agent could already
 * do directly, one at a time, so no new escalation path is introduced.
 */
export async function executeSkill(
  ctx: AppContext,
  organizationId: string,
  agentId: string,
  skillId: string,
  params: Record<string, unknown>,
): Promise<SkillExecutionResult> {
  const skillService = new SkillService(ctx.db);
  const auditService = new AuditService(ctx.db);
  const skill = await skillService.getById(organizationId, skillId);

  const start = Date.now();
  const stepResults: unknown[] = [];
  try {
    for (const step of skill.definition.steps) {
      // Execute-time params (from the caller's request body) override the
      // skill definition's own step defaults, so a stored skill can still
      // take a dynamic value (e.g. a different chatId) at run time.
      const mergedParams = { ...step.params, ...params };
      const result = await executeTool({ ...step, params: mergedParams }, ctx);
      stepResults.push(result);
    }

    const durationMs = Date.now() - start;
    await skillService.recordExecution(skillId, true, durationMs);
    await auditService.logAction({
      organizationId,
      agentId,
      actionType: 'skill-execute',
      actionData: { skillId, stepCount: skill.definition.steps.length },
    });
    return { skillId, succeeded: true, durationMs, stepResults };
  } catch (err) {
    const durationMs = Date.now() - start;
    await skillService.recordExecution(skillId, false, durationMs);
    await auditService.logAction({
      organizationId,
      agentId,
      actionType: 'skill-execute',
      actionData: { skillId },
      status: 'failed',
    });
    throw err;
  }
}
