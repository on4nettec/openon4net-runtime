import type { SkillCreateInput, SkillUpdateInput, SkillDefinition } from '@o2n/shared';
import { NotFoundError } from '@o2n/governance';
import type { Queryable } from '../db.js';
import { validateSkillDefinition } from './skill-validator.js';

export type SkillSource = 'auto' | 'manual' | 'marketplace';
export type SkillStatus = 'active' | 'inactive' | 'deprecated';

export interface Skill {
  readonly id: string;
  agentId: string | null;
  organizationId: string;
  name: string;
  description: string | null;
  version: string;
  definition: SkillDefinition;
  source: SkillSource;
  status: SkillStatus;
  executionCount: number;
  successRate: number;
  avgDurationMs: number | null;
  readonly createdAt: string;
  updatedAt: string;
}

interface SkillRow {
  id: string;
  agent_id: string | null;
  organization_id: string;
  name: string;
  description: string | null;
  version: string;
  definition: SkillDefinition;
  source: SkillSource;
  status: SkillStatus;
  execution_count: string;
  success_rate: string;
  avg_duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

/** Patch-bump: "1.0.0" -> "1.0.1". Falls back to "1.0.0" for any pre-existing unparseable version string. */
function bumpVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return '1.0.0';
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

function toSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    agentId: row.agent_id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description,
    version: row.version,
    definition: row.definition,
    source: row.source,
    status: row.status,
    executionCount: Number(row.execution_count),
    successRate: Number(row.success_rate),
    avgDurationMs: row.avg_duration_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Org-level artifact (docs/spect/02_ARCHITECTURE/03-skill-engine.md §2.1) — shareable/versionable, distinct from which agents may use it (see SkillGrantService). */
export class SkillService {
  constructor(private db: Queryable) {}

  async create(organizationId: string, input: SkillCreateInput, source: SkillSource = 'manual'): Promise<Skill> {
    await validateSkillDefinition(input.definition);
    const { rows } = await this.db.query<SkillRow>(
      `INSERT INTO skills (agent_id, organization_id, name, description, definition, source)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.agentId ?? null, organizationId, input.name, input.description ?? null, JSON.stringify(input.definition), source],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    return toSkill(row);
  }

  async list(organizationId: string): Promise<Skill[]> {
    const { rows } = await this.db.query<SkillRow>(
      `SELECT * FROM skills WHERE organization_id = $1 ORDER BY created_at DESC`,
      [organizationId],
    );
    return rows.map(toSkill);
  }

  async getById(organizationId: string, skillId: string): Promise<Skill> {
    const { rows } = await this.db.query<SkillRow>(
      `SELECT * FROM skills WHERE id = $1 AND organization_id = $2`,
      [skillId, organizationId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Skill', skillId);
    return toSkill(row);
  }

  async update(organizationId: string, skillId: string, input: SkillUpdateInput): Promise<Skill> {
    const existing = await this.getById(organizationId, skillId); // 404s if missing/wrong org

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
    if (input.definition !== undefined) {
      await validateSkillDefinition(input.definition);
      set('definition', JSON.stringify(input.definition));
      // A changed definition is a new revision of this skill's behavior —
      // bump automatically rather than trusting a client-supplied version
      // (SkillUpdateSchema has no version field at all, see packages/shared).
      set('version', bumpVersion(existing.version));
    }
    if (input.status !== undefined) set('status', input.status);
    set('updated_at', new Date().toISOString());

    values.push(skillId, organizationId);
    const { rows } = await this.db.query<SkillRow>(
      `UPDATE skills SET ${fields.join(', ')} WHERE id = $${i} AND organization_id = $${i + 1} RETURNING *`,
      values,
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Skill', skillId);
    return toSkill(row);
  }

  async delete(organizationId: string, skillId: string): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(
      `DELETE FROM skills WHERE id = $1 AND organization_id = $2 RETURNING id`,
      [skillId, organizationId],
    );
    if (!rows[0]) throw new NotFoundError('Skill', skillId);
  }

  /**
   * Roadmap "version bump / fork" (03-skill-engine.md §2.1) — a fork is a
   * brand-new skill row (fresh id, version reset to 1.0.0, its own execution
   * stats starting at zero) that starts as a copy of an existing skill's
   * definition, not a link back to it. `name` defaults to "<source> (fork)".
   */
  async fork(organizationId: string, skillId: string, name?: string): Promise<Skill> {
    const source = await this.getById(organizationId, skillId);
    return this.create(
      organizationId,
      {
        agentId: source.agentId ?? undefined,
        name: name ?? `${source.name} (fork)`,
        description: source.description ?? undefined,
        definition: source.definition,
      },
      'manual',
    );
  }

  /** Called after each execution (skill-executor.ts) to keep execution_count/success_rate/avg_duration_ms current. */
  async recordExecution(skillId: string, succeeded: boolean, durationMs: number): Promise<void> {
    await this.db.query(
      `UPDATE skills SET
         execution_count = execution_count + 1,
         success_rate = (
           (success_rate * execution_count + $1::int * 100) / (execution_count + 1)
         ),
         avg_duration_ms = COALESCE(
           ((avg_duration_ms * execution_count) + $2) / (execution_count + 1),
           $2
         ),
         updated_at = NOW()
       WHERE id = $3`,
      [succeeded ? 1 : 0, durationMs, skillId],
    );
  }
}
