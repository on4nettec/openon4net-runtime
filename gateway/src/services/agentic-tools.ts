import type { LlmToolDefinition } from '@o2n/llm-providers';
import type { SkillStep } from '@o2n/shared';
import type { Skill } from './skill-service.js';

/**
 * RT-085 — the JSON Schema each tool advertises to the model, hand-written
 * to match TelegramSendSchema/WebhookSendSchema (packages/shared/src/
 * schemas/tool.ts) exactly rather than pulling in a zod-to-json-schema
 * dependency for two small, stable, flat schemas.
 */
const AGENTIC_TOOL_DEFINITIONS: (LlmToolDefinition & { toolId: SkillStep['tool']; requiredPermission: string })[] = [
  {
    toolId: 'telegram-send',
    requiredPermission: 'tools:telegram-send',
    name: 'telegram_send',
    description: 'Sends a text message to a Telegram chat via the configured bot.',
    parameters: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: 'The Telegram chat id to send the message to.' },
        message: { type: 'string', description: 'The message text (max 4096 characters).' },
      },
      required: ['chatId', 'message'],
    },
  },
  {
    toolId: 'webhook-send',
    requiredPermission: 'tools:webhook-send',
    name: 'webhook_send',
    description: 'POSTs a JSON payload to an external HTTP(S) URL (blocks private/internal network targets).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The destination URL.' },
        payload: { type: 'object', description: 'The JSON payload to send.' },
      },
      required: ['url', 'payload'],
    },
  },
];

/** Maps an LLM tool-call's function name (e.g. "webhook_send") back to the underlying SkillStep tool id (e.g. "webhook-send"). */
const NAME_TO_TOOL_ID = new Map(AGENTIC_TOOL_DEFINITIONS.map((t) => [t.name, t.toolId]));

export function toolIdForFunctionName(name: string): SkillStep['tool'] | undefined {
  return NAME_TO_TOOL_ID.get(name);
}

/**
 * RT-085 — only advertises tools the acting user's RBAC permissions already
 * cover (same requiredPermission each tool's direct HTTP route enforces via
 * requirePermission() in routes/tools.ts) — the model can't even see a tool
 * exists if the human behind this chat turn couldn't call it directly.
 * Returns `undefined` (not `[]`) when nothing is available, so callers can
 * omit `tools` entirely rather than sending an empty array to the provider.
 */
export function buildAvailableTools(userPermissions: string[]): LlmToolDefinition[] | undefined {
  const available = AGENTIC_TOOL_DEFINITIONS.filter((t) => userPermissions.includes(t.requiredPermission)).map(
    ({ name, description, parameters }) => ({ name, description, parameters }),
  );
  return available.length > 0 ? available : undefined;
}

/**
 * RT-086 — a stable, LLM-safe function name for a Skill: sanitized name
 * plus a short id suffix (skills can share a display name, ids can't
 * collide). Not reversible by parsing alone — callers keep the
 * name→skillId map buildSkillTools() returns alongside it.
 */
function skillFunctionName(skill: Skill): string {
  const base = skill.name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'skill';
  const shortId = skill.id.replace(/-/g, '').slice(0, 8);
  return `skill_${base}_${shortId}`;
}

/**
 * RT-086 — every active Skill in the org is offered to the model as a
 * callable function, regardless of whether the *calling* agent has it
 * granted — that gate (and automatic delegation to another agent that does
 * have it) happens at execution time in chat-service.ts's runToolLoop, not
 * here. This is what makes delegation "automatic": the model never needs
 * to know or care which agent ends up actually running the skill.
 */
export function buildSkillTools(skills: Skill[]): { tools: LlmToolDefinition[]; nameToSkillId: Map<string, string> } {
  const nameToSkillId = new Map<string, string>();
  const tools: LlmToolDefinition[] = [];
  for (const skill of skills) {
    if (skill.status !== 'active') continue;
    const name = skillFunctionName(skill);
    nameToSkillId.set(name, skill.id);
    tools.push({
      name,
      description: skill.description ?? `Runs the "${skill.name}" skill.`,
      parameters: {
        type: 'object',
        additionalProperties: true,
        description: "Optional values overriding this skill's configured defaults (e.g. a different chatId or message).",
      },
    });
  }
  return { tools, nameToSkillId };
}
