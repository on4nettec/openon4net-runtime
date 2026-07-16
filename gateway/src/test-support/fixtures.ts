import { AgentCreateSchema } from '@o2n/shared';
import type { Db } from '../db.js';
import { AgentService } from '../services/agent-service.js';
import { uniqueSlug } from './db.js';

export interface TestFixture {
  organizationId: string;
  workspaceId: string;
  agentId: string;
  userId: string;
}

/** Creates a throwaway org + workspace + agent + user for a test, real Postgres rows (no mocks). */
export async function createTestFixture(db: Db): Promise<TestFixture> {
  const slug = uniqueSlug('skill-test');

  const { rows: orgRows } = await db.query<{ id: string }>(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    [slug, slug],
  );
  const organizationId = orgRows[0]!.id;

  const { rows: wsRows } = await db.query<{ id: string }>(
    `INSERT INTO workspaces (organization_id, name) VALUES ($1, $2) RETURNING id`,
    [organizationId, `${slug}-workspace`],
  );
  const workspaceId = wsRows[0]!.id;

  const { rows: userRows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, name, organization_id) VALUES ($1, $2, $3) RETURNING id`,
    [`${slug}@example.com`, `${slug}-user`, organizationId],
  );
  const userId = userRows[0]!.id;

  const agentInput = AgentCreateSchema.parse({ name: `${slug}-agent`, role: 'tester', workspaceId });
  const agent = await new AgentService(db).create(organizationId, agentInput);

  return { organizationId, workspaceId, agentId: agent.id, userId };
}

/**
 * Deletes everything created for organizationId. Not a single cascading
 * DELETE FROM organizations — `audit_logs`/`skills`/`skill_proposals`/
 * `approval_queue`/`users`'s `organization_id` FK has no ON DELETE CASCADE
 * (pre-existing schema, orgs are never hard-deleted in production), so
 * child rows are removed explicitly first, in dependency order.
 */
export async function cleanupTestFixture(db: Db, organizationId: string): Promise<void> {
  await db.query(`DELETE FROM audit_logs WHERE organization_id = $1`, [organizationId]);
  await db.query(`DELETE FROM approval_queue WHERE organization_id = $1`, [organizationId]);
  await db.query(`DELETE FROM skill_proposals WHERE organization_id = $1`, [organizationId]);
  await db.query(`DELETE FROM skills WHERE organization_id = $1`, [organizationId]);
  // workflows.created_by_user_id / webhook_endpoints.created_by_user_id /
  // agent_plugin_grants.granted_by_user_id have no ON DELETE CASCADE, so all
  // three must go before users.
  await db.query(`DELETE FROM workflows WHERE organization_id = $1`, [organizationId]); // cascades workflow_runs, workflow_run_steps
  await db.query(`DELETE FROM webhook_endpoints WHERE organization_id = $1`, [organizationId]);
  await db.query(
    `DELETE FROM agent_plugin_grants WHERE agent_id IN (SELECT id FROM agents WHERE organization_id = $1)`,
    [organizationId],
  );
  await db.query(`DELETE FROM users WHERE organization_id = $1`, [organizationId]);
  await db.query(`DELETE FROM organizations WHERE id = $1`, [organizationId]); // cascades workspaces, agents, agent_skill_grants, agent_plugin_grants, agent_messages
}
