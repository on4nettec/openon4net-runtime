'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { User, Workspace } from '@o2n/shared';
import { api, loadSession, ApiError, type Invitation, type Session } from '@/lib/api-client';
import { Sidebar } from '@/components/Sidebar';

interface RoleOption {
  id: string;
  name: string;
  isSystem: boolean;
}

export default function UsersPage() {
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('');
  const [inviteWorkspaceId, setInviteWorkspaceId] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  function loadUsers() {
    return api
      .listUsers()
      .then(setUsers)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load users'));
  }

  function loadInvitations() {
    return api
      .listInvitations()
      .then(setInvitations)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load invitations'));
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
    setCurrentUserId(s.userId);
    if (admin) {
      loadUsers();
      loadInvitations();
      api
        .getRoles()
        .then((list) => {
          setRoles(list);
          if (list[0]) {
            setRole(list[0].name);
            setInviteRole(list[0].name);
          }
        })
        .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load roles'));
      api
        .listWorkspaces()
        .then(setWorkspaces)
        .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load workspaces'));
    }
  }, [router]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      await api.createUser({ email, name, role, workspaceId: workspaceId || undefined });
      setEmail('');
      setName('');
      await loadUsers();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Failed to create user');
    } finally {
      setCreating(false);
    }
  }

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    setInviting(true);
    setInviteError(null);
    try {
      await api.createInvitation({ email: inviteEmail, role: inviteRole, workspaceId: inviteWorkspaceId || undefined });
      setInviteEmail('');
      await loadInvitations();
    } catch (err) {
      setInviteError(err instanceof ApiError ? err.message : 'Failed to send invitation');
    } finally {
      setInviting(false);
    }
  }

  async function handleRevokeInvitation(invitation: Invitation) {
    setRevokingId(invitation.id);
    setError(null);
    try {
      await api.revokeInvitation(invitation.id);
      await loadInvitations();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to revoke invitation');
    } finally {
      setRevokingId(null);
    }
  }

  async function handleRoleChange(userId: string, newRole: string) {
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
      {session ? <Sidebar session={session} /> : null}

      <div className="page">
        <h1 style={{ fontSize: 'var(--font-size-xl)' }}>Users</h1>
        <p style={{ color: 'var(--color-muted-foreground)', fontSize: 14 }}>
          Everyone signs in with the same dev API key — a user&apos;s email just picks which identity (and role)
          they sign in as. See <Link href="/roles">Roles & Permissions</Link> to change what a role can do.
        </p>

        {error ? <div className="error">{error}</div> : null}

        {isAdmin === false ? (
          <p style={{ color: 'var(--color-muted-foreground)' }}>Only organization admins can view or add users.</p>
        ) : isAdmin === null ? (
          <p>Loading…</p>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 16 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--color-muted-foreground)', fontSize: 12 }}>
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
                      <tr key={u.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                        <td style={{ padding: '8px 0' }}>
                          {u.email}
                          {isSelf ? <span style={{ color: 'var(--color-muted-foreground)' }}> (you)</span> : null}
                        </td>
                        <td style={{ padding: '8px 0' }}>{u.name}</td>
                        <td style={{ padding: '8px 0' }}>
                          {isSelf ? (
                            <span style={{ textTransform: 'capitalize' }}>{u.role}</span>
                          ) : (
                            <select
                              value={u.role}
                              disabled={busy}
                              onChange={(e) => handleRoleChange(u.id, e.target.value)}
                            >
                              {roles.map((r) => (
                                <option key={r.id} value={r.name}>
                                  {r.name}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td style={{ padding: '8px 0' }}>
                          <span style={{ color: u.isActive ? 'var(--color-success)' : 'var(--color-error)' }}>
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
                  <select value={role} onChange={(e) => setRole(e.target.value)}>
                    {roles.map((r) => (
                      <option key={r.id} value={r.name}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                {workspaces.length > 1 ? (
                  <label>
                    Workspace
                    <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
                      <option value="">Default (org&apos;s first workspace)</option>
                      {workspaces.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <button type="submit" disabled={creating}>
                  {creating ? 'Adding…' : 'Add user'}
                </button>
              </form>
            </div>

            <div className="card" style={{ marginTop: 16 }}>
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Invite by email</h2>
              <p style={{ color: 'var(--color-muted-foreground)', fontSize: 13, marginTop: 0 }}>
                Sends an email with a link the invitee uses to set their own name and password.
              </p>

              {invitations.length > 0 ? (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, marginBottom: 16 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--color-muted-foreground)', fontSize: 12 }}>
                      <th style={{ paddingBottom: 8 }}>Email</th>
                      <th style={{ paddingBottom: 8 }}>Role</th>
                      <th style={{ paddingBottom: 8 }}>Expires</th>
                      <th style={{ paddingBottom: 8 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {invitations.map((inv) => (
                      <tr key={inv.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                        <td style={{ padding: '8px 0' }}>{inv.email}</td>
                        <td style={{ padding: '8px 0', color: 'var(--color-muted-foreground)' }}>{inv.role}</td>
                        <td style={{ padding: '8px 0', color: 'var(--color-muted-foreground)' }}>{new Date(inv.expiresAt).toLocaleDateString()}</td>
                        <td style={{ padding: '8px 0' }}>
                          <button
                            className="secondary"
                            disabled={revokingId === inv.id}
                            onClick={() => handleRevokeInvitation(inv)}
                          >
                            Revoke
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}

              <form onSubmit={handleInvite} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {inviteError ? <div className="error">{inviteError}</div> : null}
                <label>
                  Email
                  <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required />
                </label>
                <label>
                  Role
                  <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                    {roles.map((r) => (
                      <option key={r.id} value={r.name}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                {workspaces.length > 1 ? (
                  <label>
                    Workspace
                    <select value={inviteWorkspaceId} onChange={(e) => setInviteWorkspaceId(e.target.value)}>
                      <option value="">Default (org&apos;s first workspace)</option>
                      {workspaces.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <button type="submit" disabled={inviting}>
                  {inviting ? 'Sending…' : 'Send invitation'}
                </button>
              </form>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
