import type { Agent, Conversation, MessageRole } from '@o2n/shared';
import type { Db } from '../db.js';
import { OrgService } from './org-service.js';
import { WorkspaceService } from './workspace-service.js';
import { SkillGrantService } from './skill-grant-service.js';
import { PluginGrantService } from './plugin-grant-service.js';
import { SkillService } from './skill-service.js';
import { LocalPluginService } from './local-plugin-service.js';
import { UserService } from './user-service.js';
import type { MemoryService } from './memory-service.js';

/**
 * docs/spect/02_ARCHITECTURE/01-system-overview.md's "Context Contract":
 * context is a formal artifact assembled from these layers, not free-form
 * text. prompt-builder.ts compresses this into a single system message —
 * the layers themselves are never forwarded to the LLM as-is.
 */
export interface ContextContract {
  identity: { agentId: string; name: string; role: string };
  task: { message: string; conversationId: string };
  workspace: { organizationName: string; workspaceName: string };
  memory: { summary: string | null; relevant: { role: MessageRole; content: string }[] };
  tools: { skills: string[]; plugins: string[] };
  permissions: { budgetRemainingCents: number };
  language: string;
  trace: { traceId: string };
}

export interface BuildContextInput {
  organizationId: string;
  /** null for system-initiated turns (the scheduler) — language falls back to the org's. */
  userId: string | null;
  agent: Agent;
  conversation: Conversation;
  message: string;
  traceId: string;
}

const RELEVANT_MEMORY_LIMIT = 3;
// Below this, chat-service.ts's own recent-message window (last 10 turns,
// replayed as full messages) already covers the entire conversation —
// semantic search would just resurface what's already in the prompt.
const RELEVANT_MEMORY_MIN_MESSAGE_COUNT = 10;

export class ContextBuilder {
  constructor(
    private db: Db,
    private memoryService: MemoryService,
  ) {}

  async build(input: BuildContextInput): Promise<ContextContract> {
    const { organizationId, userId, agent, conversation, message, traceId } = input;

    const [org, workspace, skillGrants, pluginGrants, user] = await Promise.all([
      new OrgService(this.db).getById(organizationId),
      new WorkspaceService(this.db).getById(organizationId, agent.workspaceId),
      new SkillGrantService(this.db).listForAgent(agent.id),
      new PluginGrantService(this.db).listForAgent(agent.id),
      userId ? new UserService(this.db).findById(userId) : Promise.resolve(null),
    ]);
    const language = user?.language ?? org.language;

    const [skills, plugins] = await Promise.all([
      this.resolveSkillNames(
        organizationId,
        skillGrants.map((g) => g.skillId),
      ),
      this.resolvePluginNames(
        organizationId,
        pluginGrants.map((g) => g.pluginId),
      ),
    ]);

    const relevant =
      conversation.messageCount > RELEVANT_MEMORY_MIN_MESSAGE_COUNT
        ? (await this.memoryService.searchMessagesSemantic(conversation.id, message, RELEVANT_MEMORY_LIMIT)).map(
            (m) => ({ role: m.role, content: m.content }),
          )
        : [];

    return {
      identity: { agentId: agent.id, name: agent.name, role: agent.role },
      task: { message, conversationId: conversation.id },
      workspace: { organizationName: org.name, workspaceName: workspace.name },
      memory: { summary: conversation.summary, relevant },
      tools: { skills, plugins },
      permissions: { budgetRemainingCents: Math.max(0, agent.monthlyBudgetCents - agent.usedBudgetCents) },
      language,
      trace: { traceId },
    };
  }

  private async resolveSkillNames(organizationId: string, skillIds: string[]): Promise<string[]> {
    if (skillIds.length === 0) return [];
    const skillService = new SkillService(this.db);
    const skills = await Promise.all(skillIds.map((id) => skillService.getById(organizationId, id).catch(() => null)));
    return skills.filter((s): s is NonNullable<typeof s> => s !== null).map((s) => s.name);
  }

  private async resolvePluginNames(organizationId: string, pluginIds: string[]): Promise<string[]> {
    if (pluginIds.length === 0) return [];
    const pluginService = new LocalPluginService(this.db);
    const plugins = await Promise.all(pluginIds.map((id) => pluginService.getById(organizationId, id)));
    return plugins.filter((p): p is NonNullable<typeof p> => p !== null).map((p) => p.name);
  }
}
