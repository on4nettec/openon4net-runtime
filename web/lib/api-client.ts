'use client';

import type {
  Agent,
  AgentCreateRequest,
  AuditLog,
  Conversation,
  ErrorEnvelope,
  Message,
  ApprovalQueueEntry,
  KpiDefinition,
  Organization,
  User,
  Workspace,
  WorkflowDefinition,
} from '@o2n/shared';

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

export interface SkillStep {
  id: string;
  type: 'tool';
  tool: 'telegram-send' | 'webhook-send';
  params: Record<string, unknown>;
}

export interface SkillDefinition {
  trigger: { type: 'manual' };
  steps: SkillStep[];
}

export interface Skill {
  id: string;
  agentId: string;
  organizationId: string;
  name: string;
  description: string | null;
  version: string;
  definition: SkillDefinition;
  source: 'auto' | 'manual' | 'marketplace';
  status: 'active' | 'inactive' | 'deprecated';
  executionCount: number;
  successRate: number;
  avgDurationMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Invitation {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  workspaceId: string | null;
  invitedByUserId: string | null;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
  createdAt: string;
}

export interface Workflow {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  definition: WorkflowDefinition;
  status: 'draft' | 'active' | 'archived';
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  organizationId: string;
  status: 'pending' | 'running' | 'paused' | 'success' | 'failed';
  currentStepId: string | null;
  context: Record<string, unknown>;
  pendingApprovalId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface SkillGrant {
  id: string;
  agentId: string;
  skillId: string;
  grantedByUserId: string | null;
  createdAt: string;
}

export interface SkillProposal {
  id: string;
  agentId: string;
  organizationId: string;
  proposedDefinition: SkillDefinition;
  patternMetadata: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected';
  reviewedByUserId: string | null;
  createdAt: string;
}

export interface MarketplaceConfigField {
  key: string;
  label: string;
  type: string;
}

export interface MarketplacePlugin {
  pluginId: string;
  packageName: string;
  name: string;
  description: string | null;
  publisherSlug: string;
  publisherVerified: boolean;
  latestVersion: string | null;
  manifest: { configSchema?: MarketplaceConfigField[] } | null;
  permissions: string[];
  installCount: number;
  avgRating: number | null;
  ratingCount: number;
  createdAt: string;
}

export interface PublisherPlugin {
  pluginId: string;
  packageName: string;
  name: string;
  description: string | null;
  status: string;
  publisherId: string;
  publisherSlug: string;
  latestVersion: string | null;
  latestVersionStatus: string | null;
  createdAt: string;
}

export interface PublisherSkill {
  skillId: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  priceCents: number;
  publisherId: string;
  publisherSlug: string;
  createdAt: string;
}

export interface MarketplaceSkillListing {
  skillId: string;
  slug: string;
  name: string;
  description: string | null;
  priceCents: number;
  publisherSlug: string;
  installCount: number;
  avgRating: number | null;
  ratingCount: number;
  createdAt: string;
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

/** Triggers a browser file download — request()'s JSON-only response.json() doesn't fit CSV/attachment responses, so this bypasses it with a raw fetch + blob (RT-054). */
export async function downloadAuditLogExport(format: 'csv' | 'json'): Promise<void> {
  const session = loadSession();
  if (!session) throw new Error('Not signed in');

  const response = await fetch(`${API_URL}/v1/audit/export?format=${format}`, {
    headers: { Authorization: `Bearer ${session.token}`, 'X-Organization-Id': session.organizationId },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorEnvelope | null;
    throw new ApiError(body?.error.code ?? 'UNKNOWN_ERROR', body?.error.message ?? 'Export failed', response.status);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = format === 'csv' ? 'audit-log.csv' : 'audit-log.json';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
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

  updateAgentSchedule: (id: string, schedule: { enabled: boolean; intervalMinutes?: number; prompt?: string }) =>
    request<Agent>(`/v1/agents/${id}`, { method: 'PATCH', body: JSON.stringify({ schedule }) }),

  pauseAgent: (id: string) => request<Agent>(`/v1/agents/${id}/pause`, { method: 'POST' }),
  resumeAgent: (id: string) => request<Agent>(`/v1/agents/${id}/resume`, { method: 'POST' }),
  terminateAgent: (id: string) => request<void>(`/v1/agents/${id}`, { method: 'DELETE' }),

  listAgentReports: (id: string) => request<Agent[]>(`/v1/agents/${id}/reports`),
  listAgentTeam: (id: string) => request<Agent[]>(`/v1/agents/${id}/team`),

  updateAgentKpis: (id: string, kpis: KpiDefinition[]) =>
    request<Agent>(`/v1/agents/${id}/kpis`, { method: 'PATCH', body: JSON.stringify({ kpis }) }),

  getLatestConversation: (agentId: string) =>
    request<{ conversation: Conversation | null; messages: Message[] }>(`/v1/agents/${agentId}/conversation`),

  getRateLimitStatus: (agentId: string) =>
    request<{ usedThisMinute: number; limitPerMinute: number; resetsInSeconds: number }>(
      `/v1/agents/${agentId}/rate-limit`,
    ),

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

  createUser: (input: { email: string; name: string; role: string; workspaceId?: string | undefined }) =>
    request<User>('/v1/users', { method: 'POST', body: JSON.stringify(input) }),

  updateUser: (userId: string, input: { role?: string; workspaceId?: string; isActive?: boolean }) =>
    request<User>(`/v1/users/${userId}`, { method: 'PATCH', body: JSON.stringify(input) }),

  deactivateUser: (userId: string) => request<void>(`/v1/users/${userId}`, { method: 'DELETE' }),

  listWorkspaces: (includeArchived = false) =>
    request<Workspace[]>(`/v1/workspaces${includeArchived ? '?includeArchived=true' : ''}`),

  createWorkspace: (input: { name: string; description?: string | undefined }) =>
    request<Workspace>('/v1/workspaces', { method: 'POST', body: JSON.stringify(input) }),

  updateWorkspace: (id: string, input: { name?: string | undefined; description?: string | undefined }) =>
    request<Workspace>(`/v1/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),

  archiveWorkspace: (id: string) => request<Workspace>(`/v1/workspaces/${id}/archive`, { method: 'POST' }),

  getAuditLogs: (params: { limit?: number; offset?: number; agentId?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.offset !== undefined) query.set('offset', String(params.offset));
    if (params.agentId) query.set('agentId', params.agentId);
    const qs = query.toString();
    return request<{ logs: AuditLog[]; total: number }>(`/v1/audit${qs ? `?${qs}` : ''}`);
  },

  verifyAuditChain: () => request<{ valid: boolean; brokenAtId?: string; checkedCount: number }>('/v1/audit/verify'),

  getRoles: () =>
    request<{ id: string; name: string; isSystem: boolean; permissions: string[] }[]>('/v1/roles'),

  updateRolePermissions: (roleId: string, permissions: string[]) =>
    request<{ id: string; name: string; isSystem: boolean; permissions: string[] }>(
      `/v1/roles/${roleId}/permissions`,
      { method: 'PUT', body: JSON.stringify({ permissions }) },
    ),

  createRole: (name: string) =>
    request<{ id: string; name: string; isSystem: boolean; permissions: string[] }>('/v1/roles', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  deleteRole: (roleId: string) => request<void>(`/v1/roles/${roleId}`, { method: 'DELETE' }),

  listPolicies: () =>
    request<
      {
        id: string;
        name: string;
        condition:
          | { type: 'cost_gt_cents'; value: number }
          | { type: 'outside_hours'; startHour: number; endHour: number }
          | { type: 'action_type_in'; actionTypes: string[] };
        isActive: boolean;
        createdAt: string;
      }[]
    >('/v1/policies'),

  createPolicy: (input: {
    name: string;
    condition:
      | { type: 'cost_gt_cents'; value: number }
      | { type: 'outside_hours'; startHour: number; endHour: number }
      | { type: 'action_type_in'; actionTypes: string[] };
  }) =>
    request<{ id: string; name: string; condition: unknown; isActive: boolean; createdAt: string }>(
      '/v1/policies',
      { method: 'POST', body: JSON.stringify(input) },
    ),

  updatePolicy: (id: string, isActive: boolean) =>
    request<{ id: string; name: string; condition: unknown; isActive: boolean; createdAt: string }>(
      `/v1/policies/${id}`,
      { method: 'PATCH', body: JSON.stringify({ isActive }) },
    ),

  deletePolicy: (id: string) => request<void>(`/v1/policies/${id}`, { method: 'DELETE' }),

  listAgentAccess: (agentId: string) =>
    request<
      {
        id: string;
        agentId: string;
        userId: string;
        userEmail: string;
        userName: string;
        accessRole: 'owner' | 'member' | 'viewer';
        grantedByUserId: string | null;
        createdAt: string;
      }[]
    >(`/v1/agents/${agentId}/access`),

  grantAgentAccess: (agentId: string, userId: string, accessRole: 'owner' | 'member' | 'viewer') =>
    request<{ id: string }>(`/v1/agents/${agentId}/access/grant`, {
      method: 'POST',
      body: JSON.stringify({ userId, accessRole }),
    }),

  revokeAgentAccess: (agentId: string, userId: string) =>
    request<void>(`/v1/agents/${agentId}/access/${userId}`, { method: 'DELETE' }),

  listSkills: () => request<Skill[]>('/v1/skills'),

  createSkill: (input: { agentId: string; name: string; description?: string; definition: SkillDefinition }) =>
    request<Skill>('/v1/skills', { method: 'POST', body: JSON.stringify(input) }),

  deleteSkill: (id: string) => request<void>(`/v1/skills/${id}`, { method: 'DELETE' }),

  listAgentSkillGrants: (agentId: string) => request<SkillGrant[]>(`/v1/agents/${agentId}/skills`),

  grantSkill: (agentId: string, skillId: string) =>
    request<SkillGrant>(`/v1/agents/${agentId}/skills/${skillId}/grant`, { method: 'POST' }),

  revokeSkill: (agentId: string, skillId: string) =>
    request<void>(`/v1/agents/${agentId}/skills/${skillId}/grant`, { method: 'DELETE' }),

  executeSkill: (agentId: string, skillId: string, params: Record<string, unknown> = {}) =>
    request<{ skillId: string; succeeded: boolean; durationMs: number; stepResults: unknown[] }>(
      `/v1/agents/${agentId}/skills/${skillId}/execute`,
      { method: 'POST', body: JSON.stringify({ params }) },
    ),

  listSkillProposals: () => request<SkillProposal[]>('/v1/skill-proposals'),

  approveSkillProposal: (id: string) => request<Skill>(`/v1/skill-proposals/${id}/approve`, { method: 'POST' }),

  rejectSkillProposal: (id: string) =>
    request<{ status: string; proposalId: string }>(`/v1/skill-proposals/${id}/reject`, { method: 'POST' }),

  listMarketplacePlugins: () => request<{ plugins: MarketplacePlugin[]; total: number }>('/v1/marketplace/plugins'),

  listMarketplaceSkills: () => request<{ skills: MarketplaceSkillListing[]; total: number }>('/v1/marketplace/skills'),

  installMarketplacePlugin: (pluginId: string, opts?: { acknowledgePermissionDiff?: boolean }) =>
    request<{ installId: string; pluginId: string; version: string; isActive: boolean }>(
      `/v1/marketplace/plugins/${pluginId}/install`,
      { method: 'POST', body: JSON.stringify(opts ?? {}) },
    ),

  installMarketplaceSkill: (skillId: string) =>
    request<{ install: { installId: string }; skill: Skill }>(`/v1/marketplace/skills/${skillId}/install`, {
      method: 'POST',
    }),

  updateMarketplaceInstallConfig: (installId: string, config: Record<string, unknown>) =>
    request<{ installId: string; config: Record<string, unknown> }>(
      `/v1/marketplace/installs/${installId}/config`,
      { method: 'PATCH', body: JSON.stringify({ config }) },
    ),

  rateMarketplacePlugin: (pluginId: string, rating: number, review?: string) =>
    request<{ pluginId: string; rating: number }>(`/v1/marketplace/plugins/${pluginId}/rate`, {
      method: 'POST',
      body: JSON.stringify({ rating, review }),
    }),

  rateMarketplaceSkill: (skillId: string, rating: number, review?: string) =>
    request<{ skillId: string; rating: number }>(`/v1/marketplace/skills/${skillId}/rate`, {
      method: 'POST',
      body: JSON.stringify({ rating, review }),
    }),

  listPublisherPlugins: (publisherSlug: string) =>
    request<{ plugins: PublisherPlugin[]; total: number }>(
      `/v1/marketplace/publisher/plugins?publisherSlug=${encodeURIComponent(publisherSlug)}`,
    ),

  submitPublisherPlugin: (input: {
    publisherSlug: string;
    publisherDisplayName: string;
    packageName: string;
    name: string;
    description?: string | undefined;
    version: string;
    manifest: Record<string, unknown>;
    permissions?: string[] | undefined;
  }) => request<{ pluginId: string; versionId: string }>('/v1/marketplace/publisher/plugins', { method: 'POST', body: JSON.stringify(input) }),

  listPublisherSkills: (publisherSlug: string) =>
    request<{ skills: PublisherSkill[]; total: number }>(
      `/v1/marketplace/publisher/skills?publisherSlug=${encodeURIComponent(publisherSlug)}`,
    ),

  submitPublisherSkill: (input: {
    publisherSlug: string;
    publisherDisplayName: string;
    skillSlug: string;
    name: string;
    description?: string | undefined;
    definition: Record<string, unknown>;
    priceCents?: number | undefined;
  }) => request<{ skillId: string }>('/v1/marketplace/publisher/skills', { method: 'POST', body: JSON.stringify(input) }),

  getOrganization: () => request<Organization>('/v1/organization'),

  updateOrganization: (input: { name?: string; settings?: Record<string, unknown> }) =>
    request<Organization>('/v1/organization', { method: 'PATCH', body: JSON.stringify(input) }),

  listInvitations: () => request<Invitation[]>('/v1/invitations'),

  createInvitation: (input: { email: string; role: string; workspaceId?: string | undefined }) =>
    request<Invitation>('/v1/invitations', { method: 'POST', body: JSON.stringify(input) }),

  revokeInvitation: (id: string) => request<void>(`/v1/invitations/${id}`, { method: 'DELETE' }),

  acceptInvitation: (token: string, input: { name: string; password: string }) =>
    request<Session>(`/v1/auth/invitations/${token}/accept`, { method: 'POST', body: JSON.stringify(input) }),

  listPendingApprovals: () => request<ApprovalQueueEntry[]>('/v1/approvals/pending'),

  approveApproval: (id: string) => request<unknown>(`/v1/approvals/${id}/approve`, { method: 'POST' }),

  rejectApproval: (id: string) =>
    request<{ status: string; approvalId: string }>(`/v1/approvals/${id}/reject`, { method: 'POST' }),

  getWallet: () =>
    request<{ balanceCredits: number; status: 'active' | 'suspended'; initialized?: boolean }>('/v1/wallet'),

  creditWallet: (input: { amountCredits: number; reason: string }) =>
    request<{ balanceCredits: number }>('/v1/wallet/credit', { method: 'POST', body: JSON.stringify(input) }),

  listWorkflows: () => request<Workflow[]>('/v1/workflows'),

  createWorkflow: (input: { name: string; description?: string | undefined; definition: WorkflowDefinition }) =>
    request<Workflow>('/v1/workflows', { method: 'POST', body: JSON.stringify(input) }),

  getWorkflow: (id: string) => request<Workflow>(`/v1/workflows/${id}`),

  listWorkflowRuns: (id: string) => request<WorkflowRun[]>(`/v1/workflows/${id}/runs`),

  runWorkflow: (id: string) => request<WorkflowRun>(`/v1/workflows/${id}/run`, { method: 'POST' }),

  getWorkflowRun: (id: string) => request<WorkflowRun>(`/v1/workflow-runs/${id}`),
};
