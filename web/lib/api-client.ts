'use client';

import type { Agent, AgentCreateRequest, AuditLog, Conversation, ErrorEnvelope, Message, User, UserRole } from '@o2n/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface Session {
  token: string;
  organizationId: string;
  organizationName: string;
  workspaceId: string;
  userId: string;
  role: string;
}

const SESSION_KEY = 'o2n_session';

export function saveSession(session: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function loadSession(): Session | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const session = loadSession();
  const headers = new Headers(init?.headers);
  // Fastify's default JSON parser rejects a zero-byte body when Content-Type
  // says application/json (FST_ERR_CTP_EMPTY_JSON_BODY) — only claim JSON
  // when there's actually a body (POST /pause, /resume, DELETE have none).
  if (init?.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  if (session) {
    headers.set('Authorization', `Bearer ${session.token}`);
    headers.set('X-Organization-Id', session.organizationId);
  }

  const response = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorEnvelope | null;
    throw new ApiError(
      body?.error.code ?? 'UNKNOWN_ERROR',
      body?.error.message ?? `Request failed with status ${response.status}`,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface StreamCallbacks {
  onToken: (delta: string) => void;
  onDone: (info: { conversationId: string; model: string; costCents: number; traceId: string; timeMs: number }) => void;
  onRequiresApproval: (approvalId: string) => void;
  onError: (message: string) => void;
  /**
   * The connection itself dropped mid-stream (network blip, server restart) —
   * distinct from onError (the server told us something went wrong). We
   * deliberately do NOT auto-retry the same message here: the LLM call may
   * have already completed and been persisted server-side by the time the
   * connection dropped on delivery, so blindly resending risks a duplicate
   * response and double-charging a paid provider. The caller should
   * reconcile against server truth (api.getLatestConversation) instead of
   * guessing.
   */
  onDisconnect: () => void;
}

/**
 * Native EventSource only supports GET, and this endpoint is a POST — so we
 * fetch() the stream and parse Server-Sent Events out of the response body
 * by hand (split on blank lines, pull out `event:`/`data:` fields).
 */
export async function streamChat(
  agentId: string,
  message: string,
  conversationId: string | undefined,
  callbacks: StreamCallbacks,
): Promise<void> {
  const session = loadSession();
  if (!session) throw new Error('Not signed in');

  let response: Response;
  try {
    response = await fetch(`${API_URL}/v1/agents/${agentId}/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.token}`,
        'X-Organization-Id': session.organizationId,
      },
      body: JSON.stringify({ message, conversationId }),
    });
  } catch {
    callbacks.onDisconnect();
    return;
  }

  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as ErrorEnvelope | null;
    callbacks.onError(body?.error.message ?? `Request failed with status ${response.status}`);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawDone = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const rawEvent of events) {
        const eventLine = rawEvent.split('\n').find((l) => l.startsWith('event:'));
        const dataLine = rawEvent.split('\n').find((l) => l.startsWith('data:'));
        if (!eventLine || !dataLine) continue;

        const eventType = eventLine.slice('event:'.length).trim();
        const data: unknown = JSON.parse(dataLine.slice('data:'.length).trim());

        if (eventType === 'token') {
          callbacks.onToken((data as { delta: string }).delta);
        } else if (eventType === 'done') {
          sawDone = true;
          callbacks.onDone(
            data as { conversationId: string; model: string; costCents: number; traceId: string; timeMs: number },
          );
        } else if (eventType === 'requires-approval') {
          sawDone = true;
          callbacks.onRequiresApproval((data as { approvalId: string }).approvalId);
        } else if (eventType === 'error') {
          sawDone = true;
          callbacks.onError((data as { message: string }).message);
        }
      }
    }
  } catch {
    // reader.read() threw — connection dropped mid-stream, not a clean end.
    sawDone = true;
    callbacks.onDisconnect();
    return;
  }

  // Stream ended (reader signaled done) without ever seeing a terminal SSE
  // event — the connection was cut, not gracefully closed by the server.
  if (!sawDone) {
    callbacks.onDisconnect();
  }
}

export const api = {
  login: (input: {
    apiKey: string;
    organizationSlug: string;
    organizationName?: string | undefined;
    email?: string | undefined;
  }) => request<Session>('/v1/auth/token', { method: 'POST', body: JSON.stringify(input) }),

  listAgents: () => request<Agent[]>('/v1/agents'),

  getAgent: (id: string) => request<Agent>(`/v1/agents/${id}`),

  createAgent: (input: AgentCreateRequest) =>
    request<Agent>('/v1/agents', { method: 'POST', body: JSON.stringify(input) }),

  pauseAgent: (id: string) => request<Agent>(`/v1/agents/${id}/pause`, { method: 'POST' }),
  resumeAgent: (id: string) => request<Agent>(`/v1/agents/${id}/resume`, { method: 'POST' }),
  terminateAgent: (id: string) => request<void>(`/v1/agents/${id}`, { method: 'DELETE' }),

  getLatestConversation: (agentId: string) =>
    request<{ conversation: Conversation | null; messages: Message[] }>(`/v1/agents/${agentId}/conversation`),

  getConfig: () =>
    request<{
      provider: string;
      model: string;
      apiKeyMasked: string;
      baseUrl: string | null;
      source: 'database' | 'env';
      approvalThresholdCents: number;
      rateLimitPerMinute: number;
    }>('/v1/config'),

  updateConfig: (input: { provider: string; model: string; apiKey: string; baseUrl?: string | undefined }) =>
    request<{
      provider: string;
      model: string;
      apiKeyMasked: string;
      baseUrl: string | null;
      source: 'database' | 'env';
    }>('/v1/config', { method: 'PUT', body: JSON.stringify(input) }),

  testConnection: () =>
    request<{ success: boolean; model?: string; error?: string; responseTimeMs: number }>(
      '/v1/config/test-connection',
      { method: 'POST' },
    ),

  listUsers: () => request<User[]>('/v1/users'),

  createUser: (input: { email: string; name: string; role: UserRole }) =>
    request<User>('/v1/users', { method: 'POST', body: JSON.stringify(input) }),

  getAuditLogs: (params: { limit?: number; offset?: number; agentId?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.offset !== undefined) query.set('offset', String(params.offset));
    if (params.agentId) query.set('agentId', params.agentId);
    const qs = query.toString();
    return request<{ logs: AuditLog[]; total: number }>(`/v1/audit${qs ? `?${qs}` : ''}`);
  },

  getRoles: () =>
    request<{ id: string; name: string; isSystem: boolean; permissions: string[] }[]>('/v1/roles'),

  updateRolePermissions: (roleId: string, permissions: string[]) =>
    request<{ id: string; name: string; isSystem: boolean; permissions: string[] }>(
      `/v1/roles/${roleId}/permissions`,
      { method: 'PUT', body: JSON.stringify({ permissions }) },
    ),
};
