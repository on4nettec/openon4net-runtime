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
  type Session,
} from '@/lib/api-client';
import { TopBar } from '@/components/TopBar';

export default function MarketplacePage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [plugins, setPlugins] = useState<MarketplacePlugin[]>([]);
  const [skills, setSkills] = useState<MarketplaceSkillListing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [installedPluginIds, setInstalledPluginIds] = useState<Set<string>>(new Set());
  const [installedSkillIds, setInstalledSkillIds] = useState<Set<string>>(new Set());
  const [installIds, setInstallIds] = useState<Record<string, string>>({});
  const [configDrafts, setConfigDrafts] = useState<Record<string, Record<string, string>>>({});
  const [configStatus, setConfigStatus] = useState<Record<string, string>>({});
  const [ratingDrafts, setRatingDrafts] = useState<Record<string, number>>({});
  const [ratingStatus, setRatingStatus] = useState<Record<string, string>>({});

  function formatRating(avgRating: number | null, ratingCount: number): string {
    return avgRating !== null ? `★ ${avgRating.toFixed(1)} (${ratingCount})` : 'No ratings yet';
  }

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
    const s = loadSession();
    if (!s) {
      router.push('/login');
      return;
    }
    setSession(s);
    setReady(true);
    void loadMarketplace();
  }, [router]);

  async function handleInstallPlugin(plugin: MarketplacePlugin, acknowledgePermissionDiff = false) {
    setBusyId(plugin.pluginId);
    setError(null);
    try {
      const result = await api.installMarketplacePlugin(plugin.pluginId, { acknowledgePermissionDiff });
      setInstalledPluginIds((prev) => new Set(prev).add(plugin.pluginId));
      setInstallIds((prev) => ({ ...prev, [plugin.pluginId]: result.installId }));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PERMISSION_DIFF_REQUIRED') {
        const confirmed = window.confirm(`${err.message}\n\nInstall anyway?`);
        if (confirmed) {
          setBusyId(null);
          await handleInstallPlugin(plugin, true);
          return;
        }
      } else {
        setError(err instanceof ApiError ? err.message : 'Failed to install plugin');
      }
    } finally {
      setBusyId(null);
    }
  }

  async function handleInstallSkill(skill: MarketplaceSkillListing) {
    setBusyId(skill.skillId);
    setError(null);
    try {
      await api.installMarketplaceSkill(skill.skillId);
      setInstalledSkillIds((prev) => new Set(prev).add(skill.skillId));
      window.alert(`Installed "${skill.name}" — find it under Skills.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to install skill');
    } finally {
      setBusyId(null);
    }
  }

  async function handleRatePlugin(pluginId: string) {
    const rating = ratingDrafts[pluginId];
    if (!rating) return;
    setRatingStatus((prev) => ({ ...prev, [pluginId]: 'saving' }));
    try {
      await api.rateMarketplacePlugin(pluginId, rating);
      setRatingStatus((prev) => ({ ...prev, [pluginId]: 'saved' }));
      await loadMarketplace();
    } catch (err) {
      setRatingStatus((prev) => ({ ...prev, [pluginId]: err instanceof ApiError ? err.message : 'Failed to rate' }));
    }
  }

  async function handleRateSkill(skillId: string) {
    const rating = ratingDrafts[skillId];
    if (!rating) return;
    setRatingStatus((prev) => ({ ...prev, [skillId]: 'saving' }));
    try {
      await api.rateMarketplaceSkill(skillId, rating);
      setRatingStatus((prev) => ({ ...prev, [skillId]: 'saved' }));
      await loadMarketplace();
    } catch (err) {
      setRatingStatus((prev) => ({ ...prev, [skillId]: err instanceof ApiError ? err.message : 'Failed to rate' }));
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
      {session ? <TopBar session={session} /> : null}

      <div className="page">
        <h1 style={{ fontSize: 'var(--font-size-xl)' }}>Marketplace</h1>
        <p style={{ color: 'var(--color-muted-foreground)', fontSize: 14 }}>
          Browse Skills and Plugins published by the community. Installing requires an activated Runtime.{' '}
          <Link href="/marketplace/publisher">Publish your own →</Link>
        </p>

        {error ? <div className="error">{error}</div> : null}

        {!ready ? (
          <p>Loading…</p>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 16 }}>
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Skills</h2>
              {skills.length === 0 ? (
                <p style={{ color: 'var(--color-muted-foreground)', margin: 0 }}>No skills listed yet.</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--color-muted-foreground)', fontSize: 12 }}>
                      <th style={{ paddingBottom: 8 }}>Name</th>
                      <th style={{ paddingBottom: 8 }}>Publisher</th>
                      <th style={{ paddingBottom: 8 }}>Price</th>
                      <th style={{ paddingBottom: 8 }}>Downloads</th>
                      <th style={{ paddingBottom: 8 }}>Rating</th>
                      <th style={{ paddingBottom: 8 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {skills.map((skill) => {
                      const skillInstalled = installedSkillIds.has(skill.skillId);
                      return (
                        <tr key={skill.skillId} style={{ borderTop: '1px solid var(--color-border)' }}>
                          <td style={{ padding: '8px 0' }}>
                            {skill.name}
                            {skill.description ? (
                              <div style={{ color: 'var(--color-muted-foreground)', fontSize: 12 }}>{skill.description}</div>
                            ) : null}
                          </td>
                          <td style={{ padding: '8px 0', color: 'var(--color-muted-foreground)' }}>{skill.publisherSlug}</td>
                          <td style={{ padding: '8px 0' }}>
                            {skill.priceCents === 0 ? 'Free' : `$${(skill.priceCents / 100).toFixed(2)}`}
                          </td>
                          <td style={{ padding: '8px 0', color: 'var(--color-muted-foreground)' }}>{skill.installCount}</td>
                          <td style={{ padding: '8px 0', color: 'var(--color-muted-foreground)' }}>
                            {formatRating(skill.avgRating, skill.ratingCount)}
                          </td>
                          <td style={{ padding: '8px 0' }}>
                            {skillInstalled ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <select
                                  value={ratingDrafts[skill.skillId] ?? ''}
                                  onChange={(e) =>
                                    setRatingDrafts((prev) => ({ ...prev, [skill.skillId]: Number(e.target.value) }))
                                  }
                                >
                                  <option value="">Rate…</option>
                                  {[1, 2, 3, 4, 5].map((n) => (
                                    <option key={n} value={n}>
                                      {n}
                                    </option>
                                  ))}
                                </select>
                                <button className="secondary" onClick={() => handleRateSkill(skill.skillId)}>
                                  Submit
                                </button>
                                {ratingStatus[skill.skillId] ? (
                                  <span style={{ fontSize: 12, color: 'var(--color-muted-foreground)' }}>{ratingStatus[skill.skillId]}</span>
                                ) : null}
                              </div>
                            ) : (
                              <button
                                className="secondary"
                                disabled={busyId === skill.skillId}
                                onClick={() => handleInstallSkill(skill)}
                              >
                                Install
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <div className="card">
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Plugins</h2>
              {plugins.length === 0 ? (
                <p style={{ color: 'var(--color-muted-foreground)', margin: 0 }}>No plugins listed yet.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {plugins.map((plugin) => {
                    const installed = installedPluginIds.has(plugin.pluginId);
                    const configSchema = plugin.manifest?.configSchema ?? [];
                    return (
                      <div key={plugin.pluginId} style={{ borderTop: '1px solid var(--color-border)', paddingTop: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div>
                            <strong>{plugin.name}</strong>{' '}
                            <span style={{ color: 'var(--color-muted-foreground)', fontSize: 12 }}>
                              {plugin.publisherSlug}
                              {plugin.publisherVerified ? ' ✓' : ''} · {plugin.latestVersion ?? 'unversioned'}
                            </span>
                            {plugin.description ? (
                              <div style={{ color: 'var(--color-muted-foreground)', fontSize: 12 }}>{plugin.description}</div>
                            ) : null}
                            {plugin.permissions.length > 0 ? (
                              <div style={{ color: 'var(--color-muted-foreground)', fontSize: 12 }}>
                                Wants access to: {plugin.permissions.join(', ')}
                              </div>
                            ) : null}
                            <div style={{ color: 'var(--color-muted-foreground)', fontSize: 12 }}>
                              {plugin.priceCredits ? `${plugin.priceCredits} credits` : 'Free'} · {plugin.installCount}{' '}
                              installs · {formatRating(plugin.avgRating, plugin.ratingCount)}
                            </div>
                          </div>
                          <button
                            className="secondary"
                            disabled={busyId === plugin.pluginId || installed}
                            onClick={() => handleInstallPlugin(plugin)}
                          >
                            {installed ? 'Installed' : plugin.priceCredits ? `Install (${plugin.priceCredits}cr)` : 'Install'}
                          </button>
                        </div>

                        {installed ? (
                          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <select
                              value={ratingDrafts[plugin.pluginId] ?? ''}
                              onChange={(e) =>
                                setRatingDrafts((prev) => ({ ...prev, [plugin.pluginId]: Number(e.target.value) }))
                              }
                            >
                              <option value="">Rate…</option>
                              {[1, 2, 3, 4, 5].map((n) => (
                                <option key={n} value={n}>
                                  {n}
                                </option>
                              ))}
                            </select>
                            <button className="secondary" onClick={() => handleRatePlugin(plugin.pluginId)}>
                              Submit
                            </button>
                            {ratingStatus[plugin.pluginId] ? (
                              <span style={{ fontSize: 12, color: 'var(--color-muted-foreground)' }}>{ratingStatus[plugin.pluginId]}</span>
                            ) : null}
                          </div>
                        ) : null}

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
                                <span style={{ fontSize: 12, color: 'var(--color-muted-foreground)' }}>{configStatus[plugin.pluginId]}</span>
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
