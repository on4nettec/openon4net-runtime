'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Agent } from '@o2n/shared';
import { api, loadSession, ApiError, type Session } from '@/lib/api-client';
import { Sidebar } from '@/components/Sidebar';

interface AuditLogRow {
  id: string;
  createdAt: string;
  actionType: string;
  agentId: string | null;
  status: string;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function DashboardPage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [wallet, setWallet] = useState<{ balanceCredits: number; initialized?: boolean } | null>(null);
  const [recentLogs, setRecentLogs] = useState<AuditLogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const s = loadSession();
    if (!s) {
      router.push('/login');
      return;
    }
    setSession(s);

    Promise.all([
      api.listAgents(),
      // Best-effort — a non-admin or a role without approvals:read/billing:wallet:read
      // just sees those widgets as empty rather than the whole dashboard failing.
      api.listPendingApprovals().catch(() => []),
      api.getWallet().catch(() => null),
      api.getAuditLogs({ limit: 8 }).catch(() => ({ logs: [], total: 0 })),
    ])
      .then(([agentsResult, approvalsResult, walletResult, auditResult]) => {
        setAgents(agentsResult);
        setPendingApprovals(approvalsResult.length);
        setWallet(walletResult);
        setRecentLogs(auditResult.logs);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load dashboard'))
      .finally(() => setLoading(false));
  }, [router]);

  if (!session) return null;

  const activeCount = agents.filter((a) => a.status === 'active').length;
  const pausedCount = agents.filter((a) => a.status === 'paused').length;
  const totalUsedCents = agents.reduce((sum, a) => sum + a.usedBudgetCents, 0);
  const totalLimitCents = agents.reduce((sum, a) => sum + a.monthlyBudgetCents, 0);
  const budgetPct = totalLimitCents > 0 ? Math.min((totalUsedCents / totalLimitCents) * 100, 100) : 0;
  const agentsById = new Map(agents.map((a) => [a.id, a]));

  return (
    <div>
      <Sidebar session={session} />

      <div className="page-wide">
        <h1 style={{ fontSize: 'var(--font-size-xl)', marginBottom: 4 }}>Dashboard</h1>
        <p style={{ color: 'var(--color-muted-foreground)', fontSize: 14, marginTop: 0 }}>
          Overview across every Digital Employee in {session.organizationName}.
        </p>

        {error ? <div className="error">{error}</div> : null}

        {loading ? (
          <p>Loading…</p>
        ) : (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 16,
                marginBottom: 20,
              }}
            >
              <div className="card">
                <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Agents</div>
                <div style={{ fontSize: 28, fontWeight: 600 }}>{agents.length}</div>
                <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                  <span className="badge badge-success">{activeCount} active</span>
                  {pausedCount > 0 ? <span className="badge badge-warning">{pausedCount} paused</span> : null}
                </div>
              </div>

              <div className="card">
                <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Budget used this month</div>
                <div style={{ fontSize: 28, fontWeight: 600 }}>
                  {formatCents(totalUsedCents)} <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>/ {formatCents(totalLimitCents)}</span>
                </div>
                <div style={{ height: 4, background: 'var(--color-border)', borderRadius: 2, overflow: 'hidden', marginTop: 10 }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${budgetPct}%`,
                      background: budgetPct >= 90 ? 'var(--color-error)' : budgetPct >= 70 ? 'var(--color-warning)' : 'var(--color-primary)',
                    }}
                  />
                </div>
              </div>

              <Link href="/approvals" style={{ textDecoration: 'none', color: 'inherit' }}>
                <div className="card">
                  <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Pending approvals</div>
                  <div style={{ fontSize: 28, fontWeight: 600, color: pendingApprovals > 0 ? 'var(--color-warning)' : undefined }}>
                    {pendingApprovals}
                  </div>
                </div>
              </Link>

              <div className="card">
                <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Wallet balance</div>
                <div style={{ fontSize: 28, fontWeight: 600 }}>
                  {wallet?.initialized ? `${wallet.balanceCredits} credits` : <span className="muted" style={{ fontSize: 16 }}>Not set up</span>}
                </div>
              </div>
            </div>

            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h2 style={{ fontSize: 16, margin: 0 }}>Recent activity</h2>
                <Link href="/audit" style={{ fontSize: 13 }}>View full audit log →</Link>
              </div>
              {recentLogs.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>No activity yet.</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <tbody>
                    {recentLogs.map((log) => (
                      <tr key={log.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                        <td style={{ padding: 'var(--space-2) var(--space-3) var(--space-2) 0', whiteSpace: 'nowrap', color: 'var(--color-muted-foreground)' }}>
                          {new Date(log.createdAt).toLocaleString()}
                        </td>
                        <td style={{ padding: '8px 12px' }}>{log.actionType}</td>
                        <td style={{ padding: '8px 12px', color: 'var(--color-muted-foreground)' }}>
                          {log.agentId ? (agentsById.get(log.agentId)?.name ?? log.agentId) : '—'}
                        </td>
                        <td style={{ padding: 'var(--space-2) var(--space-3) var(--space-2) 0' }}>
                          <span
                            className={`badge ${log.status === 'failed' ? 'badge-error' : log.status === 'pending' ? 'badge-warning' : 'badge-success'}`}
                          >
                            {log.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
