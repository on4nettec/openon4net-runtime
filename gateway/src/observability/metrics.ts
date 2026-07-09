import client from 'prom-client';

/**
 * Runtime-scoped subset of docs/spect/09_TASKS/03-monitoring.md's metrics
 * taxonomy: HTTP request metrics (all routes) + AI Gateway request metrics
 * (BYOK calls made by LlmService). Deliberately excludes memory-engine /
 * multi-provider-routing metrics — those belong to Control Plane's managed
 * AI Gateway, not this single-provider BYOK runtime.
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests handled by the gateway',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [registry],
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const llmRequestsTotal = new client.Counter({
  name: 'ai_gateway_requests_total',
  help: 'Total LLM completion/stream requests, by provider/model/status',
  labelNames: ['provider', 'model', 'status'] as const,
  registers: [registry],
});

export const llmRequestDurationSeconds = new client.Histogram({
  name: 'ai_gateway_request_duration_seconds',
  help: 'LLM completion/stream request duration in seconds',
  labelNames: ['provider', 'model'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 30, 60],
  registers: [registry],
});

export const llmCostCentsTotal = new client.Counter({
  name: 'ai_gateway_cost_cents_total',
  help: 'Cumulative LLM cost in cents, by provider/model',
  labelNames: ['provider', 'model'] as const,
  registers: [registry],
});
