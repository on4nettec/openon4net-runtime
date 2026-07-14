'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, loadSession, ApiError, type Workflow, type WorkflowRun } from '@/lib/api-client';

const EXAMPLE_DEFINITION = JSON.stringify(
  {
    steps: [
      { id: 'step-1', type: 'agent', agentRole: 'support', prompt: 'Summarize the latest activity.' },
      { id: 'step-2', type: 'tool', tool: 'webhook-send', params: { url: 'https://example.com', payload: {} } },
    ],
  },
  null,
  2,
);

export default function WorkflowsPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [definitionText, setDefinitionText] = useState(EXAMPLE_DEFINITION);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [runsOpenId, setRunsOpenId] = useState<string | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [runsError, setRunsError] = useState<string | null>(null);

  function loadWorkflows() {
    return api
      .listWorkflows()
      .then(setWorkflows)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load workflows'));
  }

  useEffect(() => {
    const session = loadSession();
    if (!session) {
      router.push('/login');
      return;
    }
    setReady(true);
    void loadWorkflows();
  }, [router]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const definition = JSON.parse(definitionText);
      await api.createWorkflow({ name, description: description || undefined, definition });
      setName('');
      setDescription('');
      setDefinitionText(EXAMPLE_DEFINITION);
      await loadWorkflows();
    } catch (err) {
      setCreateError(
        err instanceof ApiError
          ? err.message
          : err instanceof SyntaxError
            ? `Invalid JSON: ${err.message}`
            : 'Failed to create workflow',
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleRun(workflow: Workflow) {
    setBusyId(workflow.id);
    setError(null);
    try {
      await api.runWorkflow(workflow.id);
      if (runsOpenId === workflow.id) await toggleRuns(workflow);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to run workflow');
    } finally {
      setBusyId(null);
    }
  }

  async function toggleRuns(workflow: Workflow) {
    if (runsOpenId === workflow.id) {
      setRunsOpenId(null);
      return;
    }
    setRunsError(null);
    setRunsOpenId(workflow.id);
    try {
      setRuns(await api.listWorkflowRuns(workflow.id));
    } catch (err) {
      setRunsError(err instanceof ApiError ? err.message : 'Failed to load runs');
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
          <Link href="/skills">Skills</Link>
          <Link href="/skill-proposals">Skill Proposals</Link>
          <Link href="/marketplace">Marketplace</Link>
          <Link href="/approvals">Approvals</Link>
          <strong>Workflows</strong>
          <Link href="/policies">Policies</Link>
          <Link href="/settings">Settings</Link>
        </nav>
      </div>

      <div className="page">
        <h1 style={{ fontSize: 20 }}>Workflows</h1>
        <p style={{ color: '#9aa0aa', fontSize: 14 }}>
          Multi-step orchestration across agents, tools, and human approvals. Steps run in order unless a{' '}
          <code>condition</code> step branches or a <code>parallel</code> step fans out. Manual run only in this
          version — no scheduled/event triggers yet.
        </p>

        {error ? <div className="error">{error}</div> : null}

        {!ready ? (
          <p>Loading…</p>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 16 }}>
              {workflows.length === 0 ? (
                <p style={{ color: '#9aa0aa', margin: 0 }}>No workflows yet — create one below.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {workflows.map((workflow) => {
                    const busy = busyId === workflow.id;
                    const runsOpen = runsOpenId === workflow.id;
                    return (
                      <div key={workflow.id} style={{ borderTop: '1px solid #2c3038', paddingTop: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div>
                            <strong>{workflow.name}</strong>{' '}
                            <span style={{ color: '#9aa0aa', fontSize: 12 }}>
                              {workflow.status} · {workflow.definition.steps.length} steps
                            </span>
                            {workflow.description ? (
                              <div style={{ color: '#9aa0aa', fontSize: 12 }}>{workflow.description}</div>
                            ) : null}
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button className="secondary" disabled={busy} onClick={() => handleRun(workflow)}>
                              {busy ? 'Running…' : 'Run'}
                            </button>
                            <button className="secondary" onClick={() => toggleRuns(workflow)}>
                              {runsOpen ? 'Hide runs' : 'Show runs'}
                            </button>
                          </div>
                        </div>

                        {runsOpen ? (
                          <div style={{ marginTop: 8 }}>
                            {runsError ? <div className="error">{runsError}</div> : null}
                            {runs.length === 0 ? (
                              <p style={{ color: '#9aa0aa', fontSize: 13, margin: 0 }}>No runs yet.</p>
                            ) : (
                              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                                <thead>
                                  <tr style={{ textAlign: 'left', color: '#9aa0aa', fontSize: 11 }}>
                                    <th style={{ paddingBottom: 6 }}>Started</th>
                                    <th style={{ paddingBottom: 6 }}>Status</th>
                                    <th style={{ paddingBottom: 6 }}>Current step</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {runs.map((run) => (
                                    <tr key={run.id} style={{ borderTop: '1px solid #2c3038' }}>
                                      <td style={{ padding: '4px 0' }}>
                                        {run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}
                                      </td>
                                      <td style={{ padding: '4px 0' }}>{run.status}</td>
                                      <td style={{ padding: '4px 0', color: '#9aa0aa' }}>{run.currentStepId ?? '—'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="card">
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Create a workflow</h2>
              <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {createError ? <div className="error">{createError}</div> : null}
                <label>
                  Name
                  <input value={name} onChange={(e) => setName(e.target.value)} required />
                </label>
                <label>
                  Description
                  <input value={description} onChange={(e) => setDescription(e.target.value)} />
                </label>
                <label>
                  Definition (JSON — steps array, see example)
                  <textarea
                    value={definitionText}
                    onChange={(e) => setDefinitionText(e.target.value)}
                    rows={12}
                    style={{ fontFamily: 'monospace', fontSize: 13, width: '100%' }}
                    required
                  />
                </label>
                <button type="submit" disabled={creating}>
                  {creating ? 'Creating…' : 'Create workflow'}
                </button>
              </form>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
