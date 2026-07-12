'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, loadSession, ApiError, type Skill, type SkillStep } from '@/lib/api-client';
import type { Agent } from '@o2n/shared';

type ToolType = SkillStep['tool'];

export default function SkillsPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [grantedSkillIds, setGrantedSkillIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creatorAgentId, setCreatorAgentId] = useState('');
  const [toolType, setToolType] = useState<ToolType>('webhook-send');
  const [url, setUrl] = useState('');
  const [chatId, setChatId] = useState('');
  const [message, setMessage] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function loadSkills() {
    return api
      .listSkills()
      .then(setSkills)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load skills'));
  }

  function loadGrantsForAgent(agentId: string) {
    if (!agentId) {
      setGrantedSkillIds(new Set());
      return;
    }
    api
      .listAgentSkillGrants(agentId)
      .then((grants) => setGrantedSkillIds(new Set(grants.map((g) => g.skillId))))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load grants'));
  }

  useEffect(() => {
    const session = loadSession();
    if (!session) {
      router.push('/login');
      return;
    }
    setReady(true);
    void loadSkills();
    api
      .listAgents()
      .then((list) => {
        setAgents(list);
        if (list[0]) {
          setSelectedAgentId(list[0].id);
          setCreatorAgentId(list[0].id);
        }
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load agents'));
  }, [router]);

  useEffect(() => {
    loadGrantsForAgent(selectedAgentId);
  }, [selectedAgentId]);

  async function handleGrantToggle(skill: Skill) {
    if (!selectedAgentId) return;
    setBusyId(skill.id);
    setError(null);
    try {
      if (grantedSkillIds.has(skill.id)) {
        await api.revokeSkill(selectedAgentId, skill.id);
      } else {
        await api.grantSkill(selectedAgentId, skill.id);
      }
      loadGrantsForAgent(selectedAgentId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update grant');
    } finally {
      setBusyId(null);
    }
  }

  async function handleExecute(skill: Skill) {
    if (!selectedAgentId) return;
    setBusyId(skill.id);
    setError(null);
    try {
      const result = await api.executeSkill(selectedAgentId, skill.id);
      window.alert(result.succeeded ? `Executed in ${result.durationMs}ms` : 'Execution failed');
      await loadSkills();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to execute skill');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(skill: Skill) {
    if (!window.confirm(`Delete skill "${skill.name}"?`)) return;
    setBusyId(skill.id);
    setError(null);
    try {
      await api.deleteSkill(skill.id);
      await loadSkills();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete skill');
    } finally {
      setBusyId(null);
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const step: SkillStep =
        toolType === 'webhook-send'
          ? { id: 'step-1', type: 'tool', tool: 'webhook-send', params: { url, payload: {} } }
          : { id: 'step-1', type: 'tool', tool: 'telegram-send', params: { chatId, message } };

      await api.createSkill({
        agentId: creatorAgentId,
        name,
        ...(description ? { description } : {}),
        definition: { trigger: { type: 'manual' }, steps: [step] },
      });
      setName('');
      setDescription('');
      setUrl('');
      setChatId('');
      setMessage('');
      await loadSkills();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Failed to create skill');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div className="topbar">
        <Link href="/agents">← Agents</Link>
        <nav>
          <Link href="/workspaces">Workspaces</Link>
          <Link href="/users">Users</Link>
          <Link href="/roles">Roles & Permissions</Link>
          <Link href="/audit">Audit Log</Link>
          <strong>Skills</strong>
          <Link href="/skill-proposals">Skill Proposals</Link>
          <Link href="/marketplace">Marketplace</Link>
          <Link href="/policies">Policies</Link>
          <Link href="/settings">Settings</Link>
        </nav>
      </div>

      <div className="page">
        <h1 style={{ fontSize: 20 }}>Skills</h1>
        <p style={{ color: '#9aa0aa', fontSize: 14 }}>
          A Skill is a recorded sequence of tool steps an agent can replay on demand. Grants control which
          agents may use a given Skill.
        </p>

        {error ? <div className="error">{error}</div> : null}

        {!ready ? (
          <p>Loading…</p>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 16 }}>
              <label>
                Viewing grants for agent
                <select value={selectedAgentId} onChange={(e) => setSelectedAgentId(e.target.value)}>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="card" style={{ marginBottom: 16 }}>
              {skills.length === 0 ? (
                <p style={{ color: '#9aa0aa', margin: 0 }}>No skills yet — create one below.</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: '#9aa0aa', fontSize: 12 }}>
                      <th style={{ paddingBottom: 8 }}>Name</th>
                      <th style={{ paddingBottom: 8 }}>Source</th>
                      <th style={{ paddingBottom: 8 }}>Executions</th>
                      <th style={{ paddingBottom: 8 }}>Success rate</th>
                      <th style={{ paddingBottom: 8 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {skills.map((skill) => {
                      const busy = busyId === skill.id;
                      const granted = grantedSkillIds.has(skill.id);
                      return (
                        <tr key={skill.id} style={{ borderTop: '1px solid #2c3038' }}>
                          <td style={{ padding: '8px 0' }}>{skill.name}</td>
                          <td style={{ padding: '8px 0', color: '#9aa0aa' }}>{skill.source}</td>
                          <td style={{ padding: '8px 0' }}>{skill.executionCount}</td>
                          <td style={{ padding: '8px 0' }}>{skill.successRate}%</td>
                          <td style={{ padding: '8px 0', display: 'flex', gap: 8 }}>
                            <button className="secondary" disabled={busy || !selectedAgentId} onClick={() => handleGrantToggle(skill)}>
                              {granted ? 'Revoke' : 'Grant'}
                            </button>
                            <button className="secondary" disabled={busy || !granted} onClick={() => handleExecute(skill)}>
                              Execute
                            </button>
                            <button className="secondary" disabled={busy} onClick={() => handleDelete(skill)}>
                              Delete
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <div className="card">
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Create a skill</h2>
              <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {createError ? <div className="error">{createError}</div> : null}
                <label>
                  Name
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Send status webhook" required />
                </label>
                <label>
                  Description
                  <input value={description} onChange={(e) => setDescription(e.target.value)} />
                </label>
                <label>
                  Owning agent
                  <select value={creatorAgentId} onChange={(e) => setCreatorAgentId(e.target.value)}>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Step type
                  <select value={toolType} onChange={(e) => setToolType(e.target.value as ToolType)}>
                    <option value="webhook-send">Webhook</option>
                    <option value="telegram-send">Telegram message</option>
                  </select>
                </label>
                {toolType === 'webhook-send' ? (
                  <label>
                    URL
                    <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." required />
                  </label>
                ) : (
                  <div style={{ display: 'flex', gap: 10 }}>
                    <label style={{ flex: 1 }}>
                      Chat ID
                      <input value={chatId} onChange={(e) => setChatId(e.target.value)} required />
                    </label>
                    <label style={{ flex: 2 }}>
                      Message
                      <input value={message} onChange={(e) => setMessage(e.target.value)} required />
                    </label>
                  </div>
                )}
                <button type="submit" disabled={creating}>
                  {creating ? 'Creating…' : 'Create skill'}
                </button>
              </form>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
