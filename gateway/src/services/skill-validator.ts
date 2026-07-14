import type { SkillDefinition } from '@o2n/shared';
import { O2NError, ValidationError } from '@o2n/governance';
import { assertSafeWebhookUrl } from '../connectors/webhook-connector.js';

// v1 scope (03-skill-engine.md §4, unchanged): only `trigger.type: 'manual'`
// and `steps[].type: 'tool'` exist at all, so there's no query/prompt-step
// safety review to do here yet — that stays deferred alongside those step
// types. What this module adds beyond SkillDefinitionSchema's Zod shape
// check: structural sanity (duplicate ids, a step-count cap) plus running
// the webhook SSRF guard at *save* time instead of only at execution time.
const MAX_STEPS = 20;

export async function validateSkillDefinition(definition: SkillDefinition): Promise<void> {
  if (definition.steps.length > MAX_STEPS) {
    throw new ValidationError(`A skill may not have more than ${MAX_STEPS} steps (got ${definition.steps.length})`);
  }

  const seenIds = new Set<string>();
  for (const step of definition.steps) {
    if (seenIds.has(step.id)) {
      throw new ValidationError(`Duplicate step id: "${step.id}"`);
    }
    seenIds.add(step.id);

    if (step.tool === 'webhook-send') {
      const url = (step.params as { url?: unknown }).url;
      if (typeof url === 'string') {
        try {
          await assertSafeWebhookUrl(url);
        } catch (err) {
          // Re-thrown as a 400 VALIDATION_ERROR, not the connector's own
          // 502 TOOL_EXECUTION_FAILED — this is a save-time rejection, not
          // a failed tool call. ToolExecutionError's own .message is always
          // the generic "Tool X failed to execute" string; the actual
          // reason lives in .details (its `cause` constructor arg).
          const message =
            err instanceof O2NError && typeof err.details === 'string'
              ? err.details
              : err instanceof Error
                ? err.message
                : String(err);
          throw new ValidationError(`Step "${step.id}": ${message}`);
        }
      }
    }
  }
}
