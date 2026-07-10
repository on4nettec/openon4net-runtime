import { createEmbeddingProvider, type EmbeddingProvider } from '@o2n/llm-providers';
import type { Env } from '../env.js';

/**
 * Wraps the optional embeddings capability (see packages/llm-providers/src/
 * embedding.ts) so callers don't need to know whether it's configured.
 * Disabled (provider === null) when EMBEDDING_MODEL is unset, or when
 * LLM_PROVIDER is anthropic/deepseek (no embeddings endpoint available).
 */
export class EmbeddingService {
  private provider: EmbeddingProvider | null;

  constructor(env: Env) {
    if (!env.EMBEDDING_MODEL) {
      this.provider = null;
      return;
    }
    if (env.LLM_PROVIDER !== 'openai' && env.LLM_PROVIDER !== 'ollama') {
      console.warn(
        `EMBEDDING_MODEL is set but LLM_PROVIDER=${env.LLM_PROVIDER} has no embeddings endpoint via this adapter — semantic memory search stays disabled.`,
      );
      this.provider = null;
      return;
    }
    this.provider = createEmbeddingProvider(env.LLM_PROVIDER, env.LLM_API_KEY, env.EMBEDDING_MODEL, env.LLM_BASE_URL);
  }

  get enabled(): boolean {
    return this.provider !== null;
  }

  /** Best-effort: returns null (rather than throwing) on any failure — a missing embedding must never break a chat turn or memory write. */
  async embed(text: string): Promise<number[] | null> {
    if (!this.provider) return null;
    try {
      const [vector] = await this.provider.embed([text]);
      return vector ?? null;
    } catch (err) {
      console.warn('Embedding generation failed, message saved without one:', err);
      return null;
    }
  }
}
