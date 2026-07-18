import type { Db } from '../db.js';
import type { Env } from '../env.js';
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
 *
 * Takes `Db`/`Env` rather than the full `AppContext` (RT-086, same
 * narrowing as tool-dispatcher.ts's executeTool() in RT-085) — lets
 * chat-service.ts's agentic loop call this directly (including on behalf
 * of a delegate agent) without needing a full AppContext.
 */
export async function executeSkill(
  db: Db,
  env: Env,
  organizationId: string,
  agentId: string,
  skillId: string,
  params: Record<string, unknown>,
): Promise<SkillExecutionResult> {
  const skillService = new SkillService(db);
  const auditService = new AuditService(db);
  const skill = await skillService.getById(organizationId, skillId);

  const start = Date.now();
  const stepResults: unknown[] = [];
  try {
    for (const step of skill.definition.steps) {
      // Execute-time params (from the caller's request body) override the
      // skill definition's own step defaults, so a stored skill can still
      // take a dynamic value (e.g. a different chatId) at run time.
      const mergedParams = { ...step.params, ...params };
      const result = await executeTool({ ...step, params: mergedParams }, env);
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
