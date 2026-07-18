'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, loadSession, ApiError, type Session, type SkillProposal } from '@/lib/api-client';
import { Sidebar } from '@/components/Sidebar';

function describeStep(proposal: SkillProposal): string {
  const step = proposal.proposedDefinition.steps[0];
  if (!step) return '(no steps)';
  if (step.tool === 'webhook-send') return `webhook → ${String(step.params.url ?? '(url missing)')}`;
  return `telegram → chat ${String(step.params.chatId ?? '(chat id missing)')}`;
}

export default function SkillProposalsPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [proposals, setProposals] = useState<SkillProposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function loadProposals() {
    return api
      .listSkillProposals()
      .then(setProposals)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load skill proposals'));
  }

  useEffect(() => {
    const s = loadSession();
    if (!s) {
      router.push('/login');
      return;
    }
    setSession(s);
    setReady(true);
    void loadProposals();
  }, [router]);

  async function handleApprove(proposal: SkillProposal) {
    setBusyId(proposal.id);
    setError(null);
    try {
      await api.approveSkillProposal(proposal.id);
      await loadProposals();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to approve proposal');
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(proposal: SkillProposal) {
    setBusyId(proposal.id);
    setError(null);
    try {
      await api.rejectSkillProposal(proposal.id);
      await loadProposals();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reject proposal');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      {session ? <Sidebar session={session} /> : null}

      <div className="page">
        <h1 style={{ fontSize: 'var(--font-size-xl)' }}>Skill Proposals</h1>
        <p style={{ color: 'var(--color-muted-foreground)', fontSize: 14 }}>
          Auto-detected from repeated agent activity (frequency + similarity of recent actions). Approving
          creates a real Skill; rejecting discards the proposal. Neither happens automatically — a human
          always decides.
        </p>

        {error ? <div className="error">{error}</div> : null}

        {!ready ? (
          <p>Loading…</p>
        ) : (
          <div className="card">
            {proposals.length === 0 ? (
              <p style={{ color: 'var(--color-muted-foreground)', margin: 0 }}>No pending proposals.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--color-muted-foreground)', fontSize: 12 }}>
                    <th style={{ paddingBottom: 8 }}>Pattern</th>
                    <th style={{ paddingBottom: 8 }}>Occurrences</th>
                    <th style={{ paddingBottom: 8 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {proposals.map((proposal) => {
                    const busy = busyId === proposal.id;
                    return (
                      <tr key={proposal.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                        <td style={{ padding: '8px 0' }}>{describeStep(proposal)}</td>
                        <td style={{ padding: '8px 0', color: 'var(--color-muted-foreground)' }}>
                          {String(proposal.patternMetadata.occurrences ?? '?')} in{' '}
                          {String(proposal.patternMetadata.windowDays ?? '?')} days
                        </td>
                        <td style={{ padding: '8px 0', display: 'flex', gap: 8 }}>
                          <button disabled={busy} onClick={() => handleApprove(proposal)}>
                            Approve
                          </button>
                          <button className="secondary" disabled={busy} onClick={() => handleReject(proposal)}>
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
