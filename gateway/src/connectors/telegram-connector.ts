import { ToolExecutionError } from '@o2n/governance';

interface TelegramSendResult {
  messageId: number;
}

interface TelegramApiResponse {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
}

/**
 * Real HTTP call to the Telegram Bot API — no mock/stub. One bot token per
 * deployment (env-configured, BYOK-style, same pattern as LLM_API_KEY), not
 * per-org credential storage (that's the full Connector model in
 * docs/spect/02_ARCHITECTURE/07-connectors-and-tools.md, out of scope here).
 */
export async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<TelegramSendResult> {
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    throw new ToolExecutionError('telegram-send', err);
  }

  const body = (await response.json().catch(() => null)) as TelegramApiResponse | null;
  if (!response.ok || !body?.ok || !body.result) {
    throw new ToolExecutionError('telegram-send', body?.description ?? `HTTP ${response.status}`);
  }

  return { messageId: body.result.message_id };
}
