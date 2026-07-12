import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db.js';

const WINDOW_DAYS = 7;
const FREQUENCY_THRESHOLD = 5;

interface CandidateRow {
  agent_id: string;
  organization_id: string;
  action_type: 'tool-webhook-send' | 'tool-telegram-send';
  occurrences: string;
  samples: Record<string, unknown>[];
}

/**
 * Auto-Skill Detection (docs/spect/02_ARCHITECTURE/03-skill-engine.md §7).
 * The doc's algorithm checks 4 conditions (Frequency/Similarity/Duration/
 * Complexity); this implementation only checks 2 — Frequency and Similarity
 * — because `audit_logs` (the only available signal; there is no separate
 * telemetry store) has no duration field, and "complexity/generality" has
 * no existing signal to check against. Both conditions passing (not 3-of-4)
 * triggers a proposal. Only scans the two action types that map onto a
 * SkillStep (tool-webhook-send, tool-telegram-send) — other audit_logs
 * action types (agent-chat, agent-create, ...) don't fit the tool-only
 * step schema and are never proposed.
 *
 * Note: `audit_logs.action_data` for these two tools only stores
 * `url`/`chatId` (not the request `message`/`payload` body — those aren't
 * captured in the audit trail, see routes/tools.ts), so a synthesized
 * proposal's step includes an empty placeholder for `message`/`payload`
 * that a human must fill in before approving — this is a real data
 * limitation, not an oversight.
 */
export async function detectSkillPatterns(db: Queryable): Promise<number> {
  const { rows } = await db.query<CandidateRow>(
    `SELECT agent_id, organization_id, action_type, COUNT(*) AS occurrences,
            array_agg(action_data ORDER BY created_at DESC) AS samples
     FROM audit_logs
     WHERE created_at > NOW() - INTERVAL '${WINDOW_DAYS} days'
       AND action_type IN ('tool-webhook-send', 'tool-telegram-send')
       AND status = 'success'
       AND agent_id IS NOT NULL
     GROUP BY agent_id, organization_id, action_type
     HAVING COUNT(*) > $1`,
    [FREQUENCY_THRESHOLD],
  );

  let created = 0;
  for (const row of rows) {
    if (!isSimilar(row.action_type, row.samples)) continue;

    const { rows: existing } = await db.query(
      `SELECT 1 FROM skill_proposals
       WHERE agent_id = $1 AND status = 'pending' AND pattern_metadata->>'actionType' = $2`,
      [row.agent_id, row.action_type],
    );
    if (existing.length > 0) continue; // already have a pending proposal for this pattern

    const proposedDefinition = synthesizeDefinition(row.action_type, row.samples[0] ?? {});
    await db.query(
      `INSERT INTO skill_proposals (agent_id, organization_id, proposed_definition, pattern_metadata)
       VALUES ($1, $2, $3, $4)`,
      [
        row.agent_id,
        row.organization_id,
        JSON.stringify(proposedDefinition),
        JSON.stringify({ actionType: row.action_type, occurrences: Number(row.occurrences), windowDays: WINDOW_DAYS }),
      ],
    );
    created += 1;
  }
  return created;
}

/** Proxy for "same steps every time" (doc's Similarity check) — checks the one identifying field each tool type logs (url / chatId) is identical across every sampled occurrence. */
function isSimilar(actionType: CandidateRow['action_type'], samples: Record<string, unknown>[]): boolean {
  const key = actionType === 'tool-webhook-send' ? 'url' : 'chatId';
  const values = samples.map((s) => s[key]);
  return values.length > 0 && values.every((v) => v === values[0] && v !== undefined);
}

function synthesizeDefinition(actionType: CandidateRow['action_type'], sample: Record<string, unknown>): unknown {
  const stepId = randomUUID();
  if (actionType === 'tool-webhook-send') {
    return {
      trigger: { type: 'manual' },
      steps: [{ id: stepId, type: 'tool', tool: 'webhook-send', params: { url: sample.url ?? '', payload: {} } }],
    };
  }
  return {
    trigger: { type: 'manual' },
    steps: [{ id: stepId, type: 'tool', tool: 'telegram-send', params: { chatId: sample.chatId ?? '', message: '' } }],
  };
}
