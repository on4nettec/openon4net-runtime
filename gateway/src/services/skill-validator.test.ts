import { describe, expect, it } from 'vitest';
import type { SkillDefinition } from '@o2n/shared';
import { validateSkillDefinition } from './skill-validator.js';

function webhookStep(id: string, url: string) {
  return { id, type: 'tool' as const, tool: 'webhook-send' as const, params: { url, payload: {} } };
}

describe('validateSkillDefinition', () => {
  it('accepts a well-formed definition with a safe webhook URL', async () => {
    const definition: SkillDefinition = { trigger: { type: 'manual' }, steps: [webhookStep('step-1', 'https://example.com')] };
    await expect(validateSkillDefinition(definition)).resolves.toBeUndefined();
  });

  it('rejects duplicate step ids (RT-050)', async () => {
    const definition: SkillDefinition = {
      trigger: { type: 'manual' },
      steps: [webhookStep('step-1', 'https://example.com'), webhookStep('step-1', 'https://example.com/other')],
    };
    await expect(validateSkillDefinition(definition)).rejects.toThrow(/duplicate step id/i);
  });

  it('rejects more than the step-count cap', async () => {
    const definition: SkillDefinition = {
      trigger: { type: 'manual' },
      steps: Array.from({ length: 21 }, (unused, i) => webhookStep(`step-${i}`, 'https://example.com')),
    };
    await expect(validateSkillDefinition(definition)).rejects.toThrow(/may not have more than/i);
  });

  it('rejects a webhook step targeting a private/internal address at save time, not just execution time', async () => {
    const definition: SkillDefinition = {
      trigger: { type: 'manual' },
      steps: [webhookStep('step-1', 'http://169.254.169.254/latest/meta-data')],
    };
    await expect(validateSkillDefinition(definition)).rejects.toThrow(/private\/internal network/i);
  });

  it('rejects a webhook step targeting localhost', async () => {
    const definition: SkillDefinition = {
      trigger: { type: 'manual' },
      steps: [webhookStep('step-1', 'http://localhost:8080/hook')],
    };
    await expect(validateSkillDefinition(definition)).rejects.toThrow(/localhost/i);
  });
});
