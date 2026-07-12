'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Agent, User, Workspace } from '@o2n/shared';
import { api, loadSession, clearSession, ApiError, type Session } from '@/lib/api-client';

type AccessRole = 'owner' | 'member' | 'viewer';
interface AgentAccessBinding {
  id: string;
  agentId: string;
  userId: string;
  userEmail: string;
  userName: string;
  accessRole: AccessRole;
  grantedByUserId: string | null;
  createdAt: string;
}

export default function AgentsPage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [creating, setCreating] = useState(false);
  const [actioningId, setActioningId] = useState<string | null>(null);

  const [scheduleOpenId, setScheduleOpenId] = useState<string | null>(null);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleInterval, setScheduleInterval] = useState(60);
  const [schedulePrompt, setSchedulePrompt] = useState('');
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const [accessOpenId, setAccessOpenId] = useState<string | null>(null);
  const [accessBindings, setAccessBindings] = useState<AgentAccessBinding[]>([]);
  const [orgUsers, setOrgUsers] = useState<User[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedAccessRole, setSelectedAccessRole] = useState<AccessRole>('member');
  const [savingAccess, setSavingAccess] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);

  useEffect(() => {
    const s = loadSession();
    if (!s) {
      router.push('/login');
      return;
    }
    setSession(s);
    setWorkspaceId(s.workspaceId);
    void refresh();
    // Best-effort: viewer/editor roles without workspaces:read just keep
    // using the session's default workspace, no picker shown.
    api
      .listWorkspaces()
      .then(setWorkspaces)
      .catch(() => {});
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
      await api.createAgent({ name, role, workspaceId: workspaceId || s.workspaceId });
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

  function toggleSchedule(agent: Agent) {
    if (scheduleOpenId === agent.id) {
      setScheduleOpenId(null);
      return;
    }
    const s = agent.schedule as { enabled?: boolean; intervalMinutes?: number; prompt?: string };
    setScheduleEnabled(s.enabled ?? false);
    setScheduleInterval(s.intervalMinutes ?? 60);
    setSchedulePrompt(s.prompt ?? '');
    setScheduleError(null);
    setScheduleOpenId(agent.id);
  }

  async function handleSaveSchedule(agentId: string) {
    setSavingSchedule(true);
    setScheduleError(null);
    try {
      await api.updateAgentSchedule(agentId, {
        enabled: scheduleEnabled,
        intervalMinutes: scheduleInterval,
        prompt: schedulePrompt,
      });
      setScheduleOpenId(null);
      await refresh();
    } catch (err) {
      setScheduleError(err instanceof ApiError ? err.message : 'Failed to save schedule');
    } finally {
      setSavingSchedule(false);
    }
  }

  async function toggleAccess(agent: Agent) {
    if (accessOpenId === agent.id) {
      setAccessOpenId(null);
      return;
    }
    setAccessError(null);
    setAccessOpenId(agent.id);
    try {
      if (orgUsers.length === 0) setOrgUsers(await api.listUsers());
      setAccessBindings(await api.listAgentAccess(agent.id));
    } catch (err) {
      setAccessError(err instanceof ApiError ? err.message : 'Failed to load access list');
    }
  }

  async function handleGrantAccess(agentId: string) {
    if (!selectedUserId) return;
    setSavingAccess(true);
    setAccessError(null);
    try {
      await api.grantAgentAccess(agentId, selectedUserId, selectedAccessRole);
      setAccessBindings(await api.listAgentAccess(agentId));
      setSelectedUserId('');
    } catch (err) {
      setAccessError(err instanceof ApiError ? err.message : 'Failed to grant access');
    } finally {
      setSavingAccess(false);
    }
  }

  async function handleRevokeAccess(agentId: string, userId: string) {
    setSavingAccess(true);
    setAccessError(null);
    try {
      await api.revokeAgentAccess(agentId, userId);
      setAccessBindings(await api.listAgentAccess(agentId));
    } catch (err) {
      setAccessError(err instanceof ApiError ? err.message : 'Failed to revoke access');
    } finally {
      setSavingAccess(false);
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
          <Link href="/skills">Skills</Link>
          <Link href="/skill-proposals">Skill Proposals</Link>
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
            {workspaces.length > 1 ? (
              <div className="field">
                <label htmlFor="workspace">Workspace</label>
                <select id="workspace" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
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
              const scheduleOpen = scheduleOpenId === agent.id;
              const accessOpen = accessOpenId === agent.id;
              const agentScheduleInfo = agent.schedule as { enabled?: boolean; intervalMinutes?: number };
              return (
                <div key={agent.id} className="card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Link href={`/agents/${agent.id}/chat`} style={{ textDecoration: 'none' }}>
                      <div style={{ fontWeight: 600 }}>{agent.name}</div>
                      <div style={{ color: '#9aa0aa', fontSize: 13 }}>{agent.role}</div>
                      <BudgetBar usedCents={agent.usedBudgetCents} limitCents={agent.monthlyBudgetCents} />
                      {agentScheduleInfo.enabled ? (
                        <div style={{ color: '#4caf7d', fontSize: 11, marginTop: 4 }}>
                          ⏱ every {agentScheduleInfo.intervalMinutes}m
                        </div>
                      ) : null}
                    </Link>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ color: '#9aa0aa', fontSize: 13 }}>{agent.status}</span>
                      <button className="secondary" onClick={() => toggleSchedule(agent)}>
                        {scheduleOpen ? 'Cancel' : 'Schedule'}
                      </button>
                      {session.role === 'admin' ? (
                        <button className="secondary" onClick={() => toggleAccess(agent)}>
                          {accessOpen ? 'Cancel' : 'Access'}
                        </button>
                      ) : null}
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

                  {scheduleOpen ? (
                    <div style={{ borderTop: '1px solid #2c3038', marginTop: 12, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {scheduleError ? <div className="error">{scheduleError}</div> : null}
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={scheduleEnabled}
                          onChange={(e) => setScheduleEnabled(e.target.checked)}
                        />
                        Enabled — run this agent automatically on a timer
                      </label>
                      <label>
                        Interval (minutes)
                        <input
                          type="number"
                          min={1}
                          value={scheduleInterval}
                          onChange={(e) => setScheduleInterval(Number(e.target.value))}
                        />
                      </label>
                      <label>
                        Prompt (sent to the agent as if a user typed it)
                        <input
                          value={schedulePrompt}
                          onChange={(e) => setSchedulePrompt(e.target.value)}
                          placeholder="e.g. Summarize any new activity and flag anything urgent."
                        />
                      </label>
                      <button
                        onClick={() => handleSaveSchedule(agent.id)}
                        disabled={savingSchedule || (scheduleEnabled && !schedulePrompt.trim())}
                      >
                        {savingSchedule ? 'Saving…' : 'Save schedule'}
                      </button>
                    </div>
                  ) : null}

                  {accessOpen ? (
                    <div style={{ borderTop: '1px solid #2c3038', marginTop: 12, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {accessError ? <div className="error">{accessError}</div> : null}
                      <div style={{ color: '#9aa0aa', fontSize: 12 }}>
                        Who besides admins can see and use this agent:
                      </div>
                      {accessBindings.length === 0 ? (
                        <div style={{ color: '#9aa0aa', fontSize: 13 }}>No one granted yet.</div>
                      ) : (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                          <tbody>
                            {accessBindings.map((b) => (
                              <tr key={b.id} style={{ borderTop: '1px solid #2c3038' }}>
                                <td style={{ padding: '6px 0' }}>{b.userName}</td>
                                <td style={{ padding: '6px 0', color: '#9aa0aa' }}>{b.userEmail}</td>
                                <td style={{ padding: '6px 0', color: '#9aa0aa' }}>{b.accessRole}</td>
                                <td style={{ padding: '6px 0' }}>
                                  <button
                                    className="secondary"
                                    disabled={savingAccess}
                                    onClick={() => handleRevokeAccess(agent.id, b.userId)}
                                  >
                                    Revoke
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)}>
                          <option value="">Select a user…</option>
                          {orgUsers
                            .filter((u) => !accessBindings.some((b) => b.userId === u.id))
                            .map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.name} ({u.email})
                              </option>
                            ))}
                        </select>
                        <select
                          value={selectedAccessRole}
                          onChange={(e) => setSelectedAccessRole(e.target.value as AccessRole)}
                        >
                          <option value="viewer">viewer</option>
                          <option value="member">member</option>
                          <option value="owner">owner</option>
                        </select>
                        <button disabled={!selectedUserId || savingAccess} onClick={() => handleGrantAccess(agent.id)}>
                          {savingAccess ? 'Saving…' : 'Grant'}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function BudgetBar({ usedCents, limitCents }: { usedCents: number; limitCents: number }) {
  const pct = limitCents > 0 ? Math.min((usedCents / limitCents) * 100, 100) : 0;
  const color = pct >= 90 ? '#f2555a' : pct >= 70 ? '#e0a83b' : '#3b6fe0';
  return (
    <div style={{ marginTop: 6, width: 160 }}>
      <div style={{ height: 4, background: '#2c3038', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color }} />
      </div>
      <div style={{ color: '#9aa0aa', fontSize: 11, marginTop: 3 }}>
        {formatCents(usedCents)} / {formatCents(limitCents)}
      </div>
    </div>
  );
}
