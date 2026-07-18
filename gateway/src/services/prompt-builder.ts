import type { ContextContract } from './context-builder.js';

/**
 * Compresses a ContextContract into the single system message sent to the
 * LLM — docs/spect/02_ARCHITECTURE/01-system-overview.md's rule: "همه چیز
 * به LLM فرستاده نمی‌شود؛ فقط context فشرده و مرتبط با task فعلی". Every
 * section is optional and omitted entirely when empty, so an agent with no
 * granted tools/no summary/no relevant memory gets the same short prompt
 * it always did — this never inflates a bare-bones agent's prompt.
 */
export function buildSystemPrompt(context: ContextContract): string {
  const lines: string[] = [];

  lines.push(`You are ${context.identity.name}, a ${context.identity.role} digital employee.`);
  lines.push(
    `You operate in the "${context.workspace.workspaceName}" workspace of ${context.workspace.organizationName}.`,
  );

  if (context.memory.summary) {
    lines.push(`Conversation summary so far: ${context.memory.summary}`);
  }
  if (context.memory.relevant.length > 0) {
    const snippets = context.memory.relevant.map((m) => `- (${m.role}) ${m.content}`).join('\n');
    lines.push(`Potentially relevant earlier context:\n${snippets}`);
  }

  if (context.tools.skills.length > 0 || context.tools.plugins.length > 0) {
    const parts: string[] = [];
    if (context.tools.skills.length > 0) parts.push(`skills: ${context.tools.skills.join(', ')}`);
    if (context.tools.plugins.length > 0) parts.push(`plugins: ${context.tools.plugins.join(', ')}`);
    lines.push(`You have access to the following (${parts.join('; ')}).`);
  }

  if (context.permissions.budgetRemainingCents <= 0) {
    lines.push('Your budget for this period is exhausted — be as concise as possible.');
  }

  if (context.language && context.language !== 'en') {
    lines.push(`Respond in the following language/locale: ${context.language}.`);
  }

  return lines.join('\n');
}
