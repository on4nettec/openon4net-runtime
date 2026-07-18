import { ValidationError } from '@o2n/governance';

export interface ParsedSkillMarkdown {
  name: string;
  description: string;
  instructions: string;
}

/**
 * RT-087 — a minimal parser for SKILL.md's frontmatter (agentskills.io):
 * `---\nname: ...\ndescription: ...\n---\n<markdown body>`. Only `name`/
 * `description` are read (the two required fields for v1's
 * instructions-only scope) — a hand-written flat key:value reader rather
 * than a real YAML parser, since the standard's frontmatter is just simple
 * scalar strings for this subset, not nested structures.
 */
export function parseSkillMarkdown(raw: string): ParsedSkillMarkdown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw.trim());
  if (!match) {
    throw new ValidationError('SKILL.md must start with a "---" frontmatter block containing name and description');
  }
  const [, frontmatter, body] = match;

  const fields: Record<string, string> = {};
  for (const line of (frontmatter ?? '').split(/\r?\n/)) {
    const fieldMatch = /^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line);
    if (!fieldMatch) continue;
    const [, key, value] = fieldMatch;
    if (key) fields[key] = (value ?? '').trim().replace(/^["']|["']$/g, '');
  }

  const name = fields.name;
  const description = fields.description;
  if (!name) throw new ValidationError('SKILL.md frontmatter is missing required field "name"');
  if (!description) throw new ValidationError('SKILL.md frontmatter is missing required field "description"');

  const instructions = (body ?? '').trim();
  if (!instructions) throw new ValidationError('SKILL.md has no instructions (empty body after frontmatter)');

  return { name, description, instructions };
}
