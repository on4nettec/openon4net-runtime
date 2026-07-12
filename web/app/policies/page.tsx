'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, loadSession, ApiError } from '@/lib/api-client';

type ConditionType = 'cost_gt_cents' | 'outside_hours';

interface Policy {
  id: string;
  name: string;
  condition:
    | { type: 'cost_gt_cents'; value: number }
    | { type: 'outside_hours'; startHour: number; endHour: number };
  isActive: boolean;
  createdAt: string;
}

function describeCondition(condition: Policy['condition']): string {
  if (condition.type === 'cost_gt_cents') {
    return `estimated cost > ${condition.value}¢`;
  }
  return `outside ${condition.startHour}:00–${condition.endHour}:00 UTC`;
}

export default function PoliciesPage() {
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [conditionType, setConditionType] = useState<ConditionType>('cost_gt_cents');
  const [costValue, setCostValue] = useState(2000);
  const [startHour, setStartHour] = useState(9);
  const [endHour, setEndHour] = useState(18);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function loadPolicies() {
    return api
      .listPolicies()
      .then(setPolicies)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load policies'));
  }

  useEffect(() => {
    const session = loadSession();
    if (!session) {
      router.push('/login');
      return;
    }
    const admin = session.role === 'admin';
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
          : ({ type: 'outside_hours', startHour, endHour } as const);
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
      <div className="topbar">
        <Link href="/agents">← Agents</Link>
        <nav>
          <strong>Policies</strong>
          <Link href="/workspaces">Workspaces</Link>
          <Link href="/users">Users</Link>
          <Link href="/roles">Roles & Permissions</Link>
          <Link href="/skills">Skills</Link>
          <Link href="/skill-proposals">Skill Proposals</Link>
          <Link href="/marketplace">Marketplace</Link>
          <Link href="/audit">Audit Log</Link>
          <Link href="/settings">Settings</Link>
        </nav>
      </div>

      <div className="page">
        <h1 style={{ fontSize: 20 }}>Policies</h1>
        <p style={{ color: '#9aa0aa', fontSize: 14 }}>
          When any active policy matches a chat request, it requires human approval — same queue as the
          org-wide cost threshold in Settings, just with more specific rules.
        </p>

        {error ? <div className="error">{error}</div> : null}

        {isAdmin === false ? (
          <p style={{ color: '#9aa0aa' }}>Only organization admins can view or manage policies.</p>
        ) : isAdmin === null ? (
          <p>Loading…</p>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 16 }}>
              {policies.length === 0 ? (
                <p style={{ color: '#9aa0aa', margin: 0 }}>No policies yet — every chat only goes through the org-wide cost threshold.</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: '#9aa0aa', fontSize: 12 }}>
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
                        <tr key={p.id} style={{ borderTop: '1px solid #2c3038' }}>
                          <td style={{ padding: '8px 0' }}>{p.name}</td>
                          <td style={{ padding: '8px 0', color: '#9aa0aa' }}>{describeCondition(p.condition)}</td>
                          <td style={{ padding: '8px 0' }}>
                            <span style={{ color: p.isActive ? '#4caf7d' : '#9aa0aa' }}>
                              {p.isActive ? 'Active' : 'Inactive'}
                            </span>
                          </td>
                          <td style={{ padding: '8px 0', display: 'flex', gap: 8 }}>
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
                ) : (
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
