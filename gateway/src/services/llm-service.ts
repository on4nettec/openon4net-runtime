import { LlmProviderError, type LlmCompletionRequest, type LlmCompletionResult, type LlmProvider, type LlmStreamChunk } from '@o2n/llm-providers';
import { ModelUnavailableError } from '@o2n/governance';

const RETRY_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * BYOK: exactly one provider, one retry, no cross-provider fallback. The
 * routing/fallback-chain/circuit-breaker pipeline in
 * docs/spect/02_ARCHITECTURE/02-ai-gateway.md belongs only to Control
 * Plane's managed AI Gateway (docs/spect/02_ARCHITECTURE/14-monorepo-layout.md
 * v2 §3) — Runtime deliberately does not reimplement it.
 */
export class LlmService {
  constructor(private provider: LlmProvider) {}

  async completeWithRetry(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    try {
      return await this.provider.complete(req);
    } catch (err) {
      if (!(err instanceof LlmProviderError) || !err.retryable) {
        throw new ModelUnavailableError(this.provider.name, err);
      }
      await sleep(RETRY_DELAY_MS);
      try {
        return await this.provider.complete(req);
      } catch (err2) {
        throw new ModelUnavailableError(this.provider.name, err2);
      }
    }
  }

  async *stream(req: LlmCompletionRequest): AsyncIterable<LlmStreamChunk> {
    try {
      yield* this.provider.stream(req);
    } catch (err) {
      throw new ModelUnavailableError(this.provider.name, err);
    }
  }
}
