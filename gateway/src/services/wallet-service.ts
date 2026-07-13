import { ValidationError, WalletInsufficientBalanceError } from '@o2n/governance';
import type { Queryable } from '../db.js';
import { AuditService } from './audit-service.js';

interface WalletRow {
  id: string;
  organization_id: string;
  workspace_id: string | null;
  owner_type: 'organization' | 'workspace';
  balance_credits: string;
  status: 'active' | 'suspended';
  created_at: string;
  updated_at: string;
}

export interface Wallet {
  id: string;
  organizationId: string;
  workspaceId: string | null;
  ownerType: 'organization' | 'workspace';
  balanceCredits: number;
  status: 'active' | 'suspended';
  createdAt: string;
  updatedAt: string;
}

function toWallet(row: WalletRow): Wallet {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerType: row.owner_type,
    balanceCredits: Number(row.balance_credits),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Thin API over the schema-only `wallets` table (migrations/0005_billing_wallet.sql,
 * "No API is built on it in Sprint 0"). Simple balance mutation, no separate
 * credit_transactions ledger in Runtime — each mutation is logged via
 * AuditService instead (matches how per-agent budget spend is already
 * logged in chat-service.ts's persistTurn). A full ledger is Control-Plane's
 * job (already built there for its own wallet).
 *
 * Unit note: no credits<->cents exchange rate is defined anywhere in this
 * codebase (ADR-008 only settles on "internal ledger", not a rate) — this
 * service treats `balance_credits` as numerically equal to `costCents`
 * (1 credit = 1 cent) since that's the only assumption with nothing to
 * contradict it. Revisit if a real conversion is ever introduced.
 */
export class WalletService {
  constructor(private db: Queryable) {}

  /** Looks up without creating — used by ChatService's budget gate so an org with no wallet row is treated as "no cap", not auto-provisioned mid-request. */
  async find(organizationId: string, workspaceId?: string): Promise<Wallet | null> {
    const { rows } = await this.db.query<WalletRow>(
      workspaceId
        ? `SELECT * FROM wallets WHERE organization_id = $1 AND workspace_id = $2`
        : `SELECT * FROM wallets WHERE organization_id = $1 AND workspace_id IS NULL`,
      workspaceId ? [organizationId, workspaceId] : [organizationId],
    );
    const row = rows[0];
    return row ? toWallet(row) : null;
  }

  async getOrCreate(organizationId: string, workspaceId?: string): Promise<Wallet> {
    const existing = await this.find(organizationId, workspaceId);
    if (existing) return existing;

    const ownerType = workspaceId ? 'workspace' : 'organization';
    const ownerId = workspaceId ?? organizationId;
    const { rows } = await this.db.query<WalletRow>(
      `INSERT INTO wallets (organization_id, workspace_id, owner_type, owner_id, balance_credits)
       VALUES ($1, $2, $3, $4, 0)
       RETURNING *`,
      [organizationId, workspaceId ?? null, ownerType, ownerId],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    return toWallet(row);
  }

  async credit(organizationId: string, amountCredits: number, reason: string, actorUserId: string | null, workspaceId?: string): Promise<Wallet> {
    if (amountCredits <= 0) throw new ValidationError('amountCredits must be positive');
    const wallet = await this.getOrCreate(organizationId, workspaceId);
    const { rows } = await this.db.query<WalletRow>(
      `UPDATE wallets SET balance_credits = balance_credits + $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [amountCredits, wallet.id],
    );
    const row = rows[0];
    if (!row) throw new Error('Update did not return a row');
    await new AuditService(this.db).logAction({
      organizationId,
      userId: actorUserId,
      actionType: 'wallet-credit',
      actionData: { walletId: wallet.id, amountCredits, reason },
    });
    return toWallet(row);
  }

  /** Throws ValidationError (not a hard exception) if the debit would take the balance negative — caller (ChatService) turns that into a budget-exceeded outcome. */
  async debit(organizationId: string, amountCredits: number, reason: string, workspaceId?: string): Promise<Wallet> {
    if (amountCredits <= 0) throw new ValidationError('amountCredits must be positive');
    const wallet = await this.getOrCreate(organizationId, workspaceId);
    if (wallet.balanceCredits < amountCredits) {
      throw new WalletInsufficientBalanceError(organizationId, wallet.balanceCredits);
    }
    const { rows } = await this.db.query<WalletRow>(
      `UPDATE wallets SET balance_credits = balance_credits - $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [amountCredits, wallet.id],
    );
    const row = rows[0];
    if (!row) throw new Error('Update did not return a row');
    await new AuditService(this.db).logAction({
      organizationId,
      actionType: 'wallet-debit',
      actionData: { walletId: wallet.id, amountCredits, reason },
    });
    return toWallet(row);
  }
}
