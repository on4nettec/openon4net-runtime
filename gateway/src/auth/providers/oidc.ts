import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../../context.js';
import { OrgService } from '../../services/org-service.js';
import { UserService } from '../../services/user-service.js';
import { SsoConfigService } from '../../services/sso-config-service.js';
import type { AuthProvider } from '../types.js';
import { issueSession, logLoginAudit } from '../session.js';

const STATE_TTL_SECONDS = 600;

export interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

export interface OidcIdentity {
  sub: string;
  email: string;
}

/**
 * Enterprise SSO is per-org (RT-068) — unlike auth/providers/oauth.ts's
 * google/github (two fixed providers, global env config), any IdP works
 * here as long as it's spec-compliant OIDC, because the endpoints come from
 * discovery instead of a hardcoded PROVIDER_META table. Deliberately no
 * `openid-client` dependency: the flow itself (authorize redirect, code
 * exchange, userinfo fetch) is exactly what oauth.ts already does by hand —
 * only the endpoint *discovery* step is new, and that's a single fetch.
 */
async function safeFetch(url: string, init: RequestInit, label: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`${label} request failed: ${message}`);
  }
}

/** Exported for testing (oidc.test.ts) against a real local HTTP server standing in for an IdP — see marketplace-client.test.ts for the same "fake the network boundary" pattern. */
export async function discover(issuerUrl: string): Promise<OidcDiscovery> {
  const res = await safeFetch(`${issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`, {}, 'OIDC discovery');
  if (!res.ok) throw new ValidationError(`OIDC discovery failed: HTTP ${res.status}`);
  return (await res.json()) as OidcDiscovery;
}

function buildRedirectUri(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/v1/auth/oidc/callback`;
}

/**
 * Exchanges an authorization code for the caller's identity — the code
 * exchange + userinfo fetch, extracted from the callback route so it's
 * testable without a full Fastify app/DB/Redis (oidc.test.ts). Spec-compliant
 * OIDC token endpoints require application/x-www-form-urlencoded (RFC 6749
 * §4.1.3) — unlike oauth.ts's JSON body, which only works because
 * Google/GitHub's parsers are lenient. Real enterprise IdPs (Okta, Azure AD)
 * enforce the spec.
 */
export async function exchangeCodeForIdentity(
  discovery: OidcDiscovery,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<OidcIdentity> {
  const tokenRes = await safeFetch(
    discovery.token_endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    },
    'OIDC token exchange',
  );
  if (!tokenRes.ok) throw new ValidationError(`OIDC token exchange failed: HTTP ${tokenRes.status}`);
  const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenBody.access_token) {
    throw new ValidationError(`OIDC token exchange failed: ${tokenBody.error ?? 'no access_token in response'}`);
  }

  const userinfoRes = await safeFetch(
    discovery.userinfo_endpoint,
    { headers: { Authorization: `Bearer ${tokenBody.access_token}` } },
    'OIDC userinfo',
  );
  if (!userinfoRes.ok) throw new ValidationError(`OIDC userinfo request failed: HTTP ${userinfoRes.status}`);
  const identity = (await userinfoRes.json()) as { sub: string; email?: string };
  if (!identity.email) throw new ValidationError('OIDC identity has no email to sign in with');
  return { sub: identity.sub, email: identity.email };
}

export const oidcProvider: AuthProvider = {
  name: 'oidc',
  register(app: FastifyInstance, ctx: AppContext): void {
    const orgService = new OrgService(ctx.db);
    const userService = new UserService(ctx.db);
    const ssoConfigService = new SsoConfigService(ctx.db, ctx.env);

    app.get<{ Querystring: { organizationSlug?: string } }>('/v1/auth/oidc/start', async (request, reply) => {
      const organizationSlug = request.query.organizationSlug;
      if (!organizationSlug) throw new ValidationError('organizationSlug query parameter is required');

      const orgAndWorkspace = await orgService.findOrgAndWorkspaceBySlug(organizationSlug);
      if (!orgAndWorkspace) throw new ValidationError('Invalid organization'); // same generic message convention as password/oauth

      const config = await ssoConfigService.resolve(orgAndWorkspace.organization.id);
      if (!config || config.protocol !== 'oidc') throw new ValidationError('OIDC is not configured for this organization');
      if (!ctx.env.SSO_CALLBACK_URL) throw new ValidationError('OIDC is not configured (missing SSO_CALLBACK_URL)');

      const discovery = await discover(config.config.issuerUrl!);

      const state = randomBytes(16).toString('hex');
      await ctx.redis.set(`oidc_state:${state}`, JSON.stringify({ organizationSlug }), 'EX', STATE_TTL_SECONDS);

      const url = new URL(discovery.authorization_endpoint);
      url.searchParams.set('client_id', config.config.clientId!);
      url.searchParams.set('redirect_uri', buildRedirectUri(ctx.env.SSO_CALLBACK_URL));
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'openid email');
      url.searchParams.set('state', state);
      return reply.redirect(url.toString());
    });

    app.get<{ Querystring: { code?: string; state?: string } }>('/v1/auth/oidc/callback', async (request) => {
      const { code, state } = request.query;
      if (!code || !state) throw new ValidationError('Missing code or state');

      const stateRaw = await ctx.redis.get(`oidc_state:${state}`);
      if (!stateRaw) throw new ValidationError('This login attempt has expired — please try again');
      await ctx.redis.del(`oidc_state:${state}`);
      const { organizationSlug } = JSON.parse(stateRaw) as { organizationSlug: string };

      const orgAndWorkspace = await orgService.findOrgAndWorkspaceBySlug(organizationSlug);
      if (!orgAndWorkspace) throw new ValidationError('Organization no longer exists');

      const config = await ssoConfigService.resolve(orgAndWorkspace.organization.id);
      if (!config || config.protocol !== 'oidc' || !config.secret) {
        throw new ValidationError('OIDC is not configured for this organization');
      }
      if (!ctx.env.SSO_CALLBACK_URL) throw new ValidationError('OIDC is not configured (missing SSO_CALLBACK_URL)');

      const discovery = await discover(config.config.issuerUrl!);
      const identity = await exchangeCodeForIdentity(
        discovery,
        config.config.clientId!,
        config.secret,
        code,
        buildRedirectUri(ctx.env.SSO_CALLBACK_URL),
      );

      const authRecord = await userService.findAuthRecordByEmail(orgAndWorkspace.organization.id, identity.email);
      if (!authRecord || !authRecord.isActive) {
        await logLoginAudit(ctx, request, {
          organizationId: orgAndWorkspace.organization.id,
          userId: authRecord?.id ?? null,
          authMethod: 'oidc',
          status: 'failed',
          reason: 'no_matching_account',
        });
        // Deliberately does NOT auto-provision — same trust model as
        // oauth.ts: SSO only signs in an account an admin already created.
        throw new ValidationError(`No account found for ${identity.email} in this organization`);
      }

      await userService.linkOauthIdentity(authRecord.id, 'oidc', identity.sub);
      const session = issueSession(ctx, orgAndWorkspace.organization, orgAndWorkspace.workspace, {
        id: authRecord.id,
        role: authRecord.role,
      });
      await logLoginAudit(ctx, request, {
        organizationId: orgAndWorkspace.organization.id,
        userId: authRecord.id,
        authMethod: 'oidc',
        status: 'success',
      });
      return session;
    });
  },
};
