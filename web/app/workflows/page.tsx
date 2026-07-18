'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, loadSession, ApiError, downloadJson, type Session, type Workflow, type WorkflowRun } from '@/lib/api-client';
import { TopBar } from '@/components/TopBar';

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
  const [session, setSession] = useState<Session | null>(null);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [definitionText, setDefinitionText] = useState(EXAMPLE_DEFINITION);
  const [triggerType, setTriggerType] = useState<'manual' | 'scheduled'>('manual');
  const [intervalMinutes, setIntervalMinutes] = useState(60);
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
    const s = loadSession();
    if (!s) {
      router.push('/login');
      return;
    }
    setSession(s);
    setReady(true);
    void loadWorkflows();
  }, [router]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const definition = JSON.parse(definitionText);
      const trigger: { type: 'manual' } | { type: 'scheduled'; intervalMinutes: number } =
        triggerType === 'scheduled' ? { type: 'scheduled', intervalMinutes } : { type: 'manual' };
      await api.createWorkflow({ name, description: description || undefined, definition, trigger });
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

  async function handleExport(workflow: Workflow) {
    setError(null);
    try {
      const exported = await api.exportWorkflow(workflow.id);
      downloadJson(`${workflow.name.replace(/\s+/g, '-').toLowerCase()}.json`, exported);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to export workflow');
    }
  }

  function handleImportPaste() {
    try {
      const parsed = JSON.parse(definitionText);
      if (parsed.definition && parsed.name) {
        setName(parsed.name);
        setDescription(parsed.description ?? '');
        setDefinitionText(JSON.stringify(parsed.definition, null, 2));
      }
    } catch {
      // not a full export blob — leave as-is, it may just be a plain definition
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
      {session ? <TopBar session={session} /> : null}

      <div className="page">
        <h1 style={{ fontSize: 'var(--font-size-xl)' }}>Workflows</h1>
        <p style={{ color: 'var(--color-muted-foreground)', fontSize: 14 }}>
          Multi-step orchestration across agents, tools, and human approvals. Steps run in order unless a{' '}
          <code>condition</code> step branches or a <code>parallel</code> step fans out. Runs manually, on a
          schedule, or via an inbound webhook (see <Link href="/webhooks">Webhooks</Link>).
        </p>

        {error ? <div className="error">{error}</div> : null}

        {!ready ? (
          <p>Loading…</p>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 16 }}>
              {workflows.length === 0 ? (
                <p style={{ color: 'var(--color-muted-foreground)', margin: 0 }}>No workflows yet — create one below.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {workflows.map((workflow) => {
                    const busy = busyId === workflow.id;
                    const runsOpen = runsOpenId === workflow.id;
                    return (
                      <div key={workflow.id} style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div>
                            <strong>{workflow.name}</strong>{' '}
                            <span style={{ color: 'var(--color-muted-foreground)', fontSize: 12 }}>
                              {workflow.status} · {workflow.definition.steps.length} steps ·{' '}
                              {workflow.trigger.type === 'scheduled'
                                ? `every ${workflow.trigger.intervalMinutes}m`
                                : workflow.trigger.type}
                            </span>
                            {workflow.description ? (
                              <div style={{ color: 'var(--color-muted-foreground)', fontSize: 12 }}>{workflow.description}</div>
                            ) : null}
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button className="secondary" disabled={busy} onClick={() => handleRun(workflow)}>
                              {busy ? 'Running…' : 'Run'}
                            </button>
                            <button className="secondary" onClick={() => toggleRuns(workflow)}>
                              {runsOpen ? 'Hide runs' : 'Show runs'}
                            </button>
                            <button className="secondary" onClick={() => handleExport(workflow)}>
                              Export
                            </button>
                          </div>
                        </div>

                        {runsOpen ? (
                          <div style={{ marginTop: 8 }}>
                            {runsError ? <div className="error">{runsError}</div> : null}
                            {runs.length === 0 ? (
                              <p style={{ color: 'var(--color-muted-foreground)', fontSize: 13, margin: 0 }}>No runs yet.</p>
                            ) : (
                              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                                <thead>
                                  <tr style={{ textAlign: 'left', color: 'var(--color-muted-foreground)', fontSize: 11 }}>
                                    <th style={{ paddingBottom: 6 }}>Started</th>
                                    <th style={{ paddingBottom: 6 }}>Status</th>
                                    <th style={{ paddingBottom: 6 }}>Current step</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {runs.map((run) => (
                                    <tr key={run.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                                      <td style={{ padding: '4px 0' }}>
                                        {run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}
                                      </td>
                                      <td style={{ padding: '4px 0' }}>{run.status}</td>
                                      <td style={{ padding: '4px 0', color: 'var(--color-muted-foreground)' }}>{run.currentStepId ?? '—'}</td>
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
                  Definition (JSON — steps array, see example). Paste a full exported{' '}
                  <code>{'{name, description, definition}'}</code> blob here, then click &quot;Fill from paste&quot;
                  to import it.
                  <textarea
                    value={definitionText}
                    onChange={(e) => setDefinitionText(e.target.value)}
                    rows={12}
                    style={{ fontFamily: 'monospace', fontSize: 13, width: '100%' }}
                    required
                  />
                </label>
                <button type="button" className="secondary" onClick={handleImportPaste}>
                  Fill from paste
                </button>
                <label>
                  Trigger
                  <select value={triggerType} onChange={(e) => setTriggerType(e.target.value as 'manual' | 'scheduled')}>
                    <option value="manual">Manual only</option>
                    <option value="scheduled">Scheduled</option>
                  </select>
                </label>
                {triggerType === 'scheduled' ? (
                  <label>
                    Interval (minutes)
                    <input
                      type="number"
                      min={1}
                      value={intervalMinutes}
                      onChange={(e) => setIntervalMinutes(Number(e.target.value))}
                    />
                  </label>
                ) : null}
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
