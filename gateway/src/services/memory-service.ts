import type { Conversation, Message, MessageRole } from '@o2n/shared';
import { NotFoundError } from '@o2n/governance';
import type { Queryable } from '../db.js';
import type { RedisClient } from '../redis.js';
import type { EmbeddingService } from './embedding-service.js';

/** pgvector literal format: '[0.1,0.2,...]' */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

interface ConversationRow {
  id: string;
  agent_id: string;
  user_id: string | null;
  title: string | null;
  summary: string | null;
  tags: string[] | null;
  message_count: number;
  token_count: number;
  status: Conversation['status'];
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  model: string | null;
  cost_cents: number;
  tokens: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    agentId: row.agent_id,
    userId: row.user_id,
    title: row.title,
    summary: row.summary,
    tags: row.tags ?? [],
    messageCount: row.message_count,
    tokenCount: row.token_count,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    model: row.model,
    costCents: row.cost_cents,
    tokens: row.tokens,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

const SHORT_MEMORY_MAX_MESSAGES = 50;
export const AUTO_SUMMARY_EVERY_N_MESSAGES = 50;

export class MemoryService {
  constructor(
    private db: Queryable,
    private redis: RedisClient,
    private shortMemoryTtlSeconds: number,
    private embeddingService: EmbeddingService,
  ) {}

  // --- L2: Postgres conversation memory ---

  async getConversationById(conversationId: string): Promise<Conversation> {
    const { rows } = await this.db.query<ConversationRow>(`SELECT * FROM conversations WHERE id = $1`, [
      conversationId,
    ]);
    const row = rows[0];
    if (!row) throw new NotFoundError('Conversation', conversationId);
    return toConversation(row);
  }

  /** Most recent conversation for an agent, or null if none exists yet — used to resume a chat on page load. */
  async getLatestConversation(agentId: string): Promise<Conversation | null> {
    const { rows } = await this.db.query<ConversationRow>(
      `SELECT * FROM conversations WHERE agent_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [agentId],
    );
    const row = rows[0];
    return row ? toConversation(row) : null;
  }

  /** RT-022 — every session for an agent, most-recently-active first, for the session picker's "Recent" list. */
  async listConversations(agentId: string, options: { includeArchived?: boolean } = {}): Promise<Conversation[]> {
    const { rows } = await this.db.query<ConversationRow>(
      options.includeArchived
        ? `SELECT * FROM conversations WHERE agent_id = $1 ORDER BY updated_at DESC`
        : `SELECT * FROM conversations WHERE agent_id = $1 AND status != 'archived' ORDER BY updated_at DESC`,
      [agentId],
    );
    return rows.map(toConversation);
  }

  /** RT-022 — explicit "+ New session", distinct from getOrCreateConversation's implicit resume-or-create. */
  async createConversation(agentId: string, userId: string | null, title?: string): Promise<Conversation> {
    const { rows } = await this.db.query<ConversationRow>(
      `INSERT INTO conversations (agent_id, user_id, title) VALUES ($1, $2, $3) RETURNING *`,
      [agentId, userId, title ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    return toConversation(row);
  }

  async renameConversation(conversationId: string, title: string): Promise<Conversation> {
    const { rows } = await this.db.query<ConversationRow>(
      `UPDATE conversations SET title = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [conversationId, title],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Conversation', conversationId);
    return toConversation(row);
  }

  /** Soft-delete, same reasoning as workspaces/agents — a session's messages/audit trail must survive. */
  async archiveConversation(conversationId: string): Promise<Conversation> {
    const { rows } = await this.db.query<ConversationRow>(
      `UPDATE conversations SET status = 'archived', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [conversationId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Conversation', conversationId);
    return toConversation(row);
  }

  async getOrCreateConversation(agentId: string, userId: string | null, conversationId?: string): Promise<Conversation> {
    if (conversationId) {
      const { rows } = await this.db.query<ConversationRow>(
        `SELECT * FROM conversations WHERE id = $1 AND agent_id = $2`,
        [conversationId, agentId],
      );
      const row = rows[0];
      if (!row) throw new NotFoundError('Conversation', conversationId);
      return toConversation(row);
    }

    const { rows } = await this.db.query<ConversationRow>(
      `INSERT INTO conversations (agent_id, user_id) VALUES ($1, $2) RETURNING *`,
      [agentId, userId],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    return toConversation(row);
  }

  async appendMessage(
    conversationId: string,
    input: { role: MessageRole; content: string; model?: string | null; costCents?: number; tokens?: number; metadata?: Record<string, unknown> },
  ): Promise<Message> {
    const { rows } = await this.db.query<MessageRow>(
      `INSERT INTO messages (conversation_id, role, content, model, cost_cents, tokens, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        conversationId,
        input.role,
        input.content,
        input.model ?? null,
        input.costCents ?? 0,
        input.tokens ?? 0,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');

    await this.db.query(
      `UPDATE conversations
       SET message_count = message_count + 1,
           token_count = token_count + $2,
           updated_at = NOW()
       WHERE id = $1`,
      [conversationId, input.tokens ?? 0],
    );

    await this.appendToShortMemory(conversationId, { role: input.role, content: input.content });

    // Best-effort — EmbeddingService.embed() never throws, returns null when
    // disabled or on failure, in which case the message just stays
    // unsearchable semantically (searchMessagesSemantic falls back to ILIKE
    // regardless, per-row, since this column is nullable).
    const embedding = await this.embeddingService.embed(input.content);
    if (embedding) {
      await this.db.query(`UPDATE messages SET embedding = $2 WHERE id = $1`, [row.id, toVectorLiteral(embedding)]);
    }

    return toMessage(row);
  }

  async getRecentMessages(conversationId: string, limit = 10): Promise<Message[]> {
    const { rows } = await this.db.query<MessageRow>(
      `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [conversationId, limit],
    );
    return rows.map(toMessage).reverse();
  }

  async searchMessages(conversationId: string, query: string, limit: number): Promise<Message[]> {
    const { rows } = await this.db.query<MessageRow>(
      `SELECT * FROM messages
       WHERE conversation_id = $1 AND content ILIKE $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [conversationId, `%${query}%`, limit],
    );
    return rows.map(toMessage);
  }

  /**
   * Cosine-similarity search over messages.embedding (migrations/0008_vector_search.sql).
   * Caller must check embeddingService.enabled first — if the query itself
   * fails to embed (provider error), falls back to searchMessages(). Rows
   * with a NULL embedding (written before this feature was enabled, or when
   * embedding generation failed for that specific message) are excluded by
   * the `IS NOT NULL` filter, not surfaced as false matches.
   */
  async searchMessagesSemantic(conversationId: string, query: string, limit: number): Promise<Message[]> {
    const queryEmbedding = await this.embeddingService.embed(query);
    if (!queryEmbedding) {
      return this.searchMessages(conversationId, query, limit);
    }
    const { rows } = await this.db.query<MessageRow>(
      `SELECT * FROM messages
       WHERE conversation_id = $1 AND embedding IS NOT NULL
       ORDER BY embedding <=> $2
       LIMIT $3`,
      [conversationId, toVectorLiteral(queryEmbedding), limit],
    );
    return rows.map(toMessage);
  }

  async updateSummary(conversationId: string, summary: string): Promise<void> {
    await this.db.query(`UPDATE conversations SET summary = $2, updated_at = NOW() WHERE id = $1`, [
      conversationId,
      summary,
    ]);
  }

  // --- L1: Redis short memory (session:{conversation_id}:messages) ---

  async appendToShortMemory(conversationId: string, msg: { role: MessageRole; content: string }): Promise<void> {
    const key = `session:${conversationId}:messages`;
    await this.redis.lpush(key, JSON.stringify({ ...msg, ts: Date.now() }));
    await this.redis.ltrim(key, 0, SHORT_MEMORY_MAX_MESSAGES - 1);
    await this.redis.expire(key, this.shortMemoryTtlSeconds);
  }

  async getShortMemory(conversationId: string): Promise<{ role: MessageRole; content: string; ts: number }[]> {
    const key = `session:${conversationId}:messages`;
    const raw = await this.redis.lrange(key, 0, -1);
    return raw.map((r) => JSON.parse(r) as { role: MessageRole; content: string; ts: number }).reverse();
  }
}
