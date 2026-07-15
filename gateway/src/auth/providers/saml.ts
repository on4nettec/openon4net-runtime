import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { SAML } from '@node-saml/node-saml';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../../context.js';
import { OrgService } from '../../services/org-service.js';
import { UserService } from '../../services/user-service.js';
import { SsoConfigService } from '../../services/sso-config-service.js';
import type { AuthProvider } from '../types.js';
import { issueSession, logLoginAudit } from '../session.js';

const STATE_TTL_SECONDS = 600;

export interface SamlIdentity {
  email: string;
  nameId: string;
}

function acsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/v1/auth/saml/acs`;
}

/** Exported for testing (saml.test.ts) — constructs the same @node-saml/node-saml client the route handlers use. */
export function createSamlClient(entityId: string, ssoUrl: string, idpCert: string, callbackBaseUrl: string): SAML {
  return new SAML({
    callbackUrl: acsUrl(callbackBaseUrl),
    entryPoint: ssoUrl,
    issuer: callbackBaseUrl,
    idpCert,
    wantAssertionsSigned: true,
    // node-saml's own entityId field is separate from `issuer` — for a
    // v1 single-SP setup they're the same value.
    audience: entityId,
  });
}

/**
 * Validates a SAMLResponse (signature + assertion) and extracts the
 * identity — extracted from the ACS route so the "reject a malformed/
 * unsigned assertion" behavior is directly testable without a full Fastify
 * app/DB/Redis (saml.test.ts). Throws ValidationError on any validation
 * failure — callers don't need to know node-saml's own error shape.
 */
export async function extractIdentityFromAssertion(saml: SAML, samlResponse: string): Promise<SamlIdentity> {
  let result;
  try {
    result = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`SAML assertion validation failed: ${message}`);
  }
  // node-saml's Profile has typed `email`/`mail` fields plus an index
  // signature for arbitrary IdP-specific attribute URIs — different IdPs
  // claim the address under different names, so check the two common ones
  // explicitly rather than assuming one.
  const email = result.profile?.email ?? result.profile?.mail;
  if (!email) throw new ValidationError('SAML assertion has no email attribute to sign in with');
  return { email, nameId: result.profile?.nameID ?? '' };
}

/**
 * Enterprise SSO, SAML flavor (RT-069) — the counterpart to oidc.ts, for
 * IdPs that only speak SAML (common in older enterprise environments).
 * Uses @node-saml/node-saml for AuthnRequest generation and signed-assertion
 * validation — unlike OIDC's plain REST calls, hand-rolling XML signature
 * verification would be a real security risk, so this is the one place in
 * the auth registry that reaches for a library instead of a manual fetch.
 * RelayState carries the org slug through the redirect, the same role
 * OIDC/OAuth's `state` query param plays.
 */
export const samlProvider: AuthProvider = {
  name: 'saml',
  register(app: FastifyInstance, ctx: AppContext): void {
    const orgService = new OrgService(ctx.db);
    const userService = new UserService(ctx.db);
    const ssoConfigService = new SsoConfigService(ctx.db, ctx.env);

    async function buildSaml(entityId: string, ssoUrl: string, idpCert: string): Promise<SAML> {
      if (!ctx.env.SSO_CALLBACK_URL) throw new ValidationError('SAML is not configured (missing SSO_CALLBACK_URL)');
      return createSamlClient(entityId, ssoUrl, idpCert, ctx.env.SSO_CALLBACK_URL);
    }

    app.get<{ Querystring: { organizationSlug?: string } }>('/v1/auth/saml/start', async (request, reply) => {
      const organizationSlug = request.query.organizationSlug;
      if (!organizationSlug) throw new ValidationError('organizationSlug query parameter is required');

      const orgAndWorkspace = await orgService.findOrgAndWorkspaceBySlug(organizationSlug);
      if (!orgAndWorkspace) throw new ValidationError('Invalid organization');

      const config = await ssoConfigService.resolve(orgAndWorkspace.organization.id);
      if (!config || config.protocol !== 'saml') throw new ValidationError('SAML is not configured for this organization');

      const saml = await buildSaml(config.config.entityId!, config.config.ssoUrl!, config.config.certificate!);

      const relayState = randomBytes(16).toString('hex');
      await ctx.redis.set(`saml_state:${relayState}`, JSON.stringify({ organizationSlug }), 'EX', STATE_TTL_SECONDS);

      const url = await saml.getAuthorizeUrlAsync(relayState, '', {});
      return reply.redirect(url);
    });

    app.post<{ Body: { SAMLResponse?: string; RelayState?: string } }>('/v1/auth/saml/acs', async (request) => {
      const { SAMLResponse, RelayState } = request.body ?? {};
      if (!SAMLResponse || !RelayState) throw new ValidationError('Missing SAMLResponse or RelayState');

      const stateRaw = await ctx.redis.get(`saml_state:${RelayState}`);
      if (!stateRaw) throw new ValidationError('This login attempt has expired — please try again');
      await ctx.redis.del(`saml_state:${RelayState}`);
      const { organizationSlug } = JSON.parse(stateRaw) as { organizationSlug: string };

      const orgAndWorkspace = await orgService.findOrgAndWorkspaceBySlug(organizationSlug);
      if (!orgAndWorkspace) throw new ValidationError('Organization no longer exists');

      const config = await ssoConfigService.resolve(orgAndWorkspace.organization.id);
      if (!config || config.protocol !== 'saml') throw new ValidationError('SAML is not configured for this organization');

      const saml = await buildSaml(config.config.entityId!, config.config.ssoUrl!, config.config.certificate!);

      let identity: SamlIdentity;
      try {
        identity = await extractIdentityFromAssertion(saml, SAMLResponse);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await logLoginAudit(ctx, request, {
          organizationId: orgAndWorkspace.organization.id,
          userId: null,
          authMethod: 'saml',
          status: 'failed',
          reason: `invalid_assertion: ${message}`,
        });
        throw err;
      }
      const { email, nameId } = identity;

      const authRecord = await userService.findAuthRecordByEmail(orgAndWorkspace.organization.id, email);
      if (!authRecord || !authRecord.isActive) {
        await logLoginAudit(ctx, request, {
          organizationId: orgAndWorkspace.organization.id,
          userId: authRecord?.id ?? null,
          authMethod: 'saml',
          status: 'failed',
          reason: 'no_matching_account',
        });
        // Deliberately does NOT auto-provision — same trust model as oauth.ts/oidc.ts.
        throw new ValidationError(`No account found for ${email} in this organization`);
      }

      await userService.linkOauthIdentity(authRecord.id, 'saml', nameId || email);
      const session = issueSession(ctx, orgAndWorkspace.organization, orgAndWorkspace.workspace, {
        id: authRecord.id,
        role: authRecord.role,
      });
      await logLoginAudit(ctx, request, {
        organizationId: orgAndWorkspace.organization.id,
        userId: authRecord.id,
        authMethod: 'saml',
        status: 'success',
      });
      return session;
    });
  },
};
