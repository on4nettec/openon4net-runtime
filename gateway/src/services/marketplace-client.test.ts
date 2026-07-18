import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestEnv } from '../test-support/env.js';
import { marketplaceClient } from './marketplace-client.js';

/**
 * apps/openon4net-marketplace is a separate repo/service — spinning up its
 * actual Fastify app from inside Runtime's test suite would be a cross-repo
 * dependency that doesn't exist today. A small local http.createServer
 * stands in for the one endpoint shape being called per test, so this
 * exercises marketplaceRequest()'s real fetch/header/parse/error-handling
 * logic against a genuine HTTP round-trip, not a mocked method. The remote
 * service's own business logic is covered by its own repo's tests (see
 * marketplace-skill-service.test.ts).
 */
function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => resolve((server.address() as AddressInfo).port));
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

describe('marketplace-client', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server!.close(resolve));
      server = undefined;
    }
  });

  it('throws when MARKETPLACE_SERVICE_URL is not configured', async () => {
    const env = createTestEnv({ MARKETPLACE_SERVICE_URL: undefined });
    await expect(marketplaceClient.listPlugins(env)).rejects.toThrow('MARKETPLACE_SERVICE_URL is not configured');
  });

  it('sends the API key as a Bearer token and parses the plugin listing', async () => {
    let receivedAuth: string | undefined;
    server = createServer((req, res) => {
      receivedAuth = req.headers.authorization;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ plugins: [{ pluginId: 'p1', packageName: 'com.o2n.p1', name: 'Plugin One', description: null, publisherSlug: 'acme', publisherVerified: true, latestVersion: '1.0.0', manifest: null, createdAt: '2026-01-01T00:00:00Z' }], total: 1 }));
    });
    const port = await listen(server);

    const env = createTestEnv({
      MARKETPLACE_SERVICE_URL: `http://127.0.0.1:${port}`,
      MARKETPLACE_API_KEY: 'test-marketplace-key',
    });

    const result = await marketplaceClient.listPlugins(env);
    expect(receivedAuth).toBe('Bearer test-marketplace-key');
    expect(result.total).toBe(1);
    expect(result.plugins[0]?.pluginId).toBe('p1');
  });

  it('POSTs the organizationId when installing a plugin', async () => {
    let receivedBody: string | undefined;
    server = createServer(async (req, res) => {
      receivedBody = await readBody(req);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ installId: 'i1', pluginId: 'p1', version: '1.0.0', isActive: true }));
    });
    const port = await listen(server);

    const env = createTestEnv({ MARKETPLACE_SERVICE_URL: `http://127.0.0.1:${port}` });
    const result = await marketplaceClient.installPlugin(env, 'p1', 'org-1');

    expect(JSON.parse(receivedBody ?? '{}')).toEqual({ organizationId: 'org-1' });
    expect(result).toEqual({ installId: 'i1', pluginId: 'p1', version: '1.0.0', isActive: true });
  });

  it('surfaces the remote error message on a non-2xx response', async () => {
    server = createServer((req, res) => {
      res.statusCode = 402;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'Marketplace is disabled' } }));
    });
    const port = await listen(server);

    const env = createTestEnv({ MARKETPLACE_SERVICE_URL: `http://127.0.0.1:${port}` });
    await expect(marketplaceClient.listSkills(env)).rejects.toThrow('Marketplace is disabled');
  });

  it('getPlugin() returns the priced item on a 200', async () => {
    server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          pluginId: 'p1',
          packageName: 'com.o2n.p1',
          name: 'Plugin One',
          description: null,
          publisherSlug: 'acme',
          publisherVerified: true,
          latestVersion: '1.0.0',
          manifest: null,
          permissions: [],
          installCount: 0,
          avgRating: null,
          ratingCount: 0,
          priceCredits: 500,
          createdAt: '2026-01-01T00:00:00Z',
        }),
      );
    });
    const port = await listen(server);
    const env = createTestEnv({ MARKETPLACE_SERVICE_URL: `http://127.0.0.1:${port}` });

    const plugin = await marketplaceClient.getPlugin(env, 'p1');
    expect(plugin?.priceCredits).toBe(500);
  });

  it('getPlugin() returns null instead of throwing on a 404 (RT-057 — install treats this as "no such item")', async () => {
    server = createServer((req, res) => {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Plugin not found' } }));
    });
    const port = await listen(server);
    const env = createTestEnv({ MARKETPLACE_SERVICE_URL: `http://127.0.0.1:${port}` });

    expect(await marketplaceClient.getPlugin(env, 'missing')).toBeNull();
  });

  it('getPlugin() still throws for a non-404 error', async () => {
    server = createServer((req, res) => {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'boom' } }));
    });
    const port = await listen(server);
    const env = createTestEnv({ MARKETPLACE_SERVICE_URL: `http://127.0.0.1:${port}` });

    await expect(marketplaceClient.getPlugin(env, 'p1')).rejects.toThrow('boom');
  });

  it('getSkill() returns null instead of throwing on a 404', async () => {
    server = createServer((req, res) => {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Skill not found' } }));
    });
    const port = await listen(server);
    const env = createTestEnv({ MARKETPLACE_SERVICE_URL: `http://127.0.0.1:${port}` });

    expect(await marketplaceClient.getSkill(env, 'missing')).toBeNull();
  });

  it('PATCHes install config with organizationId and config in the body', async () => {
    let receivedBody: string | undefined;
    let receivedMethod: string | undefined;
    server = createServer(async (req, res) => {
      receivedMethod = req.method;
      receivedBody = await readBody(req);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ installId: 'i1', config: { apiKey: 'secret' } }));
    });
    const port = await listen(server);

    const env = createTestEnv({ MARKETPLACE_SERVICE_URL: `http://127.0.0.1:${port}` });
    const result = await marketplaceClient.updatePluginInstallConfig(env, 'i1', 'org-1', { apiKey: 'secret' });

    expect(receivedMethod).toBe('PATCH');
    expect(JSON.parse(receivedBody ?? '{}')).toEqual({ organizationId: 'org-1', config: { apiKey: 'secret' } });
    expect(result).toEqual({ installId: 'i1', config: { apiKey: 'secret' } });
  });

  describe('RT-093 — CP-034 proxy routing', () => {
    it('installPlugin() routes through CONTROL_PLANE_URL/v1/proxy with the security token as Bearer, when both are available', async () => {
      let receivedAuth: string | undefined;
      let receivedPath: string | undefined;
      server = createServer(async (req, res) => {
        receivedAuth = req.headers.authorization;
        receivedPath = req.url;
        await readBody(req);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ installId: 'i1' }));
      });
      const port = await listen(server);

      // MARKETPLACE_SERVICE_URL is deliberately a dead address — proving the
      // proxy path is genuinely used instead, not silently falling back.
      const env = createTestEnv({
        MARKETPLACE_SERVICE_URL: 'http://127.0.0.1:1',
        MARKETPLACE_API_KEY: 'should-not-be-used',
        CONTROL_PLANE_URL: `http://127.0.0.1:${port}`,
      });

      const result = await marketplaceClient.installPlugin(env, 'p1', 'org-1', {}, 'fake-security-token');

      expect(receivedAuth).toBe('Bearer fake-security-token');
      expect(receivedPath).toBe('/v1/proxy/marketplace/plugins/p1/install');
      expect(result).toEqual({ installId: 'i1' });
    });

    it('installPlugin() falls back to the direct MARKETPLACE_API_KEY path when no security token is passed', async () => {
      let receivedAuth: string | undefined;
      server = createServer(async (req, res) => {
        receivedAuth = req.headers.authorization;
        await readBody(req);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ installId: 'i1' }));
      });
      const port = await listen(server);

      const env = createTestEnv({
        MARKETPLACE_SERVICE_URL: `http://127.0.0.1:${port}`,
        MARKETPLACE_API_KEY: 'direct-marketplace-key',
        CONTROL_PLANE_URL: 'http://127.0.0.1:1', // configured, but no token passed -> must not be used
      });

      await marketplaceClient.installPlugin(env, 'p1', 'org-1');

      expect(receivedAuth).toBe('Bearer direct-marketplace-key');
    });

    it('listPlugins() (read-only discovery) always goes direct to Marketplace, even when a security token exists elsewhere', async () => {
      let hitCount = 0;
      server = createServer((req, res) => {
        hitCount += 1;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ plugins: [], total: 0 }));
      });
      const port = await listen(server);

      const env = createTestEnv({
        MARKETPLACE_SERVICE_URL: `http://127.0.0.1:${port}`,
        CONTROL_PLANE_URL: 'http://127.0.0.1:1', // would fail hard if this were ever used
      });

      await marketplaceClient.listPlugins(env);
      expect(hitCount).toBe(1);
    });
  });
});
