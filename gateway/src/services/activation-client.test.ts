import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestEnv } from '../test-support/env.js';
import { checkIn } from './activation-client.js';

/**
 * No real Control-Plane instance to talk to from Runtime's own test suite
 * (cross-repo dependency) — same reasoning as marketplace-client.test.ts:
 * a small local http.createServer standing in for the one endpoint shape
 * being called, so this is a genuine HTTP round-trip through fetch(), not a
 * mocked method.
 */
function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => resolve((server.address() as AddressInfo).port));
  });
}

describe('activation-client', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server!.close(resolve));
      server = undefined;
    }
  });

  it('returns null when CONTROL_PLANE_URL/ACTIVATION_KEY are unconfigured', async () => {
    const env = createTestEnv({ CONTROL_PLANE_URL: undefined, ACTIVATION_KEY: undefined });
    await expect(checkIn(env)).resolves.toBeNull();
  });

  it('sends the activation key as a Bearer token and parses a successful check-in', async () => {
    let receivedAuth: string | undefined;
    server = createServer((req, res) => {
      receivedAuth = req.headers.authorization;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          organizationId: 'org-1',
          organizationName: 'Acme',
          plan: 'pro',
          status: 'active',
          policy: { allowedModels: ['gpt-4o-mini'], allowedProviders: ['openai'], governanceThresholds: { approvalThresholdCents: 2000 } },
          featureFlags: { skills: true },
          activationType: 'organizational',
          maxUsers: 3,
          aiGatewayEnabled: false,
          securityToken: 'fake-security-token',
        }),
      );
    });
    const port = await listen(server);

    const env = createTestEnv({
      CONTROL_PLANE_URL: `http://127.0.0.1:${port}`,
      ACTIVATION_KEY: 'test-activation-key',
    });

    const result = await checkIn(env);
    expect(receivedAuth).toBe('Bearer test-activation-key');
    expect(result).toEqual({
      organizationId: 'org-1',
      organizationName: 'Acme',
      plan: 'pro',
      status: 'active',
      policy: { allowedModels: ['gpt-4o-mini'], allowedProviders: ['openai'], governanceThresholds: { approvalThresholdCents: 2000 } },
      featureFlags: { skills: true },
      activationType: 'organizational',
      maxUsers: 3,
      aiGatewayEnabled: false,
      securityToken: 'fake-security-token',
    });
  });

  it('RT-092 — activationKeyOverride wins over env.ACTIVATION_KEY', async () => {
    let receivedAuth: string | undefined;
    server = createServer((req, res) => {
      receivedAuth = req.headers.authorization;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          organizationId: 'org-1',
          organizationName: 'Acme',
          plan: 'pro',
          status: 'active',
          policy: { allowedModels: [], allowedProviders: [], governanceThresholds: { approvalThresholdCents: 2000 } },
          featureFlags: {},
          activationType: 'organizational',
          maxUsers: null,
          aiGatewayEnabled: false,
          securityToken: 'fake-security-token',
        }),
      );
    });
    const port = await listen(server);

    const env = createTestEnv({
      CONTROL_PLANE_URL: `http://127.0.0.1:${port}`,
      ACTIVATION_KEY: 'env-configured-key',
    });

    await checkIn(env, 'freshly-typed-override-key');
    expect(receivedAuth).toBe('Bearer freshly-typed-override-key');
  });

  it('returns null (never throws) on a non-2xx response', async () => {
    server = createServer((req, res) => {
      res.statusCode = 401;
      res.end('unauthorized');
    });
    const port = await listen(server);

    const env = createTestEnv({
      CONTROL_PLANE_URL: `http://127.0.0.1:${port}`,
      ACTIVATION_KEY: 'wrong-key',
    });

    await expect(checkIn(env)).resolves.toBeNull();
  });

  it('returns null (never throws) when the connection is refused', async () => {
    const env = createTestEnv({
      CONTROL_PLANE_URL: 'http://127.0.0.1:1',
      ACTIVATION_KEY: 'test-activation-key',
    });

    await expect(checkIn(env)).resolves.toBeNull();
  });
});
