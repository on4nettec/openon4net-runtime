'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Agent } from '@o2n/shared';
import { api, loadSession, clearSession, ApiError, type Session } from '@/lib/api-client';

export default function AgentsPage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [creating, setCreating] = useState(false);
  const [actioningId, setActioningId] = useState<string | null>(null);

  useEffect(() => {
    const s = loadSession();
    if (!s) {
      router.push('/login');
      return;
    }
    setSession(s);
    void refresh();
  }, [router]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setAgents(await api.listAgents());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load agents');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const s = loadSession();
      if (!s) throw new Error('No session');
      await api.createAgent({ name, role, workspaceId: s.workspaceId });
      setName('');
      setRole('');
      setShowCreate(false);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create agent');
    } finally {
      setCreating(false);
    }
  }

  function handleLogout() {
    clearSession();
    router.push('/login');
  }

  async function handlePause(agentId: string) {
    setActioningId(agentId);
    setError(null);
    try {
      await api.pauseAgent(agentId);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to pause agent');
    } finally {
      setActioningId(null);
    }
  }

  async function handleResume(agentId: string) {
    setActioningId(agentId);
    setError(null);
    try {
      await api.resumeAgent(agentId);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to resume agent');
    } finally {
      setActioningId(null);
    }
  }

  async function handleTerminate(agentId: string, agentName: string) {
    if (!window.confirm(`Terminate "${agentName}"? This can't be undone from the UI.`)) return;
    setActioningId(agentId);
    setError(null);
    try {
      await api.terminateAgent(agentId);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to terminate agent');
    } finally {
      setActioningId(null);
    }
  }

  if (!session) return null;

  return (
    <div>
      <div className="topbar">
        <strong>{session.organizationName}</strong>
        <nav>
          <Link href="/agents">Agents</Link>
          <Link href="/settings">Settings</Link>
          <button className="secondary" onClick={handleLogout}>
            Sign out
          </button>
        </nav>
      </div>

      <div className="page">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>Digital Employees</h1>
          <button onClick={() => setShowCreate((v) => !v)}>{showCreate ? 'Cancel' : 'New agent'}</button>
        </div>

        {error ? <div className="error">{error}</div> : null}

        {showCreate ? (
          <form className="card" onSubmit={handleCreate} style={{ marginBottom: 20 }}>
            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="role">Role</label>
              <input
                id="role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="support, sales, ceo, ..."
                required
              />
            </div>
            <button type="submit" disabled={creating}>
              {creating ? 'Creating…' : 'Create agent'}
            </button>
          </form>
        ) : null}

        {loading ? (
          <p>Loading…</p>
        ) : agents.length === 0 ? (
          <p style={{ color: '#9aa0aa' }}>No agents yet — create one to get started.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {agents.map((agent) => {
              const busy = actioningId === agent.id;
              return (
                <div
                  key={agent.id}
                  className="card"
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <Link href={`/agents/${agent.id}/chat`} style={{ textDecoration: 'none' }}>
                    <div style={{ fontWeight: 600 }}>{agent.name}</div>
                    <div style={{ color: '#9aa0aa', fontSize: 13 }}>{agent.role}</div>
                  </Link>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ color: '#9aa0aa', fontSize: 13 }}>{agent.status}</span>
                    {agent.status === 'active' ? (
                      <button className="secondary" disabled={busy} onClick={() => handlePause(agent.id)}>
                        Pause
                      </button>
                    ) : agent.status === 'paused' ? (
                      <button className="secondary" disabled={busy} onClick={() => handleResume(agent.id)}>
                        Resume
                      </button>
                    ) : null}
                    {agent.status !== 'terminated' ? (
                      <button className="secondary" disabled={busy} onClick={() => handleTerminate(agent.id, agent.name)}>
                        Terminate
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
