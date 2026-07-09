'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, loadSession, ApiError } from '@/lib/api-client';

interface Config {
  llmProvider: string;
  llmModel: string;
  llmApiKeyMasked: string;
  approvalThresholdCents: number;
  rateLimitPerMinute: number;
}

interface TestResult {
  success: boolean;
  model?: string;
  error?: string;
  responseTimeMs: number;
}

export default function SettingsPage() {
  const router = useRouter();
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  useEffect(() => {
    if (!loadSession()) {
      router.push('/login');
      return;
    }
    api
      .getConfig()
      .then(setConfig)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load settings'));
  }, [router]);

  async function handleTestConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.testConnection());
    } catch (err) {
      setTestResult({
        success: false,
        error: err instanceof ApiError ? err.message : 'Test failed',
        responseTimeMs: 0,
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div>
      <div className="topbar">
        <Link href="/agents">← Agents</Link>
        <strong>Settings</strong>
      </div>

      <div className="page">
        <h1 style={{ fontSize: 20 }}>AI Provider</h1>
        <p style={{ color: '#9aa0aa', fontSize: 14 }}>
          Read-only in this version — edit <code>LLM_PROVIDER</code>/<code>LLM_API_KEY</code>/<code>LLM_MODEL</code>{' '}
          in the runtime&apos;s <code>.env</code> and restart the gateway to change it.
        </p>

        {error ? <div className="error">{error}</div> : null}

        {config ? (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Row label="Provider" value={config.llmProvider} />
            <Row label="Model" value={config.llmModel} />
            <Row label="API key" value={config.llmApiKeyMasked} />
            <Row label="Approval threshold" value={`${config.approvalThresholdCents} cents`} />
            <Row label="Rate limit" value={`${config.rateLimitPerMinute} req/min per agent`} />

            <div style={{ borderTop: '1px solid #2c3038', paddingTop: 14, marginTop: 4 }}>
              <button onClick={handleTestConnection} disabled={testing}>
                {testing ? 'Testing…' : 'Test connection'}
              </button>
              {testResult ? (
                <div style={{ marginTop: 10, fontSize: 13 }}>
                  {testResult.success ? (
                    <span style={{ color: '#4caf7d' }}>
                      ✓ Connected — {testResult.model} responded in {testResult.responseTimeMs}ms
                    </span>
                  ) : (
                    <span style={{ color: '#f2555a' }}>
                      ✗ Failed ({testResult.responseTimeMs}ms): {testResult.error}
                    </span>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        ) : !error ? (
          <p>Loading…</p>
        ) : null}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: '#9aa0aa' }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}
