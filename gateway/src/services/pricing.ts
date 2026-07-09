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
  'deepseek-chat': { inputPer1k: 0.014, outputPer1k: 0.28 },
  'deepseek-reasoner': { inputPer1k: 0.055, outputPer1k: 0.219 },
};

const DEFAULT_PRICE: ModelPrice = { inputPer1k: 0.3, outputPer1k: 1.5 };
const FREE_PRICE: ModelPrice = { inputPer1k: 0, outputPer1k: 0 };

function priceFor(model: string, provider?: string): ModelPrice {
  // Ollama runs locally with no per-token billing — charging it against
  // MODEL_PRICES/DEFAULT_PRICE would incorrectly drain the agent's budget.
  if (provider === 'ollama') return FREE_PRICE;
  return MODEL_PRICES[model] ?? DEFAULT_PRICE;
}

export function calculateCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
  provider?: string,
): number {
  const price = priceFor(model, provider);
  const cents = (inputTokens / 1000) * price.inputPer1k + (outputTokens / 1000) * price.outputPer1k;
  return Math.ceil(cents);
}

/** Rough pre-call estimate from prompt character length (~4 chars/token), used for the approval-threshold check before any tokens are actually spent. */
export function estimatePromptCostCents(
  model: string,
  promptChars: number,
  provider?: string,
  expectedOutputTokens = 500,
): number {
  const estimatedInputTokens = Math.ceil(promptChars / 4);
  return calculateCostCents(model, estimatedInputTokens, expectedOutputTokens, provider);
}

/**
 * Streaming responses don't report token usage (the Sprint 0 provider
 * adapters only yield text deltas), so cost is estimated from character
 * counts the same way as estimatePromptCostCents — an approximation, same
 * caveat as above.
 */
export function estimateCostCentsFromChars(
  model: string,
  inputChars: number,
  outputChars: number,
  provider?: string,
): number {
  return calculateCostCents(model, Math.ceil(inputChars / 4), Math.ceil(outputChars / 4), provider);
}
