'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Agent } from '@o2n/shared';
import { api, loadSession, ApiError, type WebhookEndpoint, type Workflow } from '@/lib/api-client';

export default function WebhooksPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [targetType, setTargetType] = useState<'workflow' | 'agent'>('workflow');
  const [targetId, setTargetId] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<{ endpointId: string; token: string; webhookUrl: string } | null>(null);

  function loadAll() {
    return Promise.all([api.listWebhooks(), api.listWorkflows(), api.listAgents()])
      .then(([w, wf, a]) => {
        setEndpoints(w);
        setWorkflows(wf);
        setAgents(a);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load webhooks'));
  }

  useEffect(() => {
    const session = loadSession();
    if (!session) {
      router.push('/login');
      return;
    }
    setReady(true);
    void loadAll();
  }, [router]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!targetId) {
      setCreateError('Choose a target');
      return;
    }
    setCreating(true);
    setCreateError(null);
    setNewToken(null);
    try {
      const created = await api.createWebhook({ name, targetType, targetId });
      const base = typeof window !== 'undefined' ? window.location.origin : '';
      setNewToken({ endpointId: created.id, token: created.token, webhookUrl: `${base}/v1/webhooks/${created.token}` });
      setName('');
      setTargetId('');
      await loadAll();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Failed to create webhook');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await api.deleteWebhook(id);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete webhook');
    }
  }

  function targetLabel(endpoint: WebhookEndpoint): string {
    if (endpoint.targetType === 'workflow') {
      return workflows.find((w) => w.id === endpoint.targetId)?.name ?? endpoint.targetId;
    }
    return agents.find((a) => a.id === endpoint.targetId)?.name ?? endpoint.targetId;
  }

  return (
    <div>
      <div className="topbar">
        <Link href="/workflows">← Workflows</Link>
        <nav>
          <strong>Webhooks</strong>
        </nav>
      </div>

      <div className="page">
        <h1 style={{ fontSize: 20 }}>Webhooks</h1>
        <p style={{ color: '#9aa0aa', fontSize: 14 }}>
          Inbound webhooks (RT-065). POSTing to an endpoint&apos;s URL starts the target workflow, or sends the
          request body as a chat message to the target agent. The token in the URL is the only credential — treat it
          like a password. Shown once at creation time; it can&apos;t be recovered afterward, only rotated by
          deleting and recreating the endpoint.
        </p>

        {error ? <div className="error">{error}</div> : null}

        {!ready ? (
          <p>Loading…</p>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 16 }}>
              {endpoints.length === 0 ? (
                <p style={{ color: '#9aa0aa', margin: 0 }}>No webhook endpoints yet — create one below.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {endpoints.map((endpoint) => (
                    <div
                      key={endpoint.id}
                      style={{
                        borderTop: '1px solid #2c3038',
                        paddingTop: 10,
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <div>
                        <strong>{endpoint.name}</strong>{' '}
                        <span style={{ color: '#9aa0aa', fontSize: 12 }}>
                          → {endpoint.targetType} · {targetLabel(endpoint)}
                        </span>
                        <div style={{ color: '#9aa0aa', fontSize: 12 }}>
                          {endpoint.lastTriggeredAt
                            ? `Last triggered ${new Date(endpoint.lastTriggeredAt).toLocaleString()}`
                            : 'Never triggered'}
                        </div>
                      </div>
                      <button className="secondary" onClick={() => handleDelete(endpoint.id)}>
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {newToken ? (
              <div className="card" style={{ marginBottom: 16, borderColor: '#4caf7d' }}>
                <strong>Webhook created — copy this URL now, it won&apos;t be shown again:</strong>
                <div style={{ fontFamily: 'monospace', fontSize: 12, marginTop: 6, wordBreak: 'break-all' }}>
                  {newToken.webhookUrl}
                </div>
              </div>
            ) : null}

            <div className="card">
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Create a webhook endpoint</h2>
              <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {createError ? <div className="error">{createError}</div> : null}
                <label>
                  Name
                  <input value={name} onChange={(e) => setName(e.target.value)} required />
                </label>
                <label>
                  Target type
                  <select
                    value={targetType}
                    onChange={(e) => {
                      setTargetType(e.target.value as 'workflow' | 'agent');
                      setTargetId('');
                    }}
                  >
                    <option value="workflow">Workflow</option>
                    <option value="agent">Agent</option>
                  </select>
                </label>
                <label>
                  Target
                  <select value={targetId} onChange={(e) => setTargetId(e.target.value)} required>
                    <option value="">Select…</option>
                    {(targetType === 'workflow' ? workflows : agents).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" disabled={creating}>
                  {creating ? 'Creating…' : 'Create webhook'}
                </button>
              </form>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
