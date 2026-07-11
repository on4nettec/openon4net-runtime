'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, loadSession, ApiError } from '@/lib/api-client';

interface Role {
  id: string;
  name: string;
  isSystem: boolean;
  permissions: string[];
}

// Every permission string checked anywhere in gateway/src (requirePermission
// call sites) plus the "*" wildcard per resource — kept in sync by hand
// since permissions are free-form strings, not a DB-enumerated type.
const PERMISSION_CATALOG: { resource: string; permissions: string[] }[] = [
  {
    resource: 'agents',
    permissions: [
      'agents:create',
      'agents:read',
      'agents:update',
      'agents:chat',
      'agents:access:grant',
      'agents:access:revoke',
      'agents:*',
    ],
  },
  { resource: 'memory', permissions: ['memory:read', 'memory:write', 'memory:*'] },
  { resource: 'audit', permissions: ['audit:read'] },
  { resource: 'approvals', permissions: ['approvals:read', 'approvals:approve', 'approvals:*'] },
  { resource: 'billing', permissions: ['billing:wallet:read'] },
  { resource: 'tools', permissions: ['tools:read', 'tools:telegram-send', 'tools:webhook-send', 'tools:*'] },
  { resource: 'config', permissions: ['config:write'] },
  { resource: 'roles', permissions: ['roles:read', 'roles:write'] },
  { resource: 'users', permissions: ['users:read', 'users:write'] },
  { resource: 'workspaces', permissions: ['workspaces:read', 'workspaces:write'] },
];

export default function RolesPage() {
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Local checkbox state per role, independent from saved state until Save is pressed.
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [newRoleName, setNewRoleName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function loadRoles() {
    return api
      .getRoles()
      .then((r) => {
        setRoles(r);
        setDraft(Object.fromEntries(r.map((role) => [role.id, role.permissions])));
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load roles'));
  }

  useEffect(() => {
    const session = loadSession();
    if (!session) {
      router.push('/login');
      return;
    }
    const admin = session.role === 'admin';
    setIsAdmin(admin);
    if (admin) loadRoles();
  }, [router]);

  function toggle(roleId: string, permission: string) {
    setDraft((prev) => {
      const current = prev[roleId] ?? [];
      const next = current.includes(permission)
        ? current.filter((p) => p !== permission)
        : [...current, permission];
      return { ...prev, [roleId]: next };
    });
    setSavedId(null);
  }

  async function handleSave(roleId: string) {
    setSavingId(roleId);
    setError(null);
    try {
      const updated = await api.updateRolePermissions(roleId, draft[roleId] ?? []);
      setRoles((prev) => prev.map((r) => (r.id === roleId ? updated : r)));
      setSavedId(roleId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save role');
    } finally {
      setSavingId(null);
    }
  }

  async function handleCreateRole(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      await api.createRole(newRoleName);
      setNewRoleName('');
      await loadRoles();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Failed to create role');
    } finally {
      setCreating(false);
    }
  }

  async function handleDeleteRole(role: Role) {
    if (!window.confirm(`Delete role "${role.name}"? This can't be undone.`)) return;
    setDeletingId(role.id);
    setError(null);
    try {
      await api.deleteRole(role.id);
      await loadRoles();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete role');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div>
      <div className="topbar">
        <Link href="/agents">← Agents</Link>
        <nav>
          <strong>Roles & Permissions</strong>
          <Link href="/workspaces">Workspaces</Link>
          <Link href="/users">Users</Link>
          <Link href="/policies">Policies</Link>
          <Link href="/audit">Audit Log</Link>
          <Link href="/settings">Settings</Link>
        </nav>
      </div>

      <div className="page">
        <h1 style={{ fontSize: 20 }}>Roles & Permissions</h1>
        <p style={{ color: '#9aa0aa', fontSize: 14 }}>
          Edit what each role can do — changes apply immediately, no restart or re-login needed for
          already-signed-in users.
        </p>

        {error ? <div className="error">{error}</div> : null}

        {isAdmin === false ? (
          <p style={{ color: '#9aa0aa' }}>Only organization admins can view or edit roles.</p>
        ) : isAdmin === null || (roles.length === 0 && !error) ? (
          <p>Loading…</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {roles.map((role) => {
              const checked = new Set(draft[role.id] ?? []);
              const dirty = JSON.stringify([...checked].sort()) !== JSON.stringify([...role.permissions].sort());
              return (
                <div key={role.id} className="card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <strong style={{ textTransform: 'capitalize' }}>{role.name}</strong>
                    {role.isSystem ? (
                      <span style={{ color: '#9aa0aa', fontSize: 12 }}>system role</span>
                    ) : (
                      <button
                        className="secondary"
                        onClick={() => handleDeleteRole(role)}
                        disabled={deletingId === role.id}
                      >
                        {deletingId === role.id ? 'Deleting…' : 'Delete'}
                      </button>
                    )}
                  </div>

                  {PERMISSION_CATALOG.map((group) => (
                    <div key={group.resource} style={{ marginBottom: 10 }}>
                      <div style={{ color: '#9aa0aa', fontSize: 12, marginBottom: 4, textTransform: 'uppercase' }}>
                        {group.resource}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                        {group.permissions.map((permission) => (
                          <label key={permission} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                            <input
                              type="checkbox"
                              checked={checked.has(permission)}
                              onChange={() => toggle(role.id, permission)}
                            />
                            {permission}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}

                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                    <button onClick={() => handleSave(role.id)} disabled={!dirty || savingId === role.id}>
                      {savingId === role.id ? 'Saving…' : 'Save'}
                    </button>
                    {savedId === role.id ? <span style={{ color: '#4caf7d', fontSize: 13 }}>✓ Saved</span> : null}
                  </div>
                </div>
              );
            })}

            <div className="card">
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Add a custom role</h2>
              <form onSubmit={handleCreateRole} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {createError ? <div className="error">{createError}</div> : null}
                <label>
                  Name
                  <input
                    value={newRoleName}
                    onChange={(e) => setNewRoleName(e.target.value)}
                    placeholder="e.g. Finance Reviewer"
                    required
                  />
                </label>
                <button type="submit" disabled={creating}>
                  {creating ? 'Adding…' : 'Add role'}
                </button>
              </form>
              <p style={{ color: '#9aa0aa', fontSize: 13, marginBottom: 0, marginTop: 10 }}>
                Starts with zero permissions — check boxes above and Save once it appears in the list.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
