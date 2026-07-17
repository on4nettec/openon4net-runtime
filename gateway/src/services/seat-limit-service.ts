import { NotFoundError, ValidationError } from '@o2n/governance';
import type { Queryable } from '../db.js';

/**
 * RT-081 — Control Plane's CP-026 seat model, enforced Runtime-side.
 * organizations.activation_type/max_users are written only by
 * activation-scheduler.ts on check-in (see org-service.ts's
 * updateActivationInfo). A standalone function rather than an OrgService
 * method: UserService.create() and InvitationService.accept() both need it
 * inside their own transaction, and org-service.ts already imports
 * user-service.ts, so an OrgService method would create a circular import.
 *
 * Must run inside the same transaction as the users-row insert it's
 * guarding, so two concurrent invites/creates can't both read the same
 * under-the-cap count and both succeed past the limit.
 */
export async function assertSeatAvailable(client: Queryable, organizationId: string): Promise<void> {
  const { rows } = await client.query<{ activation_type: string; max_users: number | null }>(
    `SELECT activation_type, max_users FROM organizations WHERE id = $1`,
    [organizationId],
  );
  const org = rows[0];
  if (!org) throw new NotFoundError('Organization', organizationId);

  const limit = org.activation_type === 'personal' ? 1 : org.max_users;
  if (limit === null) return; // unlimited (organizational, no seat cap set)

  const { rows: countRows } = await client.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM users WHERE organization_id = $1 AND is_active = true`,
    [organizationId],
  );
  const currentCount = Number(countRows[0]?.count ?? 0);
  if (currentCount >= limit) {
    throw new ValidationError(
      org.activation_type === 'personal'
        ? 'This is a personal activation — it allows exactly one user. Issue an organizational activation key to add more users.'
        : `This organization has reached its user limit of ${limit}.`,
    );
  }
}
