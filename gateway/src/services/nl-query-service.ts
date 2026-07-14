import { z } from 'zod';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { LlmService } from './llm-service.js';
import { computeMetric, computeOrgMetric } from './kpi-computation-service.js';

const QueryIntentSchema = z.object({
  metric: z.enum(['action_count', 'cost_cents', 'success_rate']),
  agentId: z.string().uuid().nullable(),
  windowDays: z.number().int().positive().max(365),
});
export type QueryIntent = z.infer<typeof QueryIntentSchema>;

export interface NlQueryResult {
  answer: string;
  intent: QueryIntent;
  value: number;
}

function extractJson(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new ValidationError('LLM did not return a JSON object');
  try {
    return JSON.parse(match[0]);
  } catch {
    throw new ValidationError('LLM returned malformed JSON');
  }
}

/**
 * Translates a free-form question into ONE fixed, Zod-validated intent —
 * the LLM never generates SQL or a freeform query, only picks from
 * {metric, agentId, windowDays} (RT-064). Anything that fails safeParse is
 * rejected outright rather than passed through.
 */
export async function translateToIntent(llm: LlmService, model: string, question: string, agentIds: string[]): Promise<QueryIntent> {
  const result = await llm.completeWithRetry({
    model,
    maxTokens: 300,
    messages: [
      {
        role: 'system',
        content:
          `You translate a business question into a JSON query intent. Respond with ONLY a JSON object, no prose, matching exactly:\n` +
          `{"metric": "action_count" | "cost_cents" | "success_rate", "agentId": string-from-list-or-null, "windowDays": integer}\n` +
          `- metric: action_count = number of actions taken, cost_cents = spend in cents, success_rate = % of successful actions.\n` +
          `- agentId: one of [${agentIds.join(', ') || 'none available'}] if the question names a specific agent, otherwise null (org-wide).\n` +
          `- windowDays: the time window implied by the question (default 7 if unspecified).`,
      },
      { role: 'user', content: question },
    ],
  });

  const parsed = QueryIntentSchema.safeParse(extractJson(result.content));
  if (!parsed.success) {
    throw new ValidationError('Could not translate question into a supported query', parsed.error.flatten());
  }
  if (parsed.data.agentId && !agentIds.includes(parsed.data.agentId)) {
    throw new ValidationError('LLM referenced an agent outside this organization');
  }
  return parsed.data;
}

export async function phraseAnswer(llm: LlmService, model: string, question: string, intent: QueryIntent, value: number): Promise<string> {
  const result = await llm.completeWithRetry({
    model,
    maxTokens: 200,
    messages: [
      { role: 'system', content: 'Answer the question in one short sentence using only the given number. Do not invent other facts.' },
      { role: 'user', content: `Question: ${question}\nMetric: ${intent.metric}\nWindow: ${intent.windowDays} days\nValue: ${value}` },
    ],
  });
  return result.content.trim();
}

/** Two LLM calls through packages/llm-providers directly (RT-064) — see nl-query-service module docs above for why not full ChatService. */
export async function answerQuestion(ctx: AppContext, organizationId: string, question: string): Promise<NlQueryResult> {
  const { rows: agentRows } = await ctx.db.query<{ id: string }>(`SELECT id FROM agents WHERE organization_id = $1`, [organizationId]);
  const agentIds = agentRows.map((row) => row.id);

  const { provider, model } = await ctx.providerConfigService.resolve(organizationId);
  const llm = new LlmService(provider);

  const intent = await translateToIntent(llm, model, question, agentIds);
  const value = intent.agentId
    ? await computeMetric(ctx.db, intent.agentId, intent.metric, intent.windowDays)
    : await computeOrgMetric(ctx.db, organizationId, intent.metric, intent.windowDays);

  const answer = await phraseAnswer(llm, model, question, intent, value);
  return { answer, intent, value };
}
