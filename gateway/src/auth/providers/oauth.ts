import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../../context.js';
import { OrgService } from '../../services/org-service.js';
import { UserService } from '../../services/user-service.js';
import type { AuthProvider } from '../types.js';
import { issueSession, logLoginAudit } from '../session.js';

type OauthProviderName = 'google' | 'github';

interface ProviderMeta {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
  clientId(env: AppContext['env']): string | undefined;
  clientSecret(env: AppContext['env']): string | undefined;
}

const PROVIDER_META: Record<OauthProviderName, ProviderMeta> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userinfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
    scope: 'openid email',
    clientId: (env) => env.OAUTH_GOOGLE_CLIENT_ID,
    clientSecret: (env) => env.OAUTH_GOOGLE_CLIENT_SECRET,
  },
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userinfoUrl: 'https://api.github.com/user',
    scope: 'read:user user:email',
    clientId: (env) => env.OAUTH_GITHUB_CLIENT_ID,
    clientSecret: (env) => env.OAUTH_GITHUB_CLIENT_SECRET,
  },
};

const STATE_TTL_SECONDS = 600;

function isOauthProviderName(value: string): value is OauthProviderName {
  return value === 'google' || value === 'github';
}

/**
 * OAUTH_CALLBACK_URL is a base URL (no path) — each provider gets its own
 * callback route (`/v1/auth/oauth/:provider/callback`), so the redirect_uri
 * sent to Google can't double as GitHub's. Register the *full* resulting
 * URL (base + this path) as the authorized redirect URI in each provider's
 * OAuth app console.
 */
function buildRedirectUri(baseUrl: string, provider: OauthProviderName): string {
  return `${baseUrl.replace(/\/$/, '')}/v1/auth/oauth/${provider}/callback`;
}

interface OauthIdentity {
  subject: string;
  email: string;
}

/**
 * A DNS/network failure reaching Google/GitHub (firewall, outage, no
 * internet in this deployment) is an expected failure mode for an external
 * dependency, not a bug — wrap it the same way the rest of the codebase
 * wraps external-call failures (e.g. connectors/webhook-connector.ts),
 * instead of letting it bubble up as an opaque 500.
 */
async function safeFetch(url: string, init: RequestInit, label: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`${label} request failed: ${message}`);
  }
}

async function fetchGoogleIdentity(accessToken: string): Promise<OauthIdentity> {
  const res = await safeFetch(
    PROVIDER_META.google.userinfoUrl,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    'Google userinfo',
  );
  if (!res.ok) throw new ValidationError(`Google userinfo request failed: HTTP ${res.status}`);
  const body = (await res.json()) as { sub: string; email?: string };
  if (!body.email) throw new ValidationError('Google account has no email to sign in with');
  return { subject: body.sub, email: body.email };
}

async function fetchGithubIdentity(accessToken: string): Promise<OauthIdentity> {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' };
  const userRes = await safeFetch(PROVIDER_META.github.userinfoUrl, { headers }, 'GitHub userinfo');
  if (!userRes.ok) throw new ValidationError(`GitHub userinfo request failed: HTTP ${userRes.status}`);
  const user = (await userRes.json()) as { id: number; email: string | null };

  let email = user.email;
  if (!email) {
    // GitHub omits email from /user when the account has it set private —
    // /user/emails (needs the user:email scope) is the fallback.
    const emailsRes = await safeFetch('https://api.github.com/user/emails', { headers }, 'GitHub emails');
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
      email = emails.find((e) => e.primary && e.verified)?.email ?? null;
    }
  }
  if (!email) throw new ValidationError('GitHub account has no verified email to sign in with');
  return { subject: String(user.id), email };
}

export const oauthProvider: AuthProvider = {
  name: 'oauth',
  register(app: FastifyInstance, ctx: AppContext): void {
    const orgService = new OrgService(ctx.db);
    const userService = new UserService(ctx.db);

    app.get<{ Params: { provider: string }; Querystring: { organizationSlug?: string } }>(
      '/v1/auth/oauth/:provider/start',
      async (request, reply) => {
        const providerName = request.params.provider;
        if (!isOauthProviderName(providerName) || !ctx.env.oauthProviders.includes(providerName)) {
          throw new ValidationError(`Unknown or disabled oauth provider: ${providerName}`);
        }
        const organizationSlug = request.query.organizationSlug;
        if (!organizationSlug) throw new ValidationError('organizationSlug query parameter is required');
        if (!(await orgService.findOrgAndWorkspaceBySlug(organizationSlug))) {
          throw new ValidationError('Invalid email or password'); // same generic message as password provider — don't leak org existence
        }

        const meta = PROVIDER_META[providerName];
        const clientId = meta.clientId(ctx.env);
        if (!clientId) throw new ValidationError(`${providerName} oauth is not configured`);

        const state = randomBytes(16).toString('hex');
        await ctx.redis.set(
          `oauth_state:${state}`,
          JSON.stringify({ provider: providerName, organizationSlug }),
          'EX',
          STATE_TTL_SECONDS,
        );

        if (!ctx.env.OAUTH_CALLBACK_URL) throw new ValidationError('oauth is not configured (missing OAUTH_CALLBACK_URL)');
        const url = new URL(meta.authorizeUrl);
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('redirect_uri', buildRedirectUri(ctx.env.OAUTH_CALLBACK_URL, providerName));
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('scope', meta.scope);
        url.searchParams.set('state', state);
        return reply.redirect(url.toString());
      },
    );

    app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string } }>(
      '/v1/auth/oauth/:provider/callback',
      async (request) => {
        const providerName = request.params.provider;
        if (!isOauthProviderName(providerName)) throw new ValidationError(`Unknown oauth provider: ${providerName}`);
        const { code, state } = request.query;
        if (!code || !state) throw new ValidationError('Missing code or state');

        const stateRaw = await ctx.redis.get(`oauth_state:${state}`);
        if (!stateRaw) throw new ValidationError('This login attempt has expired — please try again');
        await ctx.redis.del(`oauth_state:${state}`);
        const stateData = JSON.parse(stateRaw) as { provider: string; organizationSlug: string };
        if (stateData.provider !== providerName) throw new ValidationError('Provider mismatch');

        const meta = PROVIDER_META[providerName];
        const clientId = meta.clientId(ctx.env);
        const clientSecret = meta.clientSecret(ctx.env);
        if (!clientId || !clientSecret) throw new ValidationError(`${providerName} oauth is not configured`);

        if (!ctx.env.OAUTH_CALLBACK_URL) throw new ValidationError('oauth is not configured (missing OAUTH_CALLBACK_URL)');
        const tokenRes = await safeFetch(
          meta.tokenUrl,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
              client_id: clientId,
              client_secret: clientSecret,
              code,
              redirect_uri: buildRedirectUri(ctx.env.OAUTH_CALLBACK_URL, providerName),
              grant_type: 'authorization_code',
            }),
          },
          `${providerName} token exchange`,
        );
        if (!tokenRes.ok) throw new ValidationError(`${providerName} token exchange failed: HTTP ${tokenRes.status}`);
        const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string };
        if (!tokenBody.access_token) {
          throw new ValidationError(`${providerName} token exchange failed: ${tokenBody.error ?? 'no access_token in response'}`);
        }

        const identity =
          providerName === 'google'
            ? await fetchGoogleIdentity(tokenBody.access_token)
            : await fetchGithubIdentity(tokenBody.access_token);

        const orgAndWorkspace = await orgService.findOrgAndWorkspaceBySlug(stateData.organizationSlug);
        if (!orgAndWorkspace) throw new ValidationError('Organization no longer exists');

        const authRecord = await userService.findAuthRecordByEmail(orgAndWorkspace.organization.id, identity.email);
        if (!authRecord || !authRecord.isActive) {
          await logLoginAudit(ctx, request, {
            organizationId: orgAndWorkspace.organization.id,
            userId: authRecord?.id ?? null,
            authMethod: 'oauth',
            status: 'failed',
            reason: 'no_matching_account',
          });
          // Deliberately does NOT auto-create a user (unlike dev_api_key's
          // bootstrap) — oauth only signs in an account an admin already
          // created via POST /v1/users, same trust model as password/magic_link.
          throw new ValidationError(`No account found for ${identity.email} in this organization`);
        }

        await userService.linkOauthIdentity(authRecord.id, providerName, identity.subject);
        const session = issueSession(ctx, orgAndWorkspace.organization, orgAndWorkspace.workspace, {
          id: authRecord.id,
          role: authRecord.role,
        });
        await logLoginAudit(ctx, request, {
          organizationId: orgAndWorkspace.organization.id,
          userId: authRecord.id,
          authMethod: 'oauth',
          status: 'success',
        });
        return session;
      },
    );
  },
};
