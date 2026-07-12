'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Workspace } from '@o2n/shared';
import { api, loadSession, ApiError } from '@/lib/api-client';

export default function WorkspacesPage() {
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function loadWorkspaces() {
    return api
      .listWorkspaces()
      .then(setWorkspaces)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load workspaces'));
  }

  useEffect(() => {
    const session = loadSession();
    if (!session) {
      router.push('/login');
      return;
    }
    const admin = session.role === 'admin';
    setIsAdmin(admin);
    if (admin) loadWorkspaces();
  }, [router]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      await api.createWorkspace({ name, description: description || undefined });
      setName('');
      setDescription('');
      await loadWorkspaces();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Failed to create workspace');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div className="topbar">
        <Link href="/agents">← Agents</Link>
        <nav>
          <strong>Workspaces</strong>
          <Link href="/users">Users</Link>
          <Link href="/roles">Roles & Permissions</Link>
          <Link href="/skills">Skills</Link>
          <Link href="/skill-proposals">Skill Proposals</Link>
          <Link href="/marketplace">Marketplace</Link>
          <Link href="/policies">Policies</Link>
          <Link href="/audit">Audit Log</Link>
          <Link href="/settings">Settings</Link>
        </nav>
      </div>

      <div className="page">
        <h1 style={{ fontSize: 20 }}>Workspaces</h1>
        <p style={{ color: '#9aa0aa', fontSize: 14 }}>
          Agents are created inside a workspace — pick which one when creating a new agent.
        </p>

        {error ? <div className="error">{error}</div> : null}

        {isAdmin === false ? (
          <p style={{ color: '#9aa0aa' }}>Only organization admins can view or add workspaces.</p>
        ) : isAdmin === null ? (
          <p>Loading…</p>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 16 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#9aa0aa', fontSize: 12 }}>
                    <th style={{ paddingBottom: 8 }}>Name</th>
                    <th style={{ paddingBottom: 8 }}>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {workspaces.map((w) => (
                    <tr key={w.id} style={{ borderTop: '1px solid #2c3038' }}>
                      <td style={{ padding: '8px 0' }}>{w.name}</td>
                      <td style={{ padding: '8px 0', color: '#9aa0aa' }}>{w.description ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card">
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Add a workspace</h2>
              <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {createError ? <div className="error">{createError}</div> : null}
                <label>
                  Name
                  <input value={name} onChange={(e) => setName(e.target.value)} required />
                </label>
                <label>
                  Description (optional)
                  <input value={description} onChange={(e) => setDescription(e.target.value)} />
                </label>
                <button type="submit" disabled={creating}>
                  {creating ? 'Adding…' : 'Add workspace'}
                </button>
              </form>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
