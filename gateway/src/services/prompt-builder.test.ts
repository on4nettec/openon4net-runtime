import { describe, expect, it } from 'vitest';
import type { ContextContract } from './context-builder.js';
import { buildSystemPrompt } from './prompt-builder.js';

function baseContext(overrides: Partial<ContextContract> = {}): ContextContract {
  return {
    identity: { agentId: 'agent-1', name: 'Ava', role: 'support' },
    task: { message: 'hi', conversationId: 'conv-1' },
    workspace: { organizationName: 'Acme', workspaceName: 'Support Team' },
    memory: { summary: null, relevant: [] },
    tools: { skills: [], plugins: [] },
    permissions: { budgetRemainingCents: 5000 },
    language: 'en',
    trace: { traceId: 'trace-1' },
    ...overrides,
  };
}

describe('buildSystemPrompt (RT-031)', () => {
  it('produces the same minimal prompt as before RT-031 when every optional layer is empty', () => {
    const prompt = buildSystemPrompt(baseContext());
    expect(prompt).toBe('You are Ava, a support digital employee.\nYou operate in the "Support Team" workspace of Acme.');
  });

  it('includes the conversation summary when present', () => {
    const prompt = buildSystemPrompt(baseContext({ memory: { summary: 'User is troubleshooting login issues.', relevant: [] } }));
    expect(prompt).toContain('Conversation summary so far: User is troubleshooting login issues.');
  });

  it('includes relevant older memory snippets when present', () => {
    const prompt = buildSystemPrompt(
      baseContext({ memory: { summary: null, relevant: [{ role: 'user', content: 'my order number is 123' }] } }),
    );
    expect(prompt).toContain('Potentially relevant earlier context:');
    expect(prompt).toContain('- (user) my order number is 123');
  });

  it('lists granted skills and plugins together, omitting whichever is empty', () => {
    const skillsOnly = buildSystemPrompt(baseContext({ tools: { skills: ['Send Report'], plugins: [] } }));
    expect(skillsOnly).toContain('You have access to the following (skills: Send Report).');

    const both = buildSystemPrompt(baseContext({ tools: { skills: ['Send Report'], plugins: ['CRM Connector'] } }));
    expect(both).toContain('You have access to the following (skills: Send Report; plugins: CRM Connector).');
  });

  it('warns about an exhausted budget', () => {
    const prompt = buildSystemPrompt(baseContext({ permissions: { budgetRemainingCents: 0 } }));
    expect(prompt).toContain('Your budget for this period is exhausted — be as concise as possible.');
  });

  it('does not mention budget when there is budget remaining', () => {
    const prompt = buildSystemPrompt(baseContext({ permissions: { budgetRemainingCents: 100 } }));
    expect(prompt).not.toContain('budget');
  });

  it('instructs a non-English response language, but stays silent for English', () => {
    const fa = buildSystemPrompt(baseContext({ language: 'fa' }));
    expect(fa).toContain('Respond in the following language/locale: fa.');

    const en = buildSystemPrompt(baseContext({ language: 'en' }));
    expect(en).not.toContain('Respond in the following language');
  });
});
