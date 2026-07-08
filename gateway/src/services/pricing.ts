interface ModelPrice {
  /** cents per 1,000 input tokens */
  inputPer1k: number;
  /** cents per 1,000 output tokens */
  outputPer1k: number;
}

// Approximate public list prices, cents per 1K tokens. Good enough for local
// budget enforcement in Sprint 0 — Control Plane's managed AI Gateway is the
// place for precise, centrally-updated pricing (out of scope here).
const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-3-5-sonnet-20241022': { inputPer1k: 0.3, outputPer1k: 1.5 },
  'claude-3-5-haiku-20241022': { inputPer1k: 0.08, outputPer1k: 0.4 },
  'gpt-4o': { inputPer1k: 0.25, outputPer1k: 1.0 },
  'gpt-4o-mini': { inputPer1k: 0.015, outputPer1k: 0.06 },
};

const DEFAULT_PRICE: ModelPrice = { inputPer1k: 0.3, outputPer1k: 1.5 };

function priceFor(model: string): ModelPrice {
  return MODEL_PRICES[model] ?? DEFAULT_PRICE;
}

export function calculateCostCents(model: string, inputTokens: number, outputTokens: number): number {
  const price = priceFor(model);
  const cents = (inputTokens / 1000) * price.inputPer1k + (outputTokens / 1000) * price.outputPer1k;
  return Math.ceil(cents);
}

/** Rough pre-call estimate from prompt character length (~4 chars/token), used for the approval-threshold check before any tokens are actually spent. */
export function estimatePromptCostCents(model: string, promptChars: number, expectedOutputTokens = 500): number {
  const estimatedInputTokens = Math.ceil(promptChars / 4);
  return calculateCostCents(model, estimatedInputTokens, expectedOutputTokens);
}
