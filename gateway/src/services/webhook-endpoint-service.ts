import { createHash, randomBytes } from 'node:crypto';
import { NotFoundError } from '@o2n/governance';
import type { Queryable } from '../db.js';

export type WebhookTargetType = 'workflow' | 'agent';

export interface WebhookEndpoint {
  readonly id: string;
  organizationId: string;
  name: string;
  targetType: WebhookTargetType;
  targetId: string;
  isActive: boolean;
  readonly createdAt: string;
  lastTriggeredAt: string | null;
}

interface WebhookEndpointRow {
  id: string;
  organization_id: string;
  name: string;
  target_type: WebhookTargetType;
  target_id: string;
  is_active: boolean;
  created_at: string;
  last_triggered_at: string | null;
}

function toWebhookEndpoint(row: WebhookEndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    targetType: row.target_type,
    targetId: row.target_id,
    isActive: row.is_active,
    createdAt: row.created_at,
    lastTriggeredAt: row.last_triggered_at,
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Inbound webhooks (RT-065): the token is the credential (same trust model
 * as invitation/magic-link tokens, see migrations/0022) — only its hash is
 * ever stored, the raw value is returned once at create() and never again.
 */
export class WebhookEndpointService {
  constructor(private db: Queryable) {}

  async create(
    organizationId: string,
    input: { name: string; targetType: WebhookTargetType; targetId: string },
    createdByUserId: string | null,
  ): Promise<{ endpoint: WebhookEndpoint; token: string }> {
    const token = randomBytes(32).toString('hex');
    const { rows } = await this.db.query<WebhookEndpointRow>(
      `INSERT INTO webhook_endpoints (organization_id, name, token_hash, target_type, target_id, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [organizationId, input.name, hashToken(token), input.targetType, input.targetId, createdByUserId],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    return { endpoint: toWebhookEndpoint(row), token };
  }

  async list(organizationId: string): Promise<WebhookEndpoint[]> {
    const { rows } = await this.db.query<WebhookEndpointRow>(
      `SELECT * FROM webhook_endpoints WHERE organization_id = $1 ORDER BY created_at DESC`,
      [organizationId],
    );
    return rows.map(toWebhookEndpoint);
  }

  async delete(organizationId: string, id: string): Promise<void> {
    const { rowCount } = await this.db.query(
      `DELETE FROM webhook_endpoints WHERE id = $1 AND organization_id = $2`,
      [id, organizationId],
    );
    if (!rowCount) throw new NotFoundError('WebhookEndpoint', id);
  }

  /** Looks up an endpoint by the raw inbound token — public, unauthenticated route's only gate. */
  async findByToken(token: string): Promise<WebhookEndpoint | null> {
    const { rows } = await this.db.query<WebhookEndpointRow>(
      `SELECT * FROM webhook_endpoints WHERE token_hash = $1 AND is_active = true`,
      [hashToken(token)],
    );
    const row = rows[0];
    return row ? toWebhookEndpoint(row) : null;
  }

  async markTriggered(id: string): Promise<void> {
    await this.db.query(`UPDATE webhook_endpoints SET last_triggered_at = NOW() WHERE id = $1`, [id]);
  }
}
