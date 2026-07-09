import { LlmProviderError, type LlmCompletionRequest, type LlmCompletionResult, type LlmProvider, type LlmStreamChunk } from '@o2n/llm-providers';
import { ModelUnavailableError } from '@o2n/governance';
import { llmRequestDurationSeconds, llmRequestsTotal } from '../observability/metrics.js';

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
    const start = Date.now();
    const labels = { provider: this.provider.name, model: req.model };
    try {
      const result = await this.provider.complete(req);
      this.recordMetrics(labels, start, 'success');
      return result;
    } catch (err) {
      if (!(err instanceof LlmProviderError) || !err.retryable) {
        this.recordMetrics(labels, start, 'error');
        throw new ModelUnavailableError(this.provider.name, err);
      }
      await sleep(RETRY_DELAY_MS);
      try {
        const result = await this.provider.complete(req);
        this.recordMetrics(labels, start, 'success');
        return result;
      } catch (err2) {
        this.recordMetrics(labels, start, 'error');
        throw new ModelUnavailableError(this.provider.name, err2);
      }
    }
  }

  async *stream(req: LlmCompletionRequest): AsyncIterable<LlmStreamChunk> {
    const start = Date.now();
    const labels = { provider: this.provider.name, model: req.model };
    try {
      yield* this.provider.stream(req);
      this.recordMetrics(labels, start, 'success');
    } catch (err) {
      this.recordMetrics(labels, start, 'error');
      throw new ModelUnavailableError(this.provider.name, err);
    }
  }

  private recordMetrics(labels: { provider: string; model: string }, start: number, status: 'success' | 'error'): void {
    llmRequestsTotal.inc({ ...labels, status });
    llmRequestDurationSeconds.observe(labels, (Date.now() - start) / 1000);
  }
}
