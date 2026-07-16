import { ToolExecutionError } from '@o2n/governance';
import { assertSafeWebhookUrl } from './webhook-connector.js';

export interface PluginProviderResult {
  statusCode: number;
  body: unknown;
}

/**
 * RT-079 — invokes a "thin HTTP-provider" Plugin's declared baseUrl with a
 * JSON POST of the step's params. Same SSRF guard as webhook-send
 * (assertSafeWebhookUrl) since this is the same shape of risk: an
 * agent-triggered server-side request to an arbitrary URL.
 */
export async function invokePluginProvider(baseUrl: string, params: Record<string, unknown>): Promise<PluginProviderResult> {
  await assertSafeWebhookUrl(baseUrl);

  let response: Response;
  try {
    response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new ToolExecutionError('plugin-provider', err);
  }

  if (!response.ok) {
    throw new ToolExecutionError('plugin-provider', `HTTP ${response.status}`);
  }

  const body = await response.json().catch(() => null);
  return { statusCode: response.status, body };
}
