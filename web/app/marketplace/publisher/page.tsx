'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, loadSession, ApiError, type PublisherPlugin, type PublisherSkill, type Session } from '@/lib/api-client';
import { Sidebar } from '@/components/Sidebar';

const EXAMPLE_MANIFEST = JSON.stringify({ configSchema: [{ key: 'apiKey', label: 'API Key', type: 'string' }] }, null, 2);
const EXAMPLE_DEFINITION = JSON.stringify(
  { trigger: { type: 'manual' }, steps: [{ id: 'step-1', type: 'tool', tool: 'webhook-send', params: { url: 'https://example.com', payload: {} } }] },
  null,
  2,
);

export default function PublisherDashboardPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [publisherSlug, setPublisherSlug] = useState('');
  const [publisherDisplayName, setPublisherDisplayName] = useState('');

  const [plugins, setPlugins] = useState<PublisherPlugin[]>([]);
  const [skills, setSkills] = useState<PublisherSkill[]>([]);

  const [pluginForm, setPluginForm] = useState({ packageName: '', name: '', description: '', version: '1.0.0', manifest: EXAMPLE_MANIFEST });
  const [skillForm, setSkillForm] = useState({ skillSlug: '', name: '', description: '', priceCents: '0', definition: EXAMPLE_DEFINITION });
  const [submitting, setSubmitting] = useState<'plugin' | 'skill' | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    const s = loadSession();
    if (!s) {
      router.push('/login');
      return;
    }
    setSession(s);
    setReady(true);
    api
      .getOrganization()
      .then((org) => {
        const slug = (org.settings.publisherSlug as string | undefined) ?? '';
        const displayName = (org.settings.publisherDisplayName as string | undefined) ?? '';
        setPublisherSlug(slug);
        setPublisherDisplayName(displayName);
        if (slug) void loadSubmissions(slug);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load organization'));
  }, [router]);

  function loadSubmissions(slug: string) {
    setError(null);
    return Promise.all([api.listPublisherPlugins(slug), api.listPublisherSkills(slug)])
      .then(([pluginsResult, skillsResult]) => {
        setPlugins(pluginsResult.plugins);
        setSkills(skillsResult.skills);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load submissions'));
  }

  async function handleSaveIdentity() {
    try {
      await api.updateOrganization({ settings: { publisherSlug, publisherDisplayName } });
      if (publisherSlug) await loadSubmissions(publisherSlug);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save publisher identity');
    }
  }

  async function handleSubmitPlugin(e: React.FormEvent) {
    e.preventDefault();
    if (!publisherSlug || !publisherDisplayName) {
      setSubmitError('Set your publisher slug/display name above first');
      return;
    }
    setSubmitting('plugin');
    setSubmitError(null);
    try {
      const manifest = JSON.parse(pluginForm.manifest);
      await api.submitPublisherPlugin({
        publisherSlug,
        publisherDisplayName,
        packageName: pluginForm.packageName,
        name: pluginForm.name,
        description: pluginForm.description || undefined,
        version: pluginForm.version,
        manifest,
      });
      await loadSubmissions(publisherSlug);
    } catch (err) {
      setSubmitError(
        err instanceof ApiError ? err.message : err instanceof SyntaxError ? `Invalid JSON: ${err.message}` : 'Failed to submit plugin',
      );
    } finally {
      setSubmitting(null);
    }
  }

  async function handleSubmitSkill(e: React.FormEvent) {
    e.preventDefault();
    if (!publisherSlug || !publisherDisplayName) {
      setSubmitError('Set your publisher slug/display name above first');
      return;
    }
    setSubmitting('skill');
    setSubmitError(null);
    try {
      const definition = JSON.parse(skillForm.definition);
      await api.submitPublisherSkill({
        publisherSlug,
        publisherDisplayName,
        skillSlug: skillForm.skillSlug,
        name: skillForm.name,
        description: skillForm.description || undefined,
        definition,
        priceCents: Number(skillForm.priceCents) || 0,
      });
      await loadSubmissions(publisherSlug);
    } catch (err) {
      setSubmitError(
        err instanceof ApiError ? err.message : err instanceof SyntaxError ? `Invalid JSON: ${err.message}` : 'Failed to submit skill',
      );
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div>
      {session ? <Sidebar session={session} /> : null}

      <div className="page">
        <h1 style={{ fontSize: 'var(--font-size-xl)' }}>Publisher Dashboard</h1>
        <p style={{ color: 'var(--color-muted-foreground)', fontSize: 14 }}>
          Submit Skills and Plugins to the Marketplace, and see everything you've published under your publisher
          slug. There's no per-publisher account system yet (MVP-lite) — anyone with{' '}
          <code>marketplace:publish</code> can submit under any slug.
        </p>

        {error ? <div className="error">{error}</div> : null}

        {!ready ? (
          <p>Loading…</p>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 16 }}>
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Publisher identity</h2>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <label>
                  Slug
                  <input
                    value={publisherSlug}
                    onChange={(e) => setPublisherSlug(e.target.value)}
                    placeholder="my-company"
                  />
                </label>
                <label>
                  Display name
                  <input
                    value={publisherDisplayName}
                    onChange={(e) => setPublisherDisplayName(e.target.value)}
                    placeholder="My Company"
                  />
                </label>
                <button className="secondary" onClick={handleSaveIdentity} style={{ alignSelf: 'flex-end' }}>
                  Save
                </button>
              </div>
            </div>

            {submitError ? <div className="error">{submitError}</div> : null}

            <div className="card" style={{ marginBottom: 16 }}>
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Submit a Plugin</h2>
              <form onSubmit={handleSubmitPlugin} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <label>
                  Package name
                  <input
                    value={pluginForm.packageName}
                    onChange={(e) => setPluginForm((p) => ({ ...p, packageName: e.target.value }))}
                    placeholder="com.example.my-plugin"
                    required
                  />
                </label>
                <label>
                  Name
                  <input value={pluginForm.name} onChange={(e) => setPluginForm((p) => ({ ...p, name: e.target.value }))} required />
                </label>
                <label>
                  Description
                  <input value={pluginForm.description} onChange={(e) => setPluginForm((p) => ({ ...p, description: e.target.value }))} />
                </label>
                <label>
                  Version
                  <input value={pluginForm.version} onChange={(e) => setPluginForm((p) => ({ ...p, version: e.target.value }))} required />
                </label>
                <label>
                  Manifest (JSON)
                  <textarea
                    value={pluginForm.manifest}
                    onChange={(e) => setPluginForm((p) => ({ ...p, manifest: e.target.value }))}
                    rows={8}
                    style={{ fontFamily: 'monospace', fontSize: 13, width: '100%' }}
                  />
                </label>
                <button type="submit" disabled={submitting === 'plugin'}>
                  {submitting === 'plugin' ? 'Submitting…' : 'Submit plugin'}
                </button>
              </form>

              {plugins.length > 0 ? (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 16 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--color-muted-foreground)', fontSize: 11 }}>
                      <th style={{ paddingBottom: 6 }}>Name</th>
                      <th style={{ paddingBottom: 6 }}>Latest version</th>
                      <th style={{ paddingBottom: 6 }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plugins.map((plugin) => (
                      <tr key={plugin.pluginId} style={{ borderTop: '1px solid var(--color-border)' }}>
                        <td style={{ padding: '4px 0' }}>{plugin.name}</td>
                        <td style={{ padding: '4px 0', color: 'var(--color-muted-foreground)' }}>{plugin.latestVersion ?? '—'}</td>
                        <td style={{ padding: '4px 0', color: 'var(--color-muted-foreground)' }}>{plugin.latestVersionStatus ?? plugin.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>

            <div className="card">
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Submit a Skill</h2>
              <form onSubmit={handleSubmitSkill} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <label>
                  Slug
                  <input
                    value={skillForm.skillSlug}
                    onChange={(e) => setSkillForm((s) => ({ ...s, skillSlug: e.target.value }))}
                    placeholder="my-skill"
                    required
                  />
                </label>
                <label>
                  Name
                  <input value={skillForm.name} onChange={(e) => setSkillForm((s) => ({ ...s, name: e.target.value }))} required />
                </label>
                <label>
                  Description
                  <input value={skillForm.description} onChange={(e) => setSkillForm((s) => ({ ...s, description: e.target.value }))} />
                </label>
                <label>
                  Price (cents, 0 = free)
                  <input
                    type="number"
                    min={0}
                    value={skillForm.priceCents}
                    onChange={(e) => setSkillForm((s) => ({ ...s, priceCents: e.target.value }))}
                  />
                </label>
                <label>
                  Definition (JSON)
                  <textarea
                    value={skillForm.definition}
                    onChange={(e) => setSkillForm((s) => ({ ...s, definition: e.target.value }))}
                    rows={8}
                    style={{ fontFamily: 'monospace', fontSize: 13, width: '100%' }}
                  />
                </label>
                <button type="submit" disabled={submitting === 'skill'}>
                  {submitting === 'skill' ? 'Submitting…' : 'Submit skill'}
                </button>
              </form>

              {skills.length > 0 ? (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 16 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--color-muted-foreground)', fontSize: 11 }}>
                      <th style={{ paddingBottom: 6 }}>Name</th>
                      <th style={{ paddingBottom: 6 }}>Price</th>
                      <th style={{ paddingBottom: 6 }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {skills.map((skill) => (
                      <tr key={skill.skillId} style={{ borderTop: '1px solid var(--color-border)' }}>
                        <td style={{ padding: '4px 0' }}>{skill.name}</td>
                        <td style={{ padding: '4px 0', color: 'var(--color-muted-foreground)' }}>
                          {skill.priceCents === 0 ? 'Free' : `$${(skill.priceCents / 100).toFixed(2)}`}
                        </td>
                        <td style={{ padding: '4px 0', color: 'var(--color-muted-foreground)' }}>{skill.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
