import type { LlmToolDefinition } from '@o2n/llm-providers';
import type { SkillStep } from '@o2n/shared';

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
