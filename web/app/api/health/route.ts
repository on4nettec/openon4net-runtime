// RT-070 — k8s liveness/readiness target for the web container. This process
// has no direct DB/Redis dependency (all data comes through the gateway API,
// see lib/api-client.ts), so "process is up and can serve a response" is the
// whole check — the gateway's own /health covers the DB/Redis-aware case.
export function GET() {
  return Response.json({ status: 'ok' });
}
