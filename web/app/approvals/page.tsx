'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ApprovalQueueEntry } from '@o2n/shared';
import { api, loadSession, ApiError, type Session } from '@/lib/api-client';
import { Sidebar } from '@/components/Sidebar';

function describeEntry(entry: ApprovalQueueEntry): string {
  const message = entry.actionData.message;
  if (typeof message === 'string') return message.length > 80 ? `${message.slice(0, 80)}…` : message;
  return entry.reason ?? '(no description)';
}

export default function ApprovalsPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [entries, setEntries] = useState<ApprovalQueueEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function loadEntries() {
    return api
      .listPendingApprovals()
      .then(setEntries)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load approvals'));
  }

  useEffect(() => {
    const s = loadSession();
    if (!s) {
      router.push('/login');
      return;
    }
    setSession(s);
    setReady(true);
    void loadEntries();
  }, [router]);

  async function handleApprove(entry: ApprovalQueueEntry) {
    setBusyId(entry.id);
    setError(null);
    try {
      await api.approveApproval(entry.id);
      await loadEntries();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to approve');
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(entry: ApprovalQueueEntry) {
    setBusyId(entry.id);
    setError(null);
    try {
      await api.rejectApproval(entry.id);
      await loadEntries();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reject');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      {session ? <Sidebar session={session} /> : null}

      <div className="page">
        <h1 style={{ fontSize: 'var(--font-size-xl)' }}>Approvals</h1>
        <p style={{ color: 'var(--color-muted-foreground)', fontSize: 14 }}>
          Requests held for human sign-off — usually because the estimated cost crossed a budget threshold or
          matched a policy. Unresolved requests expire automatically after 24 hours.
        </p>

        {error ? <div className="error">{error}</div> : null}

        {!ready ? (
          <p>Loading…</p>
        ) : (
          <div className="card">
            {entries.length === 0 ? (
              <p style={{ color: 'var(--color-muted-foreground)', margin: 0 }}>No pending approvals.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--color-muted-foreground)', fontSize: 12 }}>
                    <th style={{ paddingBottom: 8 }}>Request</th>
                    <th style={{ paddingBottom: 8 }}>Reason</th>
                    <th style={{ paddingBottom: 8 }}>Expires</th>
                    <th style={{ paddingBottom: 8 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => {
                    const busy = busyId === entry.id;
                    return (
                      <tr key={entry.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                        <td style={{ padding: 'var(--space-2) var(--space-3) var(--space-2) 0' }}>{describeEntry(entry)}</td>
                        <td style={{ padding: 'var(--space-2) var(--space-3) var(--space-2) 0', color: 'var(--color-muted-foreground)' }}>{entry.reason ?? '—'}</td>
                        <td style={{ padding: 'var(--space-2) var(--space-3) var(--space-2) 0', color: 'var(--color-muted-foreground)' }}>
                          {entry.expiresAt ? new Date(entry.expiresAt).toLocaleString() : '—'}
                        </td>
                        <td style={{ padding: 'var(--space-2) var(--space-3) var(--space-2) 0', display: 'flex', gap: 8 }}>
                          <button disabled={busy} onClick={() => handleApprove(entry)}>
                            Approve
                          </button>
                          <button className="secondary" disabled={busy} onClick={() => handleReject(entry)}>
                            Reject
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
