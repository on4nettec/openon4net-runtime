'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { Agent } from '@o2n/shared';
import { api, loadSession, ApiError, type Session } from '@/lib/api-client';
import { TopBar } from '@/components/TopBar';

interface KpiWithAgent {
  agentId: string;
  agentName: string;
  name: string;
  target: string | number;
  current?: string | number;
  metricType: 'manual' | 'action_count' | 'cost_cents' | 'success_rate';
}

/** Hand-rolled inline SVG sparkline — no charting library dependency for v1 (RT-059). */
function KpiTrendChart({ values }: { values: number[] }) {
  if (values.length < 2) return <p style={{ color: 'var(--color-muted-foreground)', fontSize: 12 }}>Not enough history yet.</p>;

  const width = 240;
  const height = 48;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * width},${height - ((v - min) / range) * height}`)
    .join(' ');

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline points={points} fill="none" stroke="var(--color-success)" strokeWidth={2} />
    </svg>
  );
}

export default function OutcomesPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kpis, setKpis] = useState<KpiWithAgent[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [askResult, setAskResult] = useState<{ answer: string; error?: string } | null>(null);
  const [outcomesByKey, setOutcomesByKey] = useState<
    Record<
      string,
      {
        snapshots: { value: number; recordedAt: string }[];
        insights: { message: string }[];
        anomalies: { date: string; value: number; isAnomaly: boolean }[];
        prediction: { predicted: number } | null;
      }
    >
  >({});

  useEffect(() => {
    const s = loadSession();
    if (!s) {
      router.push('/login');
      return;
    }
    setSession(s);
    setReady(true);
    api
      .listAgents()
      .then(async (agents: Agent[]) => {
        const allKpis: KpiWithAgent[] = [];
        for (const agent of agents) {
          const config = agent.kpiConfig as { kpis?: KpiWithAgent[] };
          for (const kpi of config.kpis ?? []) {
            allKpis.push({ ...kpi, agentId: agent.id, agentName: agent.name });
          }
        }
        setKpis(allKpis);

        const entries = await Promise.all(
          allKpis.map(async (kpi) => {
            const key = `${kpi.agentId}:${kpi.name}`;
            try {
              const outcome = await api.getAgentKpiOutcomes(kpi.agentId, kpi.name);
              return [key, outcome] as const;
            } catch {
              return null;
            }
          }),
        );
        setOutcomesByKey(Object.fromEntries(entries.filter((e): e is NonNullable<typeof e> => e !== null)));
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load outcomes'));
  }, [router]);

  async function handleAsk(e: FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    setAsking(true);
    setAskResult(null);
    try {
      const result = await api.askInsight(question.trim());
      setAskResult({ answer: result.answer });
    } catch (err) {
      setAskResult({ answer: '', error: err instanceof ApiError ? err.message : 'Failed to answer question' });
    } finally {
      setAsking(false);
    }
  }

  return (
    <div>
      {session ? <TopBar session={session} /> : null}

      <div className="page">
        <h1 style={{ fontSize: 'var(--font-size-xl)' }}>Outcomes</h1>
        <p style={{ color: 'var(--color-muted-foreground)', fontSize: 14 }}>
          KPI trends across every agent. Non-manual KPIs (action count / cost / success rate) are computed once a
          day from the audit log — set <code>metricType</code> on a KPI in an agent&apos;s panel to enable this.
          Anomaly flags are a simple statistical (Z-score) check, and the projection is a linear trend
          extrapolation — neither is a trained model.
        </p>

        {error ? <div className="error">{error}</div> : null}

        <form onSubmit={handleAsk} className="card" style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask a question, e.g. 'how many actions did we take this week?'"
            style={{ flex: 1 }}
          />
          <button type="submit" disabled={asking || !question.trim()}>
            {asking ? 'Asking…' : 'Ask'}
          </button>
        </form>
        {askResult ? (
          <div className="card" style={{ marginBottom: 16 }}>
            {askResult.error ? (
              <span style={{ color: 'var(--color-error)' }}>{askResult.error}</span>
            ) : (
              <span>💬 {askResult.answer}</span>
            )}
          </div>
        ) : null}

        {!ready ? (
          <p>Loading…</p>
        ) : kpis.length === 0 ? (
          <p style={{ color: 'var(--color-muted-foreground)' }}>No KPIs defined yet — add one from an agent&apos;s panel.</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
            {kpis.map((kpi) => {
              const key = `${kpi.agentId}:${kpi.name}`;
              const outcome = outcomesByKey[key];
              return (
                <div key={key} className="card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <strong>{kpi.name}</strong>
                    <span style={{ fontSize: 12, color: 'var(--color-muted-foreground)' }}>{kpi.agentName}</span>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--color-muted-foreground)', marginTop: 4 }}>
                    {kpi.current ?? '—'} / {kpi.target}
                    {kpi.metricType !== 'manual' ? ` (auto: ${kpi.metricType})` : ''}
                  </div>

                  {outcome ? (
                    <>
                      <div style={{ marginTop: 10 }}>
                        <KpiTrendChart values={outcome.snapshots.map((s) => s.value)} />
                      </div>
                      {outcome.prediction ? (
                        <div style={{ fontSize: 12, color: 'var(--color-muted-foreground)', marginTop: 6 }}>
                          Projected next period: {outcome.prediction.predicted}
                        </div>
                      ) : null}
                      {outcome.anomalies.some((a) => a.isAnomaly) ? (
                        <div style={{ fontSize: 12, color: 'var(--color-warning)', marginTop: 6 }}>
                          ⚠ Anomaly detected in recent history
                        </div>
                      ) : null}
                      {outcome.insights.map((insight, i) => (
                        <div key={i} style={{ fontSize: 12, color: 'var(--color-success)', marginTop: 6 }}>
                          💡 {insight.message}
                        </div>
                      ))}
                    </>
                  ) : (
                    <p style={{ color: 'var(--color-muted-foreground)', fontSize: 12, marginTop: 10 }}>No trend history yet.</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
