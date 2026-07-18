import { describe, it, expect } from 'vitest';
import { parseSkillMarkdown } from './skill-package-markdown.js';

describe('parseSkillMarkdown (RT-087)', () => {
  it('parses a well-formed SKILL.md into name/description/instructions', () => {
    const raw = `---
name: PDF Extraction
description: Extracts structured data from PDF invoices.
---

# Instructions

1. Read the PDF.
2. Extract the total and due date.
`;
    const result = parseSkillMarkdown(raw);
    expect(result.name).toBe('PDF Extraction');
    expect(result.description).toBe('Extracts structured data from PDF invoices.');
    expect(result.instructions).toContain('1. Read the PDF.');
  });

  it('strips surrounding quotes from frontmatter values', () => {
    const raw = `---
name: "Quoted Name"
description: 'Single quoted description'
---
Body text.`;
    const result = parseSkillMarkdown(raw);
    expect(result.name).toBe('Quoted Name');
    expect(result.description).toBe('Single quoted description');
  });

  it('throws when there is no frontmatter block at all', () => {
    expect(() => parseSkillMarkdown('Just some plain text, no frontmatter.')).toThrow(/frontmatter/);
  });

  it('throws when frontmatter is missing the required "name" field', () => {
    const raw = `---
description: has a description but no name
---
Body.`;
    expect(() => parseSkillMarkdown(raw)).toThrow(/name/);
  });

  it('throws when frontmatter is missing the required "description" field', () => {
    const raw = `---
name: has a name but no description
---
Body.`;
    expect(() => parseSkillMarkdown(raw)).toThrow(/description/);
  });

  it('throws when the body is empty after the frontmatter block', () => {
    const raw = `---
name: Empty body
description: no instructions at all
---
`;
    expect(() => parseSkillMarkdown(raw)).toThrow(/empty body|instructions/i);
  });
});
