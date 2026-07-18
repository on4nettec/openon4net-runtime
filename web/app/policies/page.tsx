'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api, loadSession, ApiError, type Session } from '@/lib/api-client';
import { Sidebar } from '@/components/Sidebar';

type ConditionType = 'cost_gt_cents' | 'outside_hours' | 'action_type_in';

interface Policy {
  id: string;
  name: string;
  condition:
    | { type: 'cost_gt_cents'; value: number }
    | { type: 'outside_hours'; startHour: number; endHour: number }
    | { type: 'action_type_in'; actionTypes: string[] };
  isActive: boolean;
  createdAt: string;
}

function describeCondition(condition: Policy['condition']): string {
  if (condition.type === 'cost_gt_cents') {
    return `estimated cost > ${condition.value}¢`;
  }
  if (condition.type === 'outside_hours') {
    return `outside ${condition.startHour}:00–${condition.endHour}:00 UTC`;
  }
  return `action in [${condition.actionTypes.join(', ')}]`;
}

export default function PoliciesPage() {
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [conditionType, setConditionType] = useState<ConditionType>('cost_gt_cents');
  const [costValue, setCostValue] = useState(2000);
  const [startHour, setStartHour] = useState(9);
  const [endHour, setEndHour] = useState(18);
  const [actionTypes, setActionTypes] = useState('tool-webhook-send');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function loadPolicies() {
    return api
      .listPolicies()
      .then(setPolicies)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load policies'));
  }

  useEffect(() => {
    const s = loadSession();
    if (!s) {
      router.push('/login');
      return;
    }
    setSession(s);
    const admin = s.role === 'admin';
    setIsAdmin(admin);
    if (admin) loadPolicies();
  }, [router]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const condition =
        conditionType === 'cost_gt_cents'
          ? ({ type: 'cost_gt_cents', value: costValue } as const)
          : conditionType === 'outside_hours'
            ? ({ type: 'outside_hours', startHour, endHour } as const)
            : ({
                type: 'action_type_in',
                actionTypes: actionTypes
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              } as const);
      await api.createPolicy({ name, condition });
      setName('');
      await loadPolicies();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Failed to create policy');
    } finally {
      setCreating(false);
    }
  }

  async function handleToggle(policy: Policy) {
    setTogglingId(policy.id);
    setError(null);
    try {
      await api.updatePolicy(policy.id, !policy.isActive);
      await loadPolicies();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update policy');
    } finally {
      setTogglingId(null);
    }
  }

  async function handleDelete(policy: Policy) {
    if (!window.confirm(`Delete policy "${policy.name}"?`)) return;
    setTogglingId(policy.id);
    setError(null);
    try {
      await api.deletePolicy(policy.id);
      await loadPolicies();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete policy');
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <div>
      {session ? <Sidebar session={session} /> : null}

      <div className="page">
        <h1 style={{ fontSize: 'var(--font-size-xl)' }}>Policies</h1>
        <p style={{ color: 'var(--color-muted-foreground)', fontSize: 14 }}>
          When any active policy matches a chat request, it requires human approval — same queue as the
          org-wide cost threshold in Settings, just with more specific rules.
        </p>

        {error ? <div className="error">{error}</div> : null}

        {isAdmin === false ? (
          <p style={{ color: 'var(--color-muted-foreground)' }}>Only organization admins can view or manage policies.</p>
        ) : isAdmin === null ? (
          <p>Loading…</p>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 16 }}>
              {policies.length === 0 ? (
                <p style={{ color: 'var(--color-muted-foreground)', margin: 0 }}>No policies yet — every chat only goes through the org-wide cost threshold.</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--color-muted-foreground)', fontSize: 12 }}>
                      <th style={{ paddingBottom: 8 }}>Name</th>
                      <th style={{ paddingBottom: 8 }}>Condition</th>
                      <th style={{ paddingBottom: 8 }}>Status</th>
                      <th style={{ paddingBottom: 8 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {policies.map((p) => {
                      const busy = togglingId === p.id;
                      return (
                        <tr key={p.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                          <td style={{ padding: 'var(--space-2) var(--space-3) var(--space-2) 0' }}>{p.name}</td>
                          <td style={{ padding: 'var(--space-2) var(--space-3) var(--space-2) 0', color: 'var(--color-muted-foreground)' }}>{describeCondition(p.condition)}</td>
                          <td style={{ padding: 'var(--space-2) var(--space-3) var(--space-2) 0' }}>
                            <span style={{ color: p.isActive ? 'var(--color-success)' : 'var(--color-muted-foreground)' }}>
                              {p.isActive ? 'Active' : 'Inactive'}
                            </span>
                          </td>
                          <td style={{ padding: 'var(--space-2) var(--space-3) var(--space-2) 0', display: 'flex', gap: 8 }}>
                            <button className="secondary" disabled={busy} onClick={() => handleToggle(p)}>
                              {p.isActive ? 'Disable' : 'Enable'}
                            </button>
                            <button className="secondary" disabled={busy} onClick={() => handleDelete(p)}>
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
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Add a policy</h2>
              <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {createError ? <div className="error">{createError}</div> : null}
                <label>
                  Name
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Large spend review" required />
                </label>
                <label>
                  Condition type
                  <select value={conditionType} onChange={(e) => setConditionType(e.target.value as ConditionType)}>
                    <option value="cost_gt_cents">Estimated cost greater than…</option>
                    <option value="outside_hours">Outside business hours</option>
                    <option value="action_type_in">Specific action (tool call, etc.)</option>
                  </select>
                </label>
                {conditionType === 'cost_gt_cents' ? (
                  <label>
                    Cost threshold (cents)
                    <input
                      type="number"
                      min={1}
                      value={costValue}
                      onChange={(e) => setCostValue(Number(e.target.value))}
                    />
                  </label>
                ) : conditionType === 'outside_hours' ? (
                  <div style={{ display: 'flex', gap: 10 }}>
                    <label style={{ flex: 1 }}>
                      Start hour (UTC)
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={startHour}
                        onChange={(e) => setStartHour(Number(e.target.value))}
                      />
                    </label>
                    <label style={{ flex: 1 }}>
                      End hour (UTC)
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={endHour}
                        onChange={(e) => setEndHour(Number(e.target.value))}
                      />
                    </label>
                  </div>
                ) : (
                  <label>
                    Action types (comma-separated)
                    <input
                      value={actionTypes}
                      onChange={(e) => setActionTypes(e.target.value)}
                      placeholder="tool-webhook-send, tool-telegram-send"
                    />
                    <span style={{ display: 'block', color: 'var(--color-muted-foreground)', fontSize: 12, marginTop: 4 }}>
                      Applies to direct tool calls only, not Workflow steps.
                    </span>
                  </label>
                )}
                <button type="submit" disabled={creating}>
                  {creating ? 'Adding…' : 'Add policy'}
                </button>
              </form>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
