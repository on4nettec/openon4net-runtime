import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { discover, exchangeCodeForIdentity } from './oidc.js';

/**
 * A local http.createServer stands in for a real OIDC IdP (Okta, Azure AD,
 * ...) — same "fake the network boundary, exercise the real logic" pattern
 * as marketplace-client.test.ts. This exercises the actual discovery fetch,
 * the RFC-6749-compliant form-urlencoded token exchange (the one place this
 * genuinely differs from auth/providers/oauth.ts's JSON body), and the
 * userinfo fetch — real HTTP round trips, not mocked fetch calls. The
 * full login flow (starting from GET /v1/auth/oidc/start through a real
 * browser redirect) still isn't automatable without a live IdP or a much
 * heavier interactive-consent test harness — this is genuine coverage of
 * the part that's actually new/custom in this provider.
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

describe('oidc discovery + code exchange', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server!.close(resolve));
      server = undefined;
    }
  });

  it('discover() fetches and parses a real .well-known/openid-configuration document', async () => {
    server = createServer((req, res) => {
      if (req.url === '/.well-known/openid-configuration') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            authorization_endpoint: 'http://example.test/authorize',
            token_endpoint: 'http://example.test/token',
            userinfo_endpoint: 'http://example.test/userinfo',
          }),
        );
      }
    });
    const port = await listen(server);

    const discovery = await discover(`http://127.0.0.1:${port}`);
    expect(discovery.authorization_endpoint).toBe('http://example.test/authorize');
    expect(discovery.token_endpoint).toBe('http://example.test/token');
  });

  it('discover() throws with a clear message on a non-200 response', async () => {
    server = createServer((req, res) => {
      res.statusCode = 404;
      res.end('not found');
    });
    const port = await listen(server);

    await expect(discover(`http://127.0.0.1:${port}`)).rejects.toThrow('OIDC discovery failed: HTTP 404');
  });

  it('exchangeCodeForIdentity() POSTs the token request as application/x-www-form-urlencoded (RFC 6749), not JSON', async () => {
    let receivedContentType: string | undefined;
    let receivedBody: string | undefined;
    server = createServer(async (req, res) => {
      if (req.url === '/token') {
        receivedContentType = req.headers['content-type'];
        receivedBody = await readBody(req);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: 'fake-access-token' }));
      } else if (req.url === '/userinfo') {
        expect(req.headers.authorization).toBe('Bearer fake-access-token');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ sub: 'user-123', email: 'person@example.com' }));
      }
    });
    const port = await listen(server);
    const discovery = {
      authorization_endpoint: `http://127.0.0.1:${port}/authorize`,
      token_endpoint: `http://127.0.0.1:${port}/token`,
      userinfo_endpoint: `http://127.0.0.1:${port}/userinfo`,
    };

    const identity = await exchangeCodeForIdentity(discovery, 'client-id', 'client-secret', 'auth-code', 'http://gateway.test/callback');

    expect(receivedContentType).toBe('application/x-www-form-urlencoded');
    const params = new URLSearchParams(receivedBody);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('client_id')).toBe('client-id');
    expect(params.get('client_secret')).toBe('client-secret');
    expect(params.get('code')).toBe('auth-code');
    expect(params.get('redirect_uri')).toBe('http://gateway.test/callback');
    expect(identity).toEqual({ sub: 'user-123', email: 'person@example.com' });
  });

  it('exchangeCodeForIdentity() throws when the IdP has no email claim', async () => {
    server = createServer((req, res) => {
      if (req.url === '/token') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: 'fake-access-token' }));
      } else if (req.url === '/userinfo') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ sub: 'user-123' })); // no email
      }
    });
    const port = await listen(server);
    const discovery = {
      authorization_endpoint: `http://127.0.0.1:${port}/authorize`,
      token_endpoint: `http://127.0.0.1:${port}/token`,
      userinfo_endpoint: `http://127.0.0.1:${port}/userinfo`,
    };

    await expect(
      exchangeCodeForIdentity(discovery, 'client-id', 'client-secret', 'auth-code', 'http://gateway.test/callback'),
    ).rejects.toThrow('no email');
  });

  it('exchangeCodeForIdentity() throws when the token endpoint rejects the code', async () => {
    server = createServer((req, res) => {
      if (req.url === '/token') {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'invalid_grant' }));
      }
    });
    const port = await listen(server);
    const discovery = {
      authorization_endpoint: `http://127.0.0.1:${port}/authorize`,
      token_endpoint: `http://127.0.0.1:${port}/token`,
      userinfo_endpoint: `http://127.0.0.1:${port}/userinfo`,
    };

    await expect(
      exchangeCodeForIdentity(discovery, 'client-id', 'client-secret', 'bad-code', 'http://gateway.test/callback'),
    ).rejects.toThrow('OIDC token exchange failed');
  });
});
