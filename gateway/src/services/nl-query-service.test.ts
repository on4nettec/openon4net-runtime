import { describe, expect, it } from 'vitest';
import type { LlmCompletionResult, LlmProvider, LlmStreamChunk } from '@o2n/llm-providers';
import { LlmService } from './llm-service.js';
import { translateToIntent, phraseAnswer } from './nl-query-service.js';

/**
 * A real LLM call isn't available in CI (same category as RT-005's
 * Telegram-token block, see docs/spect/DONE.md) — this fakes the provider
 * boundary (LlmProvider.complete) with a canned response instead of mocking
 * translateToIntent/phraseAnswer themselves, so the actual JSON-extraction
 * and Zod-validation logic in nl-query-service.ts still runs for real.
 */
function fakeProvider(content: string): LlmProvider {
  return {
    name: 'fake',
    complete: (): Promise<LlmCompletionResult> =>
      Promise.resolve({ content, model: 'fake-model', inputTokens: 10, outputTokens: 10 }),
    stream: (): AsyncIterable<LlmStreamChunk> => {
      throw new Error('not used in this test');
    },
  };
}

describe('translateToIntent', () => {
  const agentIds = ['11111111-1111-1111-1111-111111111111'];

  it('parses a well-formed JSON intent from the LLM response', async () => {
    const llm = new LlmService(fakeProvider('{"metric": "action_count", "agentId": null, "windowDays": 7}'));
    const intent = await translateToIntent(llm, 'fake-model', 'how many actions this week?', agentIds);
    expect(intent).toEqual({ metric: 'action_count', agentId: null, windowDays: 7 });
  });

  it('tolerates prose wrapped around the JSON object', async () => {
    const llm = new LlmService(
      fakeProvider('Sure, here you go:\n{"metric": "cost_cents", "agentId": null, "windowDays": 30}\nHope that helps!'),
    );
    const intent = await translateToIntent(llm, 'fake-model', 'how much did we spend this month?', agentIds);
    expect(intent.metric).toBe('cost_cents');
    expect(intent.windowDays).toBe(30);
  });

  it('rejects a response with no JSON object at all', async () => {
    const llm = new LlmService(fakeProvider('I cannot help with that.'));
    await expect(translateToIntent(llm, 'fake-model', 'what is the weather?', agentIds)).rejects.toThrow();
  });

  it('rejects a JSON object that fails schema validation', async () => {
    const llm = new LlmService(fakeProvider('{"metric": "not-a-real-metric", "agentId": null, "windowDays": 7}'));
    await expect(translateToIntent(llm, 'fake-model', 'bad metric', agentIds)).rejects.toThrow();
  });

  it('rejects an agentId the LLM hallucinated outside the given organization', async () => {
    const llm = new LlmService(
      fakeProvider('{"metric": "action_count", "agentId": "22222222-2222-2222-2222-222222222222", "windowDays": 7}'),
    );
    await expect(translateToIntent(llm, 'fake-model', 'actions for some other agent', agentIds)).rejects.toThrow();
  });
});

describe('phraseAnswer', () => {
  it('returns the LLM-phrased sentence, trimmed', async () => {
    const llm = new LlmService(fakeProvider('  You took 42 actions this week.  \n'));
    const answer = await phraseAnswer(llm, 'fake-model', 'how many actions?', { metric: 'action_count', agentId: null, windowDays: 7 }, 42);
    expect(answer).toBe('You took 42 actions this week.');
  });
});
