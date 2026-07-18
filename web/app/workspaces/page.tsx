'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { Workspace } from '@o2n/shared';
import { api, loadSession, ApiError, type Session } from '@/lib/api-client';
import { Sidebar } from '@/components/Sidebar';

export default function WorkspacesPage() {
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function loadWorkspaces() {
    return api
      .listWorkspaces(showArchived)
      .then(setWorkspaces)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load workspaces'));
  }

  function startEdit(w: Workspace) {
    setEditingId(w.id);
    setEditName(w.name);
    setEditDescription(w.description ?? '');
  }

  async function handleSaveEdit(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api.updateWorkspace(id, { name: editName, description: editDescription || undefined });
      setEditingId(null);
      await loadWorkspaces();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update workspace');
    } finally {
      setBusyId(null);
    }
  }

  async function handleArchive(w: Workspace) {
    if (!window.confirm(`Archive workspace "${w.name}"? Existing agents keep working, but no new agents can be created in it.`)) return;
    setBusyId(w.id);
    setError(null);
    try {
      await api.archiveWorkspace(w.id);
      await loadWorkspaces();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to archive workspace');
    } finally {
      setBusyId(null);
    }
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
    if (admin) loadWorkspaces();
  }, [router]);

  useEffect(() => {
    if (isAdmin) loadWorkspaces();
  }, [showArchived]);

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
      {session ? <Sidebar session={session} /> : null}

      <div className="page">
        <h1 style={{ fontSize: 'var(--font-size-xl)' }}>Workspaces</h1>
        <p style={{ color: 'var(--color-muted-foreground)', fontSize: 14 }}>
          Agents are created inside a workspace — pick which one when creating a new agent.
        </p>

        {error ? <div className="error">{error}</div> : null}

        {isAdmin === false ? (
          <p style={{ color: 'var(--color-muted-foreground)' }}>Only organization admins can view or add workspaces.</p>
        ) : isAdmin === null ? (
          <p>Loading…</p>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, fontSize: 13 }}>
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                Show archived workspaces
              </label>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--color-muted-foreground)', fontSize: 12 }}>
                    <th style={{ paddingBottom: 8 }}>Name</th>
                    <th style={{ paddingBottom: 8 }}>Description</th>
                    <th style={{ paddingBottom: 8 }}>Status</th>
                    <th style={{ paddingBottom: 8 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {workspaces.map((w) => {
                    const busy = busyId === w.id;
                    const editing = editingId === w.id;
                    return (
                      <tr key={w.id} style={{ borderTop: '1px solid var(--color-border)', opacity: w.status === 'archived' ? 0.6 : 1 }}>
                        {editing ? (
                          <>
                            <td style={{ padding: '8px 0' }}>
                              <input value={editName} onChange={(e) => setEditName(e.target.value)} />
                            </td>
                            <td style={{ padding: '8px 0' }}>
                              <input value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
                            </td>
                            <td style={{ padding: '8px 0', color: 'var(--color-muted-foreground)' }}>{w.status}</td>
                            <td style={{ padding: '8px 0', display: 'flex', gap: 8 }}>
                              <button className="secondary" disabled={busy} onClick={() => handleSaveEdit(w.id)}>
                                Save
                              </button>
                              <button className="secondary" disabled={busy} onClick={() => setEditingId(null)}>
                                Cancel
                              </button>
                            </td>
                          </>
                        ) : (
                          <>
                            <td style={{ padding: '8px 0' }}>{w.name}</td>
                            <td style={{ padding: '8px 0', color: 'var(--color-muted-foreground)' }}>{w.description ?? '—'}</td>
                            <td style={{ padding: '8px 0', color: 'var(--color-muted-foreground)' }}>{w.status}</td>
                            <td style={{ padding: '8px 0', display: 'flex', gap: 8 }}>
                              <button className="secondary" disabled={busy} onClick={() => startEdit(w)}>
                                Edit
                              </button>
                              {w.status === 'active' ? (
                                <button className="secondary" disabled={busy} onClick={() => handleArchive(w)}>
                                  Archive
                                </button>
                              ) : null}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
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
