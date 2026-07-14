'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Agent, AuditLog } from '@o2n/shared';
import { api, loadSession, ApiError, downloadAuditLogExport } from '@/lib/api-client';

const PAGE_SIZE = 25;

export default function AuditPage() {
  const router = useRouter();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [agentsById, setAgentsById] = useState<Record<string, Agent>>({});
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ valid: boolean; brokenAtId?: string; checkedCount: number } | null>(null);

  async function handleExport(format: 'csv' | 'json') {
    setExporting(true);
    setError(null);
    try {
      await downloadAuditLogExport(format);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to export audit log');
    } finally {
      setExporting(false);
    }
  }

  async function handleVerify() {
    setVerifying(true);
    setError(null);
    setVerifyResult(null);
    try {
      setVerifyResult(await api.verifyAuditChain());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to verify audit chain');
    } finally {
      setVerifying(false);
    }
  }

  function load(nextOffset: number) {
    setLoading(true);
    setError(null);
    setForbidden(false);
    api
      .getAuditLogs({ limit: PAGE_SIZE, offset: nextOffset })
      .then(({ logs: rows, total: count }) => {
        setLogs(rows);
        setTotal(count);
        setOffset(nextOffset);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) {
          setForbidden(true);
        } else {
          setError(err instanceof ApiError ? err.message : 'Failed to load audit log');
        }
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (!loadSession()) {
      router.push('/login');
      return;
    }
    api
      .listAgents()
      .then((agents) => setAgentsById(Object.fromEntries(agents.map((a) => [a.id, a]))))
      .catch(() => {
        // Non-fatal — the log still shows agent ids if this fails.
      });
    load(0);
  }, [router]);

  return (
    <div>
      <div className="topbar">
        <Link href="/agents">← Agents</Link>
        <nav>
          <strong>Audit Log</strong>
          <Link href="/settings">Settings</Link>
          <Link href="/workspaces">Workspaces</Link>
          <Link href="/roles">Roles & Permissions</Link>
          <Link href="/users">Users</Link>
          <Link href="/skills">Skills</Link>
          <Link href="/skill-proposals">Skill Proposals</Link>
          <Link href="/marketplace">Marketplace</Link>
          <Link href="/approvals">Approvals</Link>
          <Link href="/workflows">Workflows</Link>
          <Link href="/policies">Policies</Link>
        </nav>
      </div>

      <div className="page" style={{ maxWidth: 960 }}>
        <h1 style={{ fontSize: 20 }}>Audit Log</h1>
        <p style={{ color: '#9aa0aa', fontSize: 14 }}>
          Every governed action — chats, approvals, config changes — organization-wide, newest first.
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
          <button className="secondary" disabled={exporting} onClick={() => handleExport('csv')}>
            Export CSV
          </button>
          <button className="secondary" disabled={exporting} onClick={() => handleExport('json')}>
            Export JSON
          </button>
          <button className="secondary" disabled={verifying} onClick={handleVerify}>
            {verifying ? 'Verifying…' : 'Verify integrity'}
          </button>
          {verifyResult ? (
            <span style={{ fontSize: 13, color: verifyResult.valid ? '#4caf7d' : '#f2555a' }}>
              {verifyResult.valid
                ? `✅ Chain intact (${verifyResult.checkedCount} entries checked)`
                : `❌ Broken at entry ${verifyResult.brokenAtId}`}
            </span>
          ) : null}
        </div>

        {error ? <div className="error">{error}</div> : null}

        {forbidden ? (
          <p style={{ color: '#9aa0aa' }}>You don&apos;t have permission to view the audit log (needs audit:read).</p>
        ) : (
          <>
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#9aa0aa', fontSize: 12 }}>
                    <th style={{ padding: '10px 14px' }}>Time</th>
                    <th style={{ padding: '10px 14px' }}>Action</th>
                    <th style={{ padding: '10px 14px' }}>Agent</th>
                    <th style={{ padding: '10px 14px' }}>Status</th>
                    <th style={{ padding: '10px 14px' }}>Approval</th>
                    <th style={{ padding: '10px 14px' }}>Model</th>
                    <th style={{ padding: '10px 14px' }}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id} style={{ borderTop: '1px solid #2c3038' }}>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                        {new Date(log.createdAt).toLocaleString()}
                      </td>
                      <td style={{ padding: '10px 14px' }}>{log.actionType}</td>
                      <td style={{ padding: '10px 14px' }}>{log.agentId ? (agentsById[log.agentId]?.name ?? log.agentId) : '—'}</td>
                      <td style={{ padding: '10px 14px' }}>
                        <span style={{ color: log.status === 'failed' ? '#f2555a' : log.status === 'pending' ? '#e0a83b' : '#4caf7d' }}>
                          {log.status}
                        </span>
                      </td>
                      <td style={{ padding: '10px 14px' }}>{log.approvalStatus}</td>
                      <td style={{ padding: '10px 14px' }}>{log.modelUsed ?? '—'}</td>
                      <td style={{ padding: '10px 14px' }}>{log.costCents !== null ? `${log.costCents}¢` : '—'}</td>
                    </tr>
                  ))}
                  {!loading && logs.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ padding: '14px', color: '#9aa0aa' }}>
                        No audit entries yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
              <span style={{ color: '#9aa0aa', fontSize: 13 }}>
                {total === 0 ? '0 entries' : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="secondary" onClick={() => load(Math.max(offset - PAGE_SIZE, 0))} disabled={loading || offset === 0}>
                  ← Newer
                </button>
                <button
                  className="secondary"
                  onClick={() => load(offset + PAGE_SIZE)}
                  disabled={loading || offset + PAGE_SIZE >= total}
                >
                  Older →
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
