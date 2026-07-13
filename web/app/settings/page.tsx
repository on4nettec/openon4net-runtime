'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, loadSession, ApiError } from '@/lib/api-client';
import type { Organization } from '@o2n/shared';

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

  const [organization, setOrganization] = useState<Organization | null>(null);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [editingOrg, setEditingOrg] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [savingOrg, setSavingOrg] = useState(false);
  const [orgSaveError, setOrgSaveError] = useState<string | null>(null);

  const [wallet, setWallet] = useState<{ balanceCredits: number; initialized?: boolean } | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [topUpAmount, setTopUpAmount] = useState('');
  const [toppingUp, setToppingUp] = useState(false);
  const [topUpError, setTopUpError] = useState<string | null>(null);

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

  function loadOrganization() {
    return api
      .getOrganization()
      .then((org) => {
        setOrganization(org);
        setOrgName(org.name);
      })
      .catch((err) => setOrgError(err instanceof ApiError ? err.message : 'Failed to load organization'));
  }

  function loadWallet() {
    return api
      .getWallet()
      .then(setWallet)
      .catch((err) => setWalletError(err instanceof ApiError ? err.message : 'Failed to load wallet'));
  }

  useEffect(() => {
    const session = loadSession();
    if (!session) {
      router.push('/login');
      return;
    }
    const admin = session.role === 'admin';
    setIsAdmin(admin);
    loadConfig();
    if (admin) {
      loadOrganization();
      loadWallet();
    }
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

  async function handleSaveOrg(e: FormEvent) {
    e.preventDefault();
    setSavingOrg(true);
    setOrgSaveError(null);
    try {
      await api.updateOrganization({ name: orgName });
      setEditingOrg(false);
      await loadOrganization();
    } catch (err) {
      setOrgSaveError(err instanceof ApiError ? err.message : 'Failed to save organization');
    } finally {
      setSavingOrg(false);
    }
  }

  async function handleTopUp(e: FormEvent) {
    e.preventDefault();
    setToppingUp(true);
    setTopUpError(null);
    try {
      await api.creditWallet({ amountCredits: Number(topUpAmount), reason: 'Manual top-up via settings' });
      setTopUpAmount('');
      await loadWallet();
    } catch (err) {
      setTopUpError(err instanceof ApiError ? err.message : 'Failed to top up wallet');
    } finally {
      setToppingUp(false);
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
        <nav>
          <strong>Settings</strong>
          <Link href="/audit">Audit Log</Link>
          <Link href="/skills">Skills</Link>
          <Link href="/skill-proposals">Skill Proposals</Link>
          <Link href="/marketplace">Marketplace</Link>
          <Link href="/approvals">Approvals</Link>
          {isAdmin ? <Link href="/workspaces">Workspaces</Link> : null}
          {isAdmin ? <Link href="/users">Users</Link> : null}
          {isAdmin ? <Link href="/roles">Roles & Permissions</Link> : null}
          {isAdmin ? <Link href="/policies">Policies</Link> : null}
        </nav>
      </div>

      <div className="page">
        {isAdmin ? (
          <>
            <h1 style={{ fontSize: 20 }}>Organization</h1>
            {orgError ? <div className="error">{orgError}</div> : null}
            {organization ? (
              <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
                <Row label="Name" value={organization.name} />
                <Row label="Slug" value={organization.slug} />
                <Row label="Plan" value={organization.plan} />
                <Row label="Status" value={organization.status} />

                <div style={{ borderTop: '1px solid #2c3038', paddingTop: 14, marginTop: 4 }}>
                  <button type="button" onClick={() => setEditingOrg((v) => !v)}>
                    {editingOrg ? 'Cancel' : 'Edit name'}
                  </button>
                </div>

                {editingOrg ? (
                  <form
                    onSubmit={handleSaveOrg}
                    style={{ borderTop: '1px solid #2c3038', paddingTop: 14, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 10 }}
                  >
                    {orgSaveError ? <div className="error">{orgSaveError}</div> : null}
                    <label>
                      Name
                      <input value={orgName} onChange={(e) => setOrgName(e.target.value)} required />
                    </label>
                    <button type="submit" disabled={savingOrg}>
                      {savingOrg ? 'Saving…' : 'Save'}
                    </button>
                  </form>
                ) : null}
              </div>
            ) : !orgError ? (
              <p>Loading…</p>
            ) : null}

            <h2 style={{ fontSize: 16, marginTop: 24 }}>Wallet</h2>
            <p style={{ color: '#9aa0aa', fontSize: 13, marginTop: 0 }}>
              Optional org-level spending cap. Uninitialized (never topped up) means no cap — chats are only
              gated by each agent&apos;s own monthly budget.
            </p>
            {walletError ? <div className="error">{walletError}</div> : null}
            {wallet ? (
              <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
                <Row
                  label="Balance"
                  value={wallet.initialized === false ? 'Not initialized (no cap)' : `${wallet.balanceCredits} credits`}
                />
                <form
                  onSubmit={handleTopUp}
                  style={{ borderTop: '1px solid #2c3038', paddingTop: 14, marginTop: 4, display: 'flex', gap: 10, alignItems: 'flex-end' }}
                >
                  {topUpError ? <div className="error">{topUpError}</div> : null}
                  <label style={{ flex: 1 }}>
                    Add credits
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={topUpAmount}
                      onChange={(e) => setTopUpAmount(e.target.value)}
                      required
                    />
                  </label>
                  <button type="submit" disabled={toppingUp}>
                    {toppingUp ? 'Adding…' : 'Top up'}
                  </button>
                </form>
              </div>
            ) : null}
          </>
        ) : null}

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
