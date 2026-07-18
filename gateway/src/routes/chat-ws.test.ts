import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import type { LlmCompletionResult, LlmProvider, LlmStreamChunk } from '@o2n/llm-providers';
import type { Db } from '../db.js';
import type { RedisClient } from '../redis.js';
import { createRedis } from '../redis.js';
import { createTestDb } from '../test-support/db.js';
import { createTestEnv } from '../test-support/env.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { seedRole } from '../test-support/roles.js';
import { EmbeddingService } from '../services/embedding-service.js';
import { PermissionService } from '../services/permission-service.js';
import { PolicyService } from '../services/policy-service.js';
import { ProviderConfigService } from '../services/provider-config-service.js';
import { ActivationState } from '../services/activation-state.js';
import { buildApp } from '../app.js';
import type { AppContext } from '../context.js';

/**
 * RT-090 — same "inject a fake provider" pattern as chat-service.test.ts's
 * FakeProviderConfigService: chatStream()'s own event logic is already
 * covered there, so this suite only exercises the new transport (real
 * WebSocket handshake + query-param auth via plugins/auth.ts's isWsUpgrade
 * branch), not the chat logic itself.
 */
class FakeProviderConfigService extends ProviderConfigService {
  constructor(
    private fakeProvider: LlmProvider,
    env = createTestEnv(),
  ) {
    super({} as Db, env);
  }
  override async resolve(): Promise<{ provider: LlmProvider; model: string; providerName: string }> {
    return { provider: this.fakeProvider, model: 'fake-model', providerName: 'fake' };
  }
}

function fakeProvider(streamChunks: LlmStreamChunk[]): LlmProvider {
  return {
    name: 'fake',
    async complete(): Promise<LlmCompletionResult> {
      throw new Error('not used by chatStream()');
    },
    async *stream(): AsyncIterable<LlmStreamChunk> {
      for (const chunk of streamChunks) yield chunk;
    },
  };
}

describe('routes/chat — WebSocket streaming (RT-090)', () => {
  let db: Db;
  let redis: RedisClient;
  const env = createTestEnv();
  const createdOrgIds: string[] = [];

  beforeAll(() => {
    db = createTestDb();
    redis = createRedis(env.REDIS_URL);
  });

  afterEach(async () => {
    for (const id of createdOrgIds.splice(0)) {
      await cleanupTestFixture(db, id);
    }
  });

  afterAll(async () => {
    redis.disconnect();
    await db.end();
  });

  async function withFixture(): Promise<TestFixture> {
    const fixture = await createTestFixture(db);
    createdOrgIds.push(fixture.organizationId);
    await db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [fixture.userId]);
    // requirePermission(request, 'agents:chat') resolves against
    // user_role_bindings/role_permissions (permission-service.ts), not the
    // legacy users.role column above — createTestFixture() seeds neither.
    const roleId = await seedRole(db, fixture.organizationId, 'chat-tester', ['agents:chat']);
    await db.query(`INSERT INTO user_role_bindings (user_id, role_id, workspace_id) VALUES ($1, $2, $3)`, [
      fixture.userId,
      roleId,
      fixture.workspaceId,
    ]);
    return fixture;
  }

  async function buildTestApp(streamChunks: LlmStreamChunk[]) {
    const ctx: AppContext = {
      env,
      db,
      redis,
      providerConfigService: new FakeProviderConfigService(fakeProvider(streamChunks), env),
      permissionService: new PermissionService(db),
      embeddingService: new EmbeddingService(env),
      policyService: new PolicyService(db),
      activationState: new ActivationState(env),
    };
    const app = await buildApp(ctx);
    await app.ready();
    return app;
  }

  function tokenFor(fixture: TestFixture): string {
    return jwt.sign({ sub: fixture.userId, organizationId: fixture.organizationId, role: 'admin' }, env.JWT_SECRET);
  }

  it('streams token/reasoning/done events over a real WebSocket connection authenticated via query params', async () => {
    const fixture = await withFixture();
    const app = await buildTestApp([
      { delta: 'thinking...', isReasoning: true },
      { delta: 'Hello ' },
      { delta: 'world!' },
    ]);
    const token = tokenFor(fixture);

    const ws = await app.injectWS(
      `/v1/agents/${fixture.agentId}/chat/ws?token=${token}&organizationId=${fixture.organizationId}`,
    );

    const events: { type: string }[] = [];
    const done = new Promise<void>((resolve, reject) => {
      ws.on('message', (raw: Buffer) => {
        try {
          const event = JSON.parse(raw.toString()) as { type: string };
          events.push(event);
          if (event.type === 'done') resolve();
        } catch (err) {
          reject(err);
        }
      });
      ws.on('error', reject);
    });

    ws.send(JSON.stringify({ message: 'hi' }));
    await done;
    ws.close();
    await app.close();

    expect(events).toEqual([
      { type: 'reasoning', delta: 'thinking...' },
      { type: 'token', delta: 'Hello ' },
      { type: 'token', delta: 'world!' },
      expect.objectContaining({ type: 'done' }),
    ]);
  });

  it('rejects the handshake when the token query param is missing', async () => {
    const fixture = await withFixture();
    const app = await buildTestApp([]);

    await expect(
      app.injectWS(`/v1/agents/${fixture.agentId}/chat/ws?organizationId=${fixture.organizationId}`),
    ).rejects.toThrow();

    await app.close();
  });

  it('rejects the handshake when organizationId does not match the token claim', async () => {
    const fixture = await withFixture();
    const app = await buildTestApp([]);
    const token = tokenFor(fixture);

    await expect(
      app.injectWS(`/v1/agents/${fixture.agentId}/chat/ws?token=${token}&organizationId=some-other-org`),
    ).rejects.toThrow();

    await app.close();
  });

  it('sends an error frame (not a thrown exception) for an invalid JSON payload, without closing the connection', async () => {
    const fixture = await withFixture();
    const app = await buildTestApp([{ delta: 'ok' }]);
    const token = tokenFor(fixture);

    const ws = await app.injectWS(
      `/v1/agents/${fixture.agentId}/chat/ws?token=${token}&organizationId=${fixture.organizationId}`,
    );

    const firstMessage = new Promise<{ type: string }>((resolve, reject) => {
      ws.once('message', (raw: Buffer) => {
        try {
          resolve(JSON.parse(raw.toString()) as { type: string });
        } catch (err) {
          reject(err);
        }
      });
      ws.on('error', reject);
    });

    ws.send('not valid json');
    const event = await firstMessage;
    expect(event).toEqual({ type: 'error', message: 'Invalid JSON payload' });

    ws.close();
    await app.close();
  });
});
