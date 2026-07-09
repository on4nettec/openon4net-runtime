'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api, saveSession, ApiError } from '@/lib/api-client';

export default function LoginPage() {
  const router = useRouter();
  const [apiKey, setApiKey] = useState('');
  const [organizationSlug, setOrganizationSlug] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const session = await api.login({
        apiKey,
        organizationSlug,
        organizationName: organizationName || undefined,
      });
      saveSession(session);
      router.push('/agents');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 420, marginTop: 80 }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Open on4net</h1>
      <p style={{ color: '#9aa0aa', marginTop: 0, marginBottom: 24, fontSize: 14 }}>
        Sign in with your organization&apos;s dev API key. New slugs create a fresh organization.
      </p>
      <form className="card" onSubmit={handleSubmit}>
        {error ? <div className="error">{error}</div> : null}
        <div className="field">
          <label htmlFor="organizationSlug">Organization slug</label>
          <input
            id="organizationSlug"
            value={organizationSlug}
            onChange={(e) => setOrganizationSlug(e.target.value)}
            placeholder="acme-corp"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="organizationName">Organization name (only used if creating new)</label>
          <input
            id="organizationName"
            value={organizationName}
            onChange={(e) => setOrganizationName(e.target.value)}
            placeholder="Acme Corp"
          />
        </div>
        <div className="field">
          <label htmlFor="apiKey">Dev API key</label>
          <input
            id="apiKey"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="DEV_API_KEY from .env"
            required
          />
        </div>
        <button type="submit" disabled={loading} style={{ width: '100%' }}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
