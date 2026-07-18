'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api, loadSession, ApiError, type Session } from '@/lib/api-client';
import type { Organization } from '@o2n/shared';
import { Sidebar } from '@/components/Sidebar';

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
  const [session, setSession] = useState<Session | null>(null);

  const [organization, setOrganization] = useState<Organization | null>(null);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [editingOrg, setEditingOrg] = useState(false);
  const [orgName, setOrgName] = useState('');
  // RT-083 — org-level i18n default (per-user override lives on /agents's
  // first-login picker instead, since that's a self-service, non-admin action).
  const [orgLanguage, setOrgLanguage] = useState('en');
  const [savingOrg, setSavingOrg] = useState(false);
  const [orgSaveError, setOrgSaveError] = useState<string | null>(null);

  const [auditRetentionDays, setAuditRetentionDays] = useState('');
  const [savingRetention, setSavingRetention] = useState(false);
  const [retentionSaveError, setRetentionSaveError] = useState<string | null>(null);
  const [retentionSaved, setRetentionSaved] = useState(false);

  const [wallet, setWallet] = useState<{ balanceCredits: number; initialized?: boolean } | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [topUpAmount, setTopUpAmount] = useState('');
  const [toppingUp, setToppingUp] = useState(false);
  const [topUpError, setTopUpError] = useState<string | null>(null);

  const [ssoConfig, setSsoConfig] = useState<{ protocol: 'oidc' | 'saml'; config: Record<string, string>; hasSecret: boolean } | null>(
    null,
  );
  const [ssoLoaded, setSsoLoaded] = useState(false);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const [editingSso, setEditingSso] = useState(false);
  const [ssoProtocol, setSsoProtocol] = useState<'oidc' | 'saml'>('oidc');
  const [issuerUrl, setIssuerUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [entityId, setEntityId] = useState('');
  const [ssoUrl, setSsoUrl] = useState('');
  const [certificate, setCertificate] = useState('');
  const [savingSso, setSavingSso] = useState(false);
  const [ssoSaveError, setSsoSaveError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState<(typeof PROVIDERS)[number]>('anthropic');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // RT-089 — real model list instead of free text; empty means either still
  // loading or the fetch came back empty (custom baseUrl, unknown ollama
  // models, ...), in which case the UI falls back to manual entry.
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  useEffect(() => {
    if (!editing) return;
    setModelsLoading(true);
    api
      .getModels(provider, provider === 'ollama' ? baseUrl.trim() || undefined : undefined)
      .then((res) => setAvailableModels(res.models))
      .catch(() => setAvailableModels([]))
      .finally(() => setModelsLoading(false));
  }, [editing, provider, baseUrl]);

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
        setOrgLanguage(org.language);
        const retention = org.settings.auditRetentionDays;
        setAuditRetentionDays(typeof retention === 'number' ? String(retention) : '');
      })
      .catch((err) => setOrgError(err instanceof ApiError ? err.message : 'Failed to load organization'));
  }

  function loadWallet() {
    return api
      .getWallet()
      .then(setWallet)
      .catch((err) => setWalletError(err instanceof ApiError ? err.message : 'Failed to load wallet'));
  }

  function loadSso() {
    return api
      .getSsoConfig()
      .then((cfg) => {
        setSsoConfig(cfg);
        setSsoLoaded(true);
        if (cfg) {
          setSsoProtocol(cfg.protocol);
          if (cfg.protocol === 'oidc') {
            setIssuerUrl(cfg.config.issuerUrl ?? '');
            setClientId(cfg.config.clientId ?? '');
          } else {
            setEntityId(cfg.config.entityId ?? '');
            setSsoUrl(cfg.config.ssoUrl ?? '');
            setCertificate(cfg.config.certificate ?? '');
          }
        }
      })
      .catch((err) => setSsoError(err instanceof ApiError ? err.message : 'Failed to load SSO config'));
  }

  useEffect(() => {
    const s = loadSession();
    if (!s) {
      router.push('/login');
      return;
    }
    setSession(s);
    const admin = s.role === 'admin';
    setIsAdmin(admin);
    loadConfig();
    if (admin) {
      loadOrganization();
      loadWallet();
      loadSso();
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
      await api.updateOrganization({ name: orgName, language: orgLanguage });
      setEditingOrg(false);
      await loadOrganization();
    } catch (err) {
      setOrgSaveError(err instanceof ApiError ? err.message : 'Failed to save organization');
    } finally {
      setSavingOrg(false);
    }
  }

  async function handleSaveRetention(e: FormEvent) {
    e.preventDefault();
    setSavingRetention(true);
    setRetentionSaveError(null);
    setRetentionSaved(false);
    try {
      const days = auditRetentionDays.trim() === '' ? null : Number(auditRetentionDays);
      await api.updateOrganization({ settings: { auditRetentionDays: days } });
      setRetentionSaved(true);
    } catch (err) {
      setRetentionSaveError(err instanceof ApiError ? err.message : 'Failed to save retention setting');
    } finally {
      setSavingRetention(false);
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

  async function handleSaveSso(e: FormEvent) {
    e.preventDefault();
    setSavingSso(true);
    setSsoSaveError(null);
    try {
      if (ssoProtocol === 'oidc') {
        await api.setSsoConfig({ protocol: 'oidc', issuerUrl, clientId, clientSecret });
      } else {
        await api.setSsoConfig({ protocol: 'saml', entityId, ssoUrl, certificate });
      }
      setClientSecret('');
      setEditingSso(false);
      await loadSso();
    } catch (err) {
      setSsoSaveError(err instanceof ApiError ? err.message : 'Failed to save SSO config');
    } finally {
      setSavingSso(false);
    }
  }

  async function handleDeleteSso() {
    if (!window.confirm('Remove SSO configuration? Users will no longer be able to sign in via this org’s IdP.')) return;
    setSsoSaveError(null);
    try {
      await api.deleteSsoConfig();
      setSsoConfig(null);
      setIssuerUrl('');
      setClientId('');
      setClientSecret('');
      setEntityId('');
      setSsoUrl('');
      setCertificate('');
    } catch (err) {
      setSsoSaveError(err instanceof ApiError ? err.message : 'Failed to remove SSO config');
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
        apiKey: apiKey.trim() ? apiKey.trim() : undefined,
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
      {session ? <Sidebar session={session} /> : null}

      <div className="page">
        {isAdmin ? (
          <>
            <h1 style={{ fontSize: 'var(--font-size-xl)' }}>Organization</h1>
            {orgError ? <div className="error">{orgError}</div> : null}
            {organization ? (
              <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
                <Row label="Name" value={organization.name} />
                <Row label="Slug" value={organization.slug} />
                <Row label="Plan" value={organization.plan} />
                <Row label="Status" value={organization.status} />
                <Row label="Default language" value={organization.language} />

                <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 14, marginTop: 4 }}>
                  <button type="button" onClick={() => setEditingOrg((v) => !v)}>
                    {editingOrg ? 'Cancel' : 'Edit name/language'}
                  </button>
                </div>

                {editingOrg ? (
                  <form
                    onSubmit={handleSaveOrg}
                    style={{ borderTop: '1px solid var(--color-border)', paddingTop: 14, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 10 }}
                  >
                    {orgSaveError ? <div className="error">{orgSaveError}</div> : null}
                    <label>
                      Name
                      <input value={orgName} onChange={(e) => setOrgName(e.target.value)} required />
                    </label>
                    <label>
                      Default language (per-user override happens on first login)
                      <select value={orgLanguage} onChange={(e) => setOrgLanguage(e.target.value)}>
                        <option value="en">English</option>
                        <option value="fa">فارسی</option>
                        <option value="ar">العربية</option>
                        <option value="fr">Français</option>
                        <option value="es">Español</option>
                      </select>
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

            <h2 style={{ fontSize: 16, marginTop: 24 }}>Governance</h2>
            <p style={{ color: 'var(--color-muted-foreground)', fontSize: 13, marginTop: 0 }}>
              Blank means never auto-delete (or fall back to the Runtime-wide <code>AUDIT_RETENTION_DAYS</code>{' '}
              default, if set). Swept once a day.
            </p>
            <div className="card" style={{ marginBottom: 24 }}>
              <form onSubmit={handleSaveRetention} style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
                {retentionSaveError ? <div className="error">{retentionSaveError}</div> : null}
                <label>
                  Audit retention (days)
                  <input
                    type="number"
                    min={1}
                    value={auditRetentionDays}
                    onChange={(e) => {
                      setAuditRetentionDays(e.target.value);
                      setRetentionSaved(false);
                    }}
                    placeholder="Never"
                  />
                </label>
                <button type="submit" disabled={savingRetention}>
                  {savingRetention ? 'Saving…' : 'Save'}
                </button>
                {retentionSaved ? <span style={{ color: 'var(--color-success)', fontSize: 13 }}>✓ Saved</span> : null}
              </form>
            </div>

            <h2 style={{ fontSize: 16, marginTop: 24 }}>Wallet</h2>
            <p style={{ color: 'var(--color-muted-foreground)', fontSize: 13, marginTop: 0 }}>
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
                  style={{ borderTop: '1px solid var(--color-border)', paddingTop: 14, marginTop: 4, display: 'flex', gap: 10, alignItems: 'flex-end' }}
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

            <h2 style={{ fontSize: 16, marginTop: 24 }}>Single Sign-On</h2>
            <p style={{ color: 'var(--color-muted-foreground)', fontSize: 13, marginTop: 0 }}>
              Enterprise SSO — this organization&apos;s own identity provider (OIDC or SAML). Users must already
              have an account (SSO doesn&apos;t auto-create one) — it just replaces password/magic-link for signing
              in to an existing account.
            </p>
            {ssoError ? <div className="error">{ssoError}</div> : null}
            {ssoLoaded ? (
              <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
                {ssoConfig ? (
                  <>
                    <Row label="Protocol" value={ssoConfig.protocol.toUpperCase()} />
                    {ssoConfig.protocol === 'oidc' ? (
                      <>
                        <Row label="Issuer URL" value={ssoConfig.config.issuerUrl ?? ''} />
                        <Row label="Client ID" value={ssoConfig.config.clientId ?? ''} />
                        <Row label="Client secret" value={ssoConfig.hasSecret ? '••••••••' : 'not set'} />
                      </>
                    ) : (
                      <>
                        <Row label="Entity ID" value={ssoConfig.config.entityId ?? ''} />
                        <Row label="SSO URL" value={ssoConfig.config.ssoUrl ?? ''} />
                      </>
                    )}
                    <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 14, marginTop: 4, display: 'flex', gap: 10 }}>
                      <button type="button" onClick={() => setEditingSso((v) => !v)}>
                        {editingSso ? 'Cancel' : 'Edit'}
                      </button>
                      <button type="button" className="secondary" onClick={handleDeleteSso}>
                        Remove
                      </button>
                    </div>
                  </>
                ) : (
                  <p style={{ color: 'var(--color-muted-foreground)', margin: 0 }}>No SSO provider configured yet.</p>
                )}

                {!ssoConfig || editingSso ? (
                  <form
                    onSubmit={handleSaveSso}
                    style={{ borderTop: ssoConfig ? '1px solid var(--color-border)' : 'none', paddingTop: ssoConfig ? 14 : 0, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 10 }}
                  >
                    {ssoSaveError ? <div className="error">{ssoSaveError}</div> : null}
                    <label>
                      Protocol
                      <select value={ssoProtocol} onChange={(e) => setSsoProtocol(e.target.value as 'oidc' | 'saml')}>
                        <option value="oidc">OIDC</option>
                        <option value="saml">SAML</option>
                      </select>
                    </label>
                    {ssoProtocol === 'oidc' ? (
                      <>
                        <label>
                          Issuer URL
                          <input
                            value={issuerUrl}
                            onChange={(e) => setIssuerUrl(e.target.value)}
                            placeholder="https://idp.example.com"
                            required
                          />
                        </label>
                        <label>
                          Client ID
                          <input value={clientId} onChange={(e) => setClientId(e.target.value)} required />
                        </label>
                        <label>
                          Client secret
                          <input
                            type="password"
                            value={clientSecret}
                            onChange={(e) => setClientSecret(e.target.value)}
                            placeholder="Enter new secret to set/replace it"
                            required
                          />
                        </label>
                      </>
                    ) : (
                      <>
                        <label>
                          Entity ID
                          <input value={entityId} onChange={(e) => setEntityId(e.target.value)} required />
                        </label>
                        <label>
                          SSO URL
                          <input
                            value={ssoUrl}
                            onChange={(e) => setSsoUrl(e.target.value)}
                            placeholder="https://idp.example.com/sso"
                            required
                          />
                        </label>
                        <label>
                          Certificate (PEM x509)
                          <textarea
                            value={certificate}
                            onChange={(e) => setCertificate(e.target.value)}
                            rows={6}
                            style={{ fontFamily: 'monospace', fontSize: 12, width: '100%' }}
                            required
                          />
                        </label>
                      </>
                    )}
                    <button type="submit" disabled={savingSso}>
                      {savingSso ? 'Saving…' : 'Save'}
                    </button>
                  </form>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}

        <h1 style={{ fontSize: 'var(--font-size-xl)' }}>AI Provider</h1>
        <p style={{ color: 'var(--color-muted-foreground)', fontSize: 14 }}>
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

            <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 14, marginTop: 4, display: 'flex', gap: 10 }}>
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
                  <span style={{ color: 'var(--color-success)' }}>
                    ✓ Connected — {testResult.model} responded in {testResult.responseTimeMs}ms
                  </span>
                ) : (
                  <span style={{ color: 'var(--color-error)' }}>
                    ✗ Failed ({testResult.responseTimeMs}ms): {testResult.error}
                  </span>
                )}
              </div>
            ) : null}

            {isAdmin && editing ? (
              <form
                onSubmit={handleSave}
                style={{ borderTop: '1px solid var(--color-border)', paddingTop: 14, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 10 }}
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
                  {availableModels.length > 0 ? (
                    <select value={model} onChange={(e) => setModel(e.target.value)}>
                      <option value="">Select a model…</option>
                      {availableModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                      <option value="__other__">Other (type manually)…</option>
                    </select>
                  ) : (
                    <input
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder={modelsLoading ? 'Loading models…' : 'e.g. claude-3-5-sonnet-20241022'}
                      required
                    />
                  )}
                  {availableModels.length > 0 && model === '__other__' ? (
                    <input
                      value=""
                      onChange={(e) => setModel(e.target.value)}
                      placeholder="Custom model name"
                      style={{ marginTop: 6 }}
                    />
                  ) : null}
                </label>
                <label>
                  API key {provider === 'ollama' ? '(not required for ollama)' : ''}
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={provider === 'ollama' ? 'Not needed for a local ollama instance' : 'Enter new key to set/replace it'}
                    required={provider !== 'ollama'}
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
      <span style={{ color: 'var(--color-muted-foreground)' }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}
