'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, loadSession, ApiError } from '@/lib/api-client';

interface Config {
  provider: string;
  model: string;
  apiKeyMasked: string;
  baseUrl: string | null;
  source: 'database' | 'env';
  approvalThresholdCents: number;
  rateLimitPerMinute: number;
}

interface TestResult {
  success: boolean;
  model?: string;
  error?: string;
  responseTimeMs: number;
}

const PROVIDERS = ['anthropic', 'openai', 'deepseek', 'ollama'] as const;

export default function SettingsPage() {
  const router = useRouter();
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState<(typeof PROVIDERS)[number]>('anthropic');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function loadConfig() {
    return api
      .getConfig()
      .then((c) => {
        setConfig(c);
        setProvider(c.provider as (typeof PROVIDERS)[number]);
        setModel(c.model);
        setBaseUrl(c.baseUrl ?? '');
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load settings'));
  }

  useEffect(() => {
    const session = loadSession();
    if (!session) {
      router.push('/login');
      return;
    }
    setIsAdmin(session.role === 'admin');
    loadConfig();
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

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    try {
      await api.updateConfig({
        provider,
        model,
        apiKey,
        baseUrl: baseUrl.trim() ? baseUrl.trim() : undefined,
      });
      setApiKey('');
      setEditing(false);
      setTestResult(null);
      await loadConfig();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
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
          {config?.source === 'database'
            ? 'This organization has its own provider override, stored encrypted in the database.'
            : "Using the runtime's env-configured default provider — no per-organization override set yet."}
        </p>

        {error ? <div className="error">{error}</div> : null}

        {config ? (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Row label="Provider" value={config.provider} />
            <Row label="Model" value={config.model} />
            <Row label="API key" value={config.apiKeyMasked} />
            {config.baseUrl ? <Row label="Base URL" value={config.baseUrl} /> : null}
            <Row label="Source" value={config.source === 'database' ? 'Organization override' : 'Runtime default (.env)'} />
            <Row label="Approval threshold" value={`${config.approvalThresholdCents} cents`} />
            <Row label="Rate limit" value={`${config.rateLimitPerMinute} req/min per agent`} />

            <div style={{ borderTop: '1px solid #2c3038', paddingTop: 14, marginTop: 4, display: 'flex', gap: 10 }}>
              <button onClick={handleTestConnection} disabled={testing}>
                {testing ? 'Testing…' : 'Test connection'}
              </button>
              {isAdmin ? (
                <button type="button" onClick={() => setEditing((v) => !v)}>
                  {editing ? 'Cancel' : 'Change provider'}
                </button>
              ) : null}
            </div>
            {testResult ? (
              <div style={{ marginTop: 2, fontSize: 13 }}>
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

            {isAdmin && editing ? (
              <form
                onSubmit={handleSave}
                style={{ borderTop: '1px solid #2c3038', paddingTop: 14, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 10 }}
              >
                {saveError ? <div className="error">{saveError}</div> : null}
                <label>
                  Provider
                  <select value={provider} onChange={(e) => setProvider(e.target.value as (typeof PROVIDERS)[number])}>
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Model
                  <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. claude-sonnet-5" required />
                </label>
                <label>
                  API key
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Enter new key to set/replace it"
                    required
                  />
                </label>
                <label>
                  Base URL (optional)
                  <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Leave blank for provider default" />
                </label>
                <button type="submit" disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </form>
            ) : null}
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
