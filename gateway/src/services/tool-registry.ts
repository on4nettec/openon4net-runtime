import type { ToolDefinition } from '@o2n/shared';

/**
 * Hardcoded, first-party only (Level 0 sandbox — see
 * docs/spect/02_ARCHITECTURE/09-plugin-sandbox.md). Not a dynamic/installable
 * registry with a manifest format; that's a later-sprint upgrade once
 * third-party plugins need it.
 */
const TOOLS: ToolDefinition[] = [
  {
    id: 'telegram-send',
    name: 'Telegram Send',
    description: 'Sends a text message to a Telegram chat via the configured bot.',
    requiredPermission: 'tools:telegram-send',
  },
];

export function listTools(): ToolDefinition[] {
  return TOOLS;
}
