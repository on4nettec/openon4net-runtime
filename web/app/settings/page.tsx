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

export default function SettingsPage() {
  const router = useRouter();
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);

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
