'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  api,
  loadSession,
  ApiError,
  type MarketplacePlugin,
  type MarketplaceSkillListing,
} from '@/lib/api-client';

export default function MarketplacePage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [plugins, setPlugins] = useState<MarketplacePlugin[]>([]);
  const [skills, setSkills] = useState<MarketplaceSkillListing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [installedPluginIds, setInstalledPluginIds] = useState<Set<string>>(new Set());
  const [installIds, setInstallIds] = useState<Record<string, string>>({});
  const [configDrafts, setConfigDrafts] = useState<Record<string, Record<string, string>>>({});
  const [configStatus, setConfigStatus] = useState<Record<string, string>>({});

  function loadMarketplace() {
    setError(null);
    return Promise.all([api.listMarketplacePlugins(), api.listMarketplaceSkills()])
      .then(([pluginsResult, skillsResult]) => {
        setPlugins(pluginsResult.plugins);
        setSkills(skillsResult.skills);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load marketplace'));
  }

  useEffect(() => {
    const session = loadSession();
    if (!session) {
      router.push('/login');
      return;
    }
    setReady(true);
    void loadMarketplace();
  }, [router]);

  async function handleInstallPlugin(plugin: MarketplacePlugin) {
    setBusyId(plugin.pluginId);
    setError(null);
    try {
      const result = await api.installMarketplacePlugin(plugin.pluginId);
      setInstalledPluginIds((prev) => new Set(prev).add(plugin.pluginId));
      setInstallIds((prev) => ({ ...prev, [plugin.pluginId]: result.installId }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to install plugin');
    } finally {
      setBusyId(null);
    }
  }

  async function handleInstallSkill(skill: MarketplaceSkillListing) {
    setBusyId(skill.skillId);
    setError(null);
    try {
      await api.installMarketplaceSkill(skill.skillId);
      window.alert(`Installed "${skill.name}" — find it under Skills.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to install skill');
    } finally {
      setBusyId(null);
    }
  }

  function handleConfigFieldChange(pluginId: string, key: string, value: string) {
    setConfigDrafts((prev) => ({ ...prev, [pluginId]: { ...prev[pluginId], [key]: value } }));
  }

  async function handleSaveConfig(pluginId: string) {
    const installId = installIds[pluginId];
    if (!installId) return;
    setConfigStatus((prev) => ({ ...prev, [pluginId]: 'saving' }));
    try {
      await api.updateMarketplaceInstallConfig(installId, configDrafts[pluginId] ?? {});
      setConfigStatus((prev) => ({ ...prev, [pluginId]: 'saved' }));
    } catch (err) {
      setConfigStatus((prev) => ({
        ...prev,
        [pluginId]: err instanceof ApiError ? err.message : 'Failed to save settings',
      }));
    }
  }

  return (
    <div>
      <div className="topbar">
        <Link href="/agents">← Agents</Link>
        <nav>
          <Link href="/workspaces">Workspaces</Link>
          <Link href="/users">Users</Link>
          <Link href="/roles">Roles & Permissions</Link>
          <Link href="/audit">Audit Log</Link>
          <Link href="/skills">Skills</Link>
          <Link href="/skill-proposals">Skill Proposals</Link>
          <strong>Marketplace</strong>
          <Link href="/policies">Policies</Link>
          <Link href="/settings">Settings</Link>
        </nav>
      </div>

      <div className="page">
        <h1 style={{ fontSize: 20 }}>Marketplace</h1>
        <p style={{ color: '#9aa0aa', fontSize: 14 }}>
          Browse Skills and Plugins published by the community. Installing requires an activated Runtime.
        </p>

        {error ? <div className="error">{error}</div> : null}

        {!ready ? (
          <p>Loading…</p>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 16 }}>
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Skills</h2>
              {skills.length === 0 ? (
                <p style={{ color: '#9aa0aa', margin: 0 }}>No skills listed yet.</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: '#9aa0aa', fontSize: 12 }}>
                      <th style={{ paddingBottom: 8 }}>Name</th>
                      <th style={{ paddingBottom: 8 }}>Publisher</th>
                      <th style={{ paddingBottom: 8 }}>Price</th>
                      <th style={{ paddingBottom: 8 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {skills.map((skill) => (
                      <tr key={skill.skillId} style={{ borderTop: '1px solid #2c3038' }}>
                        <td style={{ padding: '8px 0' }}>
                          {skill.name}
                          {skill.description ? (
                            <div style={{ color: '#9aa0aa', fontSize: 12 }}>{skill.description}</div>
                          ) : null}
                        </td>
                        <td style={{ padding: '8px 0', color: '#9aa0aa' }}>{skill.publisherSlug}</td>
                        <td style={{ padding: '8px 0' }}>
                          {skill.priceCents === 0 ? 'Free' : `$${(skill.priceCents / 100).toFixed(2)}`}
                        </td>
                        <td style={{ padding: '8px 0' }}>
                          <button
                            className="secondary"
                            disabled={busyId === skill.skillId}
                            onClick={() => handleInstallSkill(skill)}
                          >
                            Install
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="card">
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Plugins</h2>
              {plugins.length === 0 ? (
                <p style={{ color: '#9aa0aa', margin: 0 }}>No plugins listed yet.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {plugins.map((plugin) => {
                    const installed = installedPluginIds.has(plugin.pluginId);
                    const configSchema = plugin.manifest?.configSchema ?? [];
                    return (
                      <div key={plugin.pluginId} style={{ borderTop: '1px solid #2c3038', paddingTop: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div>
                            <strong>{plugin.name}</strong>{' '}
                            <span style={{ color: '#9aa0aa', fontSize: 12 }}>
                              {plugin.publisherSlug}
                              {plugin.publisherVerified ? ' ✓' : ''} · {plugin.latestVersion ?? 'unversioned'}
                            </span>
                            {plugin.description ? (
                              <div style={{ color: '#9aa0aa', fontSize: 12 }}>{plugin.description}</div>
                            ) : null}
                          </div>
                          <button
                            className="secondary"
                            disabled={busyId === plugin.pluginId || installed}
                            onClick={() => handleInstallPlugin(plugin)}
                          >
                            {installed ? 'Installed' : 'Install'}
                          </button>
                        </div>

                        {installed && configSchema.length > 0 ? (
                          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {configSchema.map((field) => (
                              <label key={field.key}>
                                {field.label}
                                <input
                                  type={field.type === 'string' ? 'text' : field.type}
                                  value={configDrafts[plugin.pluginId]?.[field.key] ?? ''}
                                  onChange={(e) =>
                                    handleConfigFieldChange(plugin.pluginId, field.key, e.target.value)
                                  }
                                />
                              </label>
                            ))}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <button className="secondary" onClick={() => handleSaveConfig(plugin.pluginId)}>
                                Save settings
                              </button>
                              {configStatus[plugin.pluginId] ? (
                                <span style={{ fontSize: 12, color: '#9aa0aa' }}>{configStatus[plugin.pluginId]}</span>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
