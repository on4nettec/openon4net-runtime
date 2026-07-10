'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { User, UserRole } from '@o2n/shared';
import { api, loadSession, ApiError } from '@/lib/api-client';

const ROLES: UserRole[] = ['admin', 'manager', 'editor', 'viewer'];

export default function UsersPage() {
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('editor');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function loadUsers() {
    return api
      .listUsers()
      .then(setUsers)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load users'));
  }

  useEffect(() => {
    const session = loadSession();
    if (!session) {
      router.push('/login');
      return;
    }
    const admin = session.role === 'admin';
    setIsAdmin(admin);
    setCurrentUserId(session.userId);
    if (admin) loadUsers();
  }, [router]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      await api.createUser({ email, name, role });
      setEmail('');
      setName('');
      setRole('editor');
      await loadUsers();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Failed to create user');
    } finally {
      setCreating(false);
    }
  }

  async function handleRoleChange(userId: string, newRole: UserRole) {
    setUpdatingId(userId);
    setError(null);
    try {
      await api.updateUser(userId, { role: newRole });
      await loadUsers();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change role');
    } finally {
      setUpdatingId(null);
    }
  }

  async function handleToggleActive(u: User) {
    const action = u.isActive ? 'deactivate' : 'reactivate';
    if (u.isActive && !window.confirm(`Deactivate "${u.name}"? They won't be able to sign in until reactivated.`)) {
      return;
    }
    setUpdatingId(u.id);
    setError(null);
    try {
      if (u.isActive) {
        await api.deactivateUser(u.id);
      } else {
        await api.updateUser(u.id, { isActive: true });
      }
      await loadUsers();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to ${action} user`);
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <div>
      <div className="topbar">
        <Link href="/agents">← Agents</Link>
        <nav>
          <strong>Users</strong>
          <Link href="/workspaces">Workspaces</Link>
          <Link href="/roles">Roles & Permissions</Link>
          <Link href="/policies">Policies</Link>
          <Link href="/audit">Audit Log</Link>
          <Link href="/settings">Settings</Link>
        </nav>
      </div>

      <div className="page">
        <h1 style={{ fontSize: 20 }}>Users</h1>
        <p style={{ color: '#9aa0aa', fontSize: 14 }}>
          Everyone signs in with the same dev API key — a user&apos;s email just picks which identity (and role)
          they sign in as. See <Link href="/roles">Roles & Permissions</Link> to change what a role can do.
        </p>

        {error ? <div className="error">{error}</div> : null}

        {isAdmin === false ? (
          <p style={{ color: '#9aa0aa' }}>Only organization admins can view or add users.</p>
        ) : isAdmin === null ? (
          <p>Loading…</p>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 16 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#9aa0aa', fontSize: 12 }}>
                    <th style={{ paddingBottom: 8 }}>Email</th>
                    <th style={{ paddingBottom: 8 }}>Name</th>
                    <th style={{ paddingBottom: 8 }}>Role</th>
                    <th style={{ paddingBottom: 8 }}>Status</th>
                    <th style={{ paddingBottom: 8 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const isSelf = u.id === currentUserId;
                    const busy = updatingId === u.id;
                    return (
                      <tr key={u.id} style={{ borderTop: '1px solid #2c3038' }}>
                        <td style={{ padding: '8px 0' }}>
                          {u.email}
                          {isSelf ? <span style={{ color: '#9aa0aa' }}> (you)</span> : null}
                        </td>
                        <td style={{ padding: '8px 0' }}>{u.name}</td>
                        <td style={{ padding: '8px 0' }}>
                          {isSelf ? (
                            <span style={{ textTransform: 'capitalize' }}>{u.role}</span>
                          ) : (
                            <select
                              value={u.role}
                              disabled={busy}
                              onChange={(e) => handleRoleChange(u.id, e.target.value as UserRole)}
                            >
                              {ROLES.map((r) => (
                                <option key={r} value={r}>
                                  {r}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td style={{ padding: '8px 0' }}>
                          <span style={{ color: u.isActive ? '#4caf7d' : '#f2555a' }}>
                            {u.isActive ? 'Active' : 'Deactivated'}
                          </span>
                        </td>
                        <td style={{ padding: '8px 0' }}>
                          {isSelf ? null : (
                            <button className="secondary" disabled={busy} onClick={() => handleToggleActive(u)}>
                              {busy ? '…' : u.isActive ? 'Deactivate' : 'Reactivate'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="card">
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Add a user</h2>
              <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {createError ? <div className="error">{createError}</div> : null}
                <label>
                  Email
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </label>
                <label>
                  Name
                  <input value={name} onChange={(e) => setName(e.target.value)} required />
                </label>
                <label>
                  Role
                  <select value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" disabled={creating}>
                  {creating ? 'Adding…' : 'Add user'}
                </button>
              </form>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
