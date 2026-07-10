import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import nodemailer from 'nodemailer';
import { MagicLinkRequestSchema, MagicLinkVerifySchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../../context.js';
import { OrgService } from '../../services/org-service.js';
import { UserService } from '../../services/user-service.js';
import type { AuthProvider } from '../types.js';
import { issueSession, logLoginAudit } from '../session.js';

const TOKEN_TTL_SECONDS = 15 * 60;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const magicLinkProvider: AuthProvider = {
  name: 'magic_link',
  register(app: FastifyInstance, ctx: AppContext): void {
    const orgService = new OrgService(ctx.db);
    const userService = new UserService(ctx.db);
    const transport = nodemailer.createTransport({
      host: ctx.env.SMTP_HOST,
      port: ctx.env.SMTP_PORT,
      secure: ctx.env.SMTP_SECURE,
      auth: ctx.env.SMTP_USER ? { user: ctx.env.SMTP_USER, pass: ctx.env.SMTP_PASS } : undefined,
    });

    app.post('/v1/auth/magic-link/request', async (request) => {
      const parsed = MagicLinkRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError('Invalid payload', parsed.error.flatten());
      const { organizationSlug, email } = parsed.data;

      const orgAndWorkspace = await orgService.findOrgAndWorkspaceBySlug(organizationSlug);
      const authRecord = orgAndWorkspace
        ? await userService.findAuthRecordByEmail(orgAndWorkspace.organization.id, email)
        : null;

      // Same email regardless of whether the account exists — the request
      // shape can't distinguish "sent" from "no such user", by design.
      if (orgAndWorkspace && authRecord?.isActive) {
        const token = randomBytes(32).toString('hex');
        await ctx.db.query(
          `INSERT INTO magic_link_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + make_interval(secs => $3))`,
          [authRecord.id, hashToken(token), TOKEN_TTL_SECONDS],
        );
        await transport.sendMail({
          from: ctx.env.EMAIL_FROM,
          to: email,
          subject: 'Your Open on4net sign-in link',
          text: `Use this token to sign in (valid for 15 minutes): ${token}`,
        });
      }

      return { ok: true, message: 'If an account exists for that email, a sign-in link has been sent.' };
    });

    app.post('/v1/auth/magic-link/verify', async (request) => {
      const parsed = MagicLinkVerifySchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError('Invalid payload', parsed.error.flatten());

      const tokenHash = hashToken(parsed.data.token);
      const { rows } = await ctx.db.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM magic_link_tokens
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`,
        [tokenHash],
      );
      const tokenRow = rows[0];
      if (!tokenRow) throw new ValidationError('This sign-in link is invalid or has expired');

      await ctx.db.query(`UPDATE magic_link_tokens SET used_at = NOW() WHERE id = $1`, [tokenRow.id]);

      const [orgAndWorkspace, user] = await Promise.all([
        orgService.getOrgAndWorkspaceForUser(tokenRow.user_id),
        userService.findById(tokenRow.user_id),
      ]);
      if (!orgAndWorkspace || !user || !user.isActive) {
        throw new ValidationError('This sign-in link is invalid or has expired');
      }

      const session = issueSession(ctx, orgAndWorkspace.organization, orgAndWorkspace.workspace, {
        id: user.id,
        role: user.role,
      });
      await logLoginAudit(ctx, request, {
        organizationId: orgAndWorkspace.organization.id,
        userId: user.id,
        authMethod: 'magic_link',
        status: 'success',
      });
      return session;
    });
  },
};
