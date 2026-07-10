import { lookup } from 'node:dns/promises';
import { ToolExecutionError } from '@o2n/governance';

interface WebhookResult {
  statusCode: number;
}

/**
 * SSRF guard: a generic "POST to any URL" tool is a real vector for an
 * agent to reach internal services (the docker bridge network, cloud
 * metadata endpoints like 169.254.169.254, etc.) that were never meant to
 * be internet-facing. Resolves the hostname and rejects private/loopback/
 * link-local ranges before making the request — same rationale as any
 * server-side webhook/SSRF-prone feature (Slack, Stripe, etc. all do this).
 */
function isPrivateOrReservedIp(ip: string): boolean {
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true; // malformed -> fail closed
  const [a, b] = parts as [number, number, number, number];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 0) return true;
  return false;
}

export async function sendWebhook(url: string, payload: Record<string, unknown>): Promise<WebhookResult> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ToolExecutionError('webhook-send', 'Only http/https URLs are allowed');
  }
  if (parsed.hostname === 'localhost') {
    throw new ToolExecutionError('webhook-send', 'Requests to localhost are not allowed');
  }

  let address: string;
  try {
    address = (await lookup(parsed.hostname)).address;
  } catch {
    throw new ToolExecutionError('webhook-send', `Could not resolve host: ${parsed.hostname}`);
  }
  if (isPrivateOrReservedIp(address)) {
    throw new ToolExecutionError('webhook-send', 'Requests to private/internal network addresses are not allowed');
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new ToolExecutionError('webhook-send', err);
  }

  if (!response.ok) {
    throw new ToolExecutionError('webhook-send', `HTTP ${response.status}`);
  }

  return { statusCode: response.status };
}
