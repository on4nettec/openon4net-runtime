import type { SkillPackageCreateInput, SkillPackageUpdateInput } from '@o2n/shared';
import { NotFoundError } from '@o2n/governance';
import type { Queryable } from '../db.js';
import { parseSkillMarkdown } from './skill-package-markdown.js';

export type SkillPackageStatus = 'active' | 'inactive';

export interface SkillPackage {
  readonly id: string;
  agentId: string | null;
  organizationId: string;
  name: string;
  description: string;
  instructions: string;
  status: SkillPackageStatus;
  readonly createdAt: string;
  updatedAt: string;
}

interface SkillPackageRow {
  id: string;
  agent_id: string | null;
  organization_id: string;
  name: string;
  description: string;
  instructions: string;
  status: SkillPackageStatus;
  created_at: string;
  updated_at: string;
}

function toSkillPackage(row: SkillPackageRow): SkillPackage {
  return {
    id: row.id,
    agentId: row.agent_id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * RT-087 — Agent Skills open standard (agentskills.io), v1 instructions-only
 * scope: an org-level artifact (mirrors skill-service.ts's Skill — shareable,
 * distinct from which agents may use it, see SkillPackageGrantService),
 * additive alongside the existing Skill/SkillDefinition model.
 */
export class SkillPackageService {
  constructor(private db: Queryable) {}

  async create(organizationId: string, input: SkillPackageCreateInput): Promise<SkillPackage> {
    const { rows } = await this.db.query<SkillPackageRow>(
      `INSERT INTO agent_skill_packages (agent_id, organization_id, name, description, instructions)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.agentId ?? null, organizationId, input.name, input.description, input.instructions],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    return toSkillPackage(row);
  }

  /** Parses a raw SKILL.md file's text (frontmatter + body) instead of taking the structured fields directly — the standard's actual interop format, e.g. for importing a community skill from agentskills.io. */
  async importFromMarkdown(organizationId: string, agentId: string | undefined, markdown: string): Promise<SkillPackage> {
    const parsed = parseSkillMarkdown(markdown);
    return this.create(organizationId, { agentId, ...parsed });
  }

  async list(organizationId: string): Promise<SkillPackage[]> {
    const { rows } = await this.db.query<SkillPackageRow>(
      `SELECT * FROM agent_skill_packages WHERE organization_id = $1 ORDER BY created_at DESC`,
      [organizationId],
    );
    return rows.map(toSkillPackage);
  }

  /** RT-087 — the packages a specific agent has been granted, joined in one query (used by chat-service.ts to build the agent's tool list each turn). */
  async listGrantedForAgent(organizationId: string, agentId: string): Promise<SkillPackage[]> {
    const { rows } = await this.db.query<SkillPackageRow>(
      `SELECT p.* FROM agent_skill_packages p
       JOIN agent_skill_package_grants g ON g.skill_package_id = p.id
       WHERE p.organization_id = $1 AND g.agent_id = $2
       ORDER BY p.created_at DESC`,
      [organizationId, agentId],
    );
    return rows.map(toSkillPackage);
  }

  async getById(organizationId: string, skillPackageId: string): Promise<SkillPackage> {
    const { rows } = await this.db.query<SkillPackageRow>(
      `SELECT * FROM agent_skill_packages WHERE id = $1 AND organization_id = $2`,
      [skillPackageId, organizationId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Skill package', skillPackageId);
    return toSkillPackage(row);
  }

  async update(organizationId: string, skillPackageId: string, input: SkillPackageUpdateInput): Promise<SkillPackage> {
    await this.getById(organizationId, skillPackageId); // 404s if missing/wrong org

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    const set = (column: string, value: unknown): void => {
      fields.push(`${column} = $${i}`);
      values.push(value);
      i += 1;
    };

    if (input.name !== undefined) set('name', input.name);
    if (input.description !== undefined) set('description', input.description);
    if (input.instructions !== undefined) set('instructions', input.instructions);
    if (input.status !== undefined) set('status', input.status);
    set('updated_at', new Date().toISOString());

    values.push(skillPackageId, organizationId);
    const { rows } = await this.db.query<SkillPackageRow>(
      `UPDATE agent_skill_packages SET ${fields.join(', ')} WHERE id = $${i} AND organization_id = $${i + 1} RETURNING *`,
      values,
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Skill package', skillPackageId);
    return toSkillPackage(row);
  }

  async delete(organizationId: string, skillPackageId: string): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(
      `DELETE FROM agent_skill_packages WHERE id = $1 AND organization_id = $2 RETURNING id`,
      [skillPackageId, organizationId],
    );
    if (!rows[0]) throw new NotFoundError('Skill package', skillPackageId);
  }
}
