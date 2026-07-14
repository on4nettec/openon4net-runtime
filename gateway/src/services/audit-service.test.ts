import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { AuditService } from './audit-service.js';

interface RawRow {
  id: string;
  row_hash: string | null;
  action_data: Record<string, unknown>;
}

describe('AuditService', () => {
  let db: Db;
  const createdOrgIds: string[] = [];

  beforeAll(() => {
    db = createTestDb();
  });

  afterEach(async () => {
    for (const id of createdOrgIds.splice(0)) {
      await cleanupTestFixture(db, id);
    }
  });

  afterAll(async () => {
    await db.end();
  });

  async function withFixture(): Promise<TestFixture> {
    const fixture = await createTestFixture(db);
    createdOrgIds.push(fixture.organizationId);
    return fixture;
  }

  async function rawRows(organizationId: string): Promise<RawRow[]> {
    const { rows } = await db.query<RawRow>(
      `SELECT id, row_hash, action_data FROM audit_logs WHERE organization_id = $1 ORDER BY created_at ASC, id ASC`,
      [organizationId],
    );
    return rows;
  }

  it('listAll returns everything for the org, oldest first', async () => {
    const fixture = await withFixture();
    const auditService = new AuditService(db);

    await auditService.logAction({ organizationId: fixture.organizationId, actionType: 'action-a', actionData: {} });
    await auditService.logAction({ organizationId: fixture.organizationId, actionType: 'action-b', actionData: {} });

    const logs = await auditService.listAll(fixture.organizationId);
    expect(logs).toHaveLength(2);
    expect(logs.map((l) => l.actionType)).toEqual(['action-a', 'action-b']);
  });

  describe('tamper-evidence hash chain (RT-055)', () => {
    it('a fresh sequence of writes produces a chain that verifies as valid', async () => {
      const fixture = await withFixture();
      const auditService = new AuditService(db);

      await auditService.logAction({ organizationId: fixture.organizationId, actionType: 'action-a', actionData: { n: 1 } });
      await auditService.logAction({ organizationId: fixture.organizationId, actionType: 'action-b', actionData: { n: 2 } });
      await auditService.logAction({ organizationId: fixture.organizationId, actionType: 'action-c', actionData: { n: 3 } });

      const result = await auditService.verifyChain(fixture.organizationId);
      expect(result).toEqual({ valid: true, checkedCount: 3 });
    });

    it('every row gets a non-null row_hash and prev_hash links to the previous row', async () => {
      const fixture = await withFixture();
      const auditService = new AuditService(db);

      await auditService.logAction({ organizationId: fixture.organizationId, actionType: 'action-a', actionData: {} });
      await auditService.logAction({ organizationId: fixture.organizationId, actionType: 'action-b', actionData: {} });

      const rows = await rawRows(fixture.organizationId);
      expect(rows.every((r) => r.row_hash !== null)).toBe(true);
      const { rows: linked } = await db.query<{ prev_hash: string | null }>(
        `SELECT prev_hash FROM audit_logs WHERE organization_id = $1 ORDER BY created_at ASC, id ASC`,
        [fixture.organizationId],
      );
      expect(linked[1]?.prev_hash).toBe(rows[0]?.row_hash);
    });

    it('detects tampering — mutating a row\'s action_data in place breaks verification from that row on', async () => {
      const fixture = await withFixture();
      const auditService = new AuditService(db);

      await auditService.logAction({ organizationId: fixture.organizationId, actionType: 'action-a', actionData: { amount: 100 } });
      await auditService.logAction({ organizationId: fixture.organizationId, actionType: 'action-b', actionData: { amount: 200 } });

      const rows = await rawRows(fixture.organizationId);
      const firstId = rows[0]!.id;
      await db.query(`UPDATE audit_logs SET action_data = $1 WHERE id = $2`, [JSON.stringify({ amount: 999_999 }), firstId]);

      const result = await auditService.verifyChain(fixture.organizationId);
      expect(result.valid).toBe(false);
      expect(result.brokenAtId).toBe(firstId);
    });

    it('legacy rows with no row_hash (pre-migration) are skipped, not treated as broken', async () => {
      const fixture = await withFixture();
      const auditService = new AuditService(db);

      // Simulate a pre-RT-055 row: inserted with no hash columns at all.
      await db.query(
        `INSERT INTO audit_logs (organization_id, action_type, action_data) VALUES ($1, 'legacy-action', '{}')`,
        [fixture.organizationId],
      );
      await auditService.logAction({ organizationId: fixture.organizationId, actionType: 'action-a', actionData: {} });

      const result = await auditService.verifyChain(fixture.organizationId);
      expect(result).toEqual({ valid: true, checkedCount: 1 });
    });
  });

  describe('retention purge + chain checkpoint (RT-054/055)', () => {
    it('purgeExpired removes only rows older than retentionDays', async () => {
      const fixture = await withFixture();
      const auditService = new AuditService(db);

      await auditService.logAction({ organizationId: fixture.organizationId, actionType: 'old-action', actionData: {} });
      await auditService.logAction({ organizationId: fixture.organizationId, actionType: 'recent-action', actionData: {} });

      const rows = await rawRows(fixture.organizationId);
      await db.query(`UPDATE audit_logs SET created_at = NOW() - INTERVAL '40 days' WHERE id = $1`, [rows[0]!.id]);

      const removed = await auditService.purgeExpired(fixture.organizationId, 30);
      expect(removed).toBe(1);

      const remaining = await auditService.listAll(fixture.organizationId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.actionType).toBe('recent-action');
    });

    it('checkpoints the deleted rows\' newest hash into organizations.settings.auditChainGenesis, keeping verifyChain valid afterward', async () => {
      const fixture = await withFixture();
      const auditService = new AuditService(db);

      await auditService.logAction({ organizationId: fixture.organizationId, actionType: 'old-1', actionData: {} });
      await auditService.logAction({ organizationId: fixture.organizationId, actionType: 'old-2', actionData: {} });
      await auditService.logAction({ organizationId: fixture.organizationId, actionType: 'recent', actionData: {} });

      const rows = await rawRows(fixture.organizationId);
      const [old1, old2] = rows;
      await db.query(`UPDATE audit_logs SET created_at = NOW() - INTERVAL '40 days' WHERE id = ANY($1)`, [
        [old1!.id, old2!.id],
      ]);

      await auditService.purgeExpired(fixture.organizationId, 30);

      const { rows: orgRows } = await db.query<{ settings: Record<string, unknown> }>(
        `SELECT settings FROM organizations WHERE id = $1`,
        [fixture.organizationId],
      );
      const genesis = orgRows[0]?.settings.auditChainGenesis as string | undefined;
      expect(genesis).toBe(old2!.row_hash);

      // Without the checkpoint, verifyChain would report broken at the
      // surviving row (its prev_hash points at the deleted old-2 row, not
      // the zero-hash genesis) — passing the checkpoint keeps it valid.
      const withoutCheckpoint = await auditService.verifyChain(fixture.organizationId);
      expect(withoutCheckpoint.valid).toBe(false);

      const withCheckpoint = await auditService.verifyChain(fixture.organizationId, genesis);
      expect(withCheckpoint).toEqual({ valid: true, checkedCount: 1 });
    });

    it('does not touch organizations.settings when nothing is old enough to purge', async () => {
      const fixture = await withFixture();
      const auditService = new AuditService(db);
      await auditService.logAction({ organizationId: fixture.organizationId, actionType: 'recent', actionData: {} });

      const removed = await auditService.purgeExpired(fixture.organizationId, 30);
      expect(removed).toBe(0);

      const { rows: orgRows } = await db.query<{ settings: Record<string, unknown> }>(
        `SELECT settings FROM organizations WHERE id = $1`,
        [fixture.organizationId],
      );
      expect(orgRows[0]?.settings.auditChainGenesis).toBeUndefined();
    });
  });
});
