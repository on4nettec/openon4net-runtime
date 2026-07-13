'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, saveSession, ApiError } from '@/lib/api-client';

function AcceptInviteForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const session = await api.acceptInvitation(token, { name, password });
      saveSession(session);
      router.push('/agents');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to accept invitation');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 420, marginTop: 80 }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Accept your invitation</h1>
      <p style={{ color: '#9aa0aa', marginTop: 0, marginBottom: 24, fontSize: 14 }}>
        Choose your name and a password to finish joining.
      </p>
      {!token ? (
        <div className="error">Missing invitation token — use the link from your invitation email.</div>
      ) : (
        <form className="card" onSubmit={handleSubmit}>
          {error ? <div className="error">{error}</div> : null}
          <div className="field">
            <label htmlFor="name">Your name</label>
            <input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
          </div>
          <button type="submit" disabled={loading} style={{ width: '100%' }}>
            {loading ? 'Joining…' : 'Join'}
          </button>
        </form>
      )}
    </div>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense>
      <AcceptInviteForm />
    </Suspense>
  );
}
