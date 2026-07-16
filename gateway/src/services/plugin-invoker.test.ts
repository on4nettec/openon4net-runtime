import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundError, PermissionDeniedError, ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { createTestContext } from '../test-support/context.js';
import { createTestEnv } from '../test-support/env.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { PluginGrantService } from './plugin-grant-service.js';
import { PluginSchemaService } from './plugin-schema-service.js';
import { LocalPluginService } from './local-plugin-service.js';
import { executePluginStep } from './plugin-invoker.js';

/**
 * Two local servers stand in for (1) apps/openon4net-marketplace (a
 * separate repo/service — same rationale as marketplace-client.test.ts)
 * and (2) the plugin's own declared HTTP-provider endpoint — the thing
 * RT-079 actually invokes.
 */
function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => resolve((server.address() as AddressInfo).port));
  });
}

describe('executePluginStep (RT-079)', () => {
  const servers: Server[] = [];
  const createdOrgIds: string[] = [];
  let dbCtx: AppContext;

  beforeAll(() => {
    dbCtx = createTestContext();
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise((resolve) => server.close(resolve));
    }
    for (const id of createdOrgIds.splice(0)) {
      await cleanupTestFixture(dbCtx.db, id);
    }
  });

  afterAll(async () => {
    await dbCtx.db.end();
    dbCtx.redis.disconnect();
  });

  async function withFixture(): Promise<TestFixture> {
    const fixture = await createTestFixture(dbCtx.db);
    createdOrgIds.push(fixture.organizationId);
    return fixture;
  }

  /** Reuses dbCtx's real db/redis (no per-test connection leak) — only env.MARKETPLACE_SERVICE_URL varies. */
  function ctxWithMarketplaceUrl(port: number): AppContext {
    return { ...dbCtx, env: createTestEnv({ MARKETPLACE_SERVICE_URL: `http://127.0.0.1:${port}` }) };
  }

  async function startMarketplaceServer(pluginId: string, manifest: Record<string, unknown> | null): Promise<number> {
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === `/marketplace/plugins/${pluginId}`) {
        res.end(
          JSON.stringify({
            pluginId,
            packageName: 'com.o2n.test-provider',
            name: 'Test Provider',
            description: null,
            publisherSlug: 'acme',
            publisherVerified: false,
            latestVersion: '1.0.0',
            manifest,
            permissions: [],
            installCount: 0,
            avgRating: null,
            ratingCount: 0,
            priceCredits: null,
            createdAt: '2026-01-01T00:00:00Z',
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
    });
    servers.push(server);
    return listen(server);
  }

  it(
    'invokes the provider baseUrl when the agent has a grant and the manifest declares an http provider',
    async () => {
      // assertSafeWebhookUrl rejects loopback/private addresses (real SSRF guard,
      // same one webhook-send uses) — so, like workflow-executor.test.ts's tool
      // steps, the actual provider endpoint has to be a real external host, not a
      // local server. postman-echo.com echoes the posted JSON back under `json`.
      const fixture = await withFixture();
      const pluginId = randomUUID();
      const mktPort = await startMarketplaceServer(pluginId, {
        provider: { type: 'http', baseUrl: 'https://postman-echo.com/post' },
      });
      const ctx = ctxWithMarketplaceUrl(mktPort);

      await new PluginGrantService(dbCtx.db).grant(fixture.agentId, pluginId, fixture.userId);

      const result = await executePluginStep(ctx, fixture.organizationId, fixture.agentId, pluginId, { foo: 'bar' });
      expect(result.statusCode).toBe(200);
      // RT-076: params get merged with prior persisted state (empty here — nothing written yet) as `_state`.
      expect((result.body as { json?: unknown }).json).toEqual({ foo: 'bar', _state: {} });
    },
    15000,
  );

  it(
    'RT-076: includes prior persisted state as `_state` in the outgoing request',
    async () => {
      const fixture = await withFixture();
      const pluginId = randomUUID();
      const mktPort = await startMarketplaceServer(pluginId, {
        provider: { type: 'http', baseUrl: 'https://postman-echo.com/post' },
      });
      const ctx = ctxWithMarketplaceUrl(mktPort);

      await new PluginGrantService(dbCtx.db).grant(fixture.agentId, pluginId, fixture.userId);
      await new PluginSchemaService(dbCtx.db).writeAll(fixture.organizationId, pluginId, { visitCount: 7 });

      const result = await executePluginStep(ctx, fixture.organizationId, fixture.agentId, pluginId, { foo: 'bar' });
      expect((result.body as { json?: unknown }).json).toEqual({ foo: 'bar', _state: { visitCount: 7 } });
    },
    15000,
  );

  it('throws PermissionDeniedError when the agent has no grant for the plugin', async () => {
    const fixture = await withFixture();
    const pluginId = randomUUID();
    const mktPort = await startMarketplaceServer(pluginId, { provider: { type: 'http', baseUrl: 'https://postman-echo.com/post' } });
    const ctx = ctxWithMarketplaceUrl(mktPort);

    await expect(executePluginStep(ctx, fixture.organizationId, fixture.agentId, pluginId, {})).rejects.toThrow(PermissionDeniedError);
  });

  it('throws NotFoundError when the plugin does not exist in Marketplace', async () => {
    const fixture = await withFixture();
    const pluginId = randomUUID();
    const mktPort = await startMarketplaceServer(randomUUID(), null); // registers a different id
    const ctx = ctxWithMarketplaceUrl(mktPort);

    await new PluginGrantService(dbCtx.db).grant(fixture.agentId, pluginId, fixture.userId);
    await expect(executePluginStep(ctx, fixture.organizationId, fixture.agentId, pluginId, {})).rejects.toThrow(NotFoundError);
  });

  it('throws ValidationError when the plugin manifest does not declare an http provider', async () => {
    const fixture = await withFixture();
    const pluginId = randomUUID();
    const mktPort = await startMarketplaceServer(pluginId, { configSchema: [] }); // no `provider` field
    const ctx = ctxWithMarketplaceUrl(mktPort);

    await new PluginGrantService(dbCtx.db).grant(fixture.agentId, pluginId, fixture.userId);
    await expect(executePluginStep(ctx, fixture.organizationId, fixture.agentId, pluginId, {})).rejects.toThrow(ValidationError);
  });

  it(
    'RT-077: resolves a self-hosted local plugin without ever needing Marketplace configured',
    async () => {
      const fixture = await withFixture();
      const local = await new LocalPluginService(dbCtx.db).create(
        fixture.organizationId,
        { name: 'Local echo', manifest: { provider: { type: 'http', baseUrl: 'https://postman-echo.com/post' } } },
        fixture.userId,
      );
      await new PluginGrantService(dbCtx.db).grant(fixture.agentId, local.id, fixture.userId);

      // No marketplace server started at all, and MARKETPLACE_SERVICE_URL is
      // explicitly unset — if this ever fell through to the Marketplace path,
      // it would throw the "not configured" error instead of succeeding.
      const ctx: AppContext = { ...dbCtx, env: createTestEnv({ MARKETPLACE_SERVICE_URL: undefined }) };

      const result = await executePluginStep(ctx, fixture.organizationId, fixture.agentId, local.id, { foo: 'bar' });
      expect(result.statusCode).toBe(200);
      expect((result.body as { json?: unknown }).json).toEqual({ foo: 'bar', _state: {} });
    },
    15000,
  );

  it('RT-077: a local plugin registered for one organization is invisible to another organization (falls through to Marketplace, then 404s there too)', async () => {
    const fixtureA = await withFixture();
    const fixtureB = await withFixture();
    const local = await new LocalPluginService(dbCtx.db).create(
      fixtureA.organizationId,
      { name: 'Org A only', manifest: { provider: { type: 'http', baseUrl: 'https://postman-echo.com/post' } } },
      fixtureA.userId,
    );
    await new PluginGrantService(dbCtx.db).grant(fixtureB.agentId, local.id, fixtureB.userId);
    // Not found locally for org B -> falls through to Marketplace, which
    // genuinely doesn't know this id either (registers a *different* id).
    const mktPort = await startMarketplaceServer(randomUUID(), null);
    const ctx = ctxWithMarketplaceUrl(mktPort);

    await expect(executePluginStep(ctx, fixtureB.organizationId, fixtureB.agentId, local.id, {})).rejects.toThrow(NotFoundError);
  });
});
