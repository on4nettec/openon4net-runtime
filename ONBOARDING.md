# Developer Onboarding — openon4net-runtime

Gets you from a fresh clone to a working chat with a Digital Employee. This
covers Plane 1 (Runtime) only — see `docs/spect/02_ARCHITECTURE/
14-monorepo-layout.md` if you need the other planes.

## 1. Prerequisites

- Node 20+, [pnpm](https://pnpm.io) (`corepack enable` or `npm i -g pnpm`)
- Docker Desktop (or compatible) running
- Git

## 2. Clone with submodules

This repo (`openon4net-runtime`) is a git submodule of the parent
`openon4net` repo, which owns the shared `packages/*` (types, governance,
LLM provider adapters) that the gateway/web depend on. You need the parent
checked out too:

```
git clone --recurse-submodules git@github.com:on4nettec/openon4net.git
cd openon4net
pnpm install
```

If you already cloned without `--recurse-submodules`:

```
git submodule update --init --recursive
```

## 3. Configure environment

```
cd apps/openon4net-runtime
cp .env.example .env
```

Open `.env` and fill in:

- `JWT_SECRET`, `DEV_API_KEY` — any random strings for local dev
- `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_MODEL` — pick one:
  - Have an Anthropic/OpenAI/DeepSeek key? Use that provider.
  - No API key? Install [Ollama](https://ollama.com), pull a model
    (`ollama pull gemma3:4b`), set `LLM_PROVIDER=ollama`, `LLM_API_KEY=ollama`
    (unchecked, but the SDK requires a non-empty string), `LLM_MODEL=gemma3:4b`.
    This is free and fully local — what this project's own dev/testing uses.

**This one `.env` file is read by both `pnpm dev` and `docker compose`** —
don't create a second one under `gateway/`, it will drift out of sync (see
Gotchas below).

## 4. Get Postgres/Redis/MinIO running

`docker-compose.yml` (gateway+web) does **not** start these — it expects them
to already exist (this project's own dev setup points at shared
infrastructure on the host machine). If you don't have your own already:

```
docker compose -f docker-compose.infra.yml up -d
```

This matches `.env.example`'s defaults exactly (ports 5532/6479/9500-9501,
`o2n`/`o2n_dev_password`), so no `.env` edits needed. Migrations run
automatically on first boot via Postgres's own `/docker-entrypoint-initdb.d`.

## 5. Run it

**Option A — fully in Docker:**

```
docker compose up -d --build
curl http://localhost:4000/health   # {"status":"ok"}
```

Open http://localhost:3200.

**Option B — gateway on the host (faster iteration), web in Docker or also on host:**

In `.env`, comment out the "Mode A" `DATABASE_URL`/`REDIS_URL` lines and
uncomment the "Mode B" ones (`localhost` instead of `host.docker.internal` —
see Gotchas). Then:

```
cd gateway && pnpm dev
```

## 6. First login

The dashboard's login doubles as org bootstrap — there's no separate sign-up
flow. Pick any slug; a new one creates a fresh org + default admin user:

- Organization slug: anything, e.g. `acme`
- Dev API key: whatever you put in `.env`'s `DEV_API_KEY`

Then create an agent and chat with it.

## 7. Everyday commands (from the repo root, `openon4net/`)

```
pnpm turbo run lint typecheck test build   # everything, all packages + apps
pnpm turbo run build --filter=@o2n/gateway # just the gateway
```

## Gotchas (all hit for real during development — not hypothetical)

- **`host.docker.internal` vs `localhost`.** Inside a Docker container,
  `localhost` means the container itself. If the gateway runs in Docker but
  Postgres/Redis run in separate containers, use `host.docker.internal`. If
  the gateway runs directly on the host (`pnpm dev`), use `localhost`. This
  is why `.env.example` has two commented blocks — switch which one is
  active depending on how you're currently running the gateway.
- **Two `.env` files silently drifting.** If you ever end up with both
  `apps/openon4net-runtime/.env` and `apps/openon4net-runtime/gateway/.env`,
  a mismatched `JWT_SECRET` between them makes every request fail with
  "Invalid or expired token" for no apparent reason. There should only ever
  be one `.env`, at the runtime root.
- **Bodyless POST/DELETE requests need no `Content-Type` header.** Fastify's
  default JSON body parser rejects a zero-byte body that claims
  `Content-Type: application/json` (`FST_ERR_CTP_EMPTY_JSON_BODY`) — surfaces
  as a silent 500 in the browser. The web client (`lib/api-client.ts`) only
  sets that header when there's an actual body.
- **Routes that write straight to `reply.raw`** (the SSE chat stream) bypass
  Fastify's plugin pipeline entirely, including `@fastify/cors`'s automatic
  header injection. If you add another raw-streaming route, you'll need to
  set `Access-Control-Allow-Origin` by hand there too (see `routes/chat.ts`).
- **Ollama and free providers never trigger the approval queue** — cost
  estimation returns 0 for `LLM_PROVIDER=ollama`, so
  `estimatedCost > threshold` is never true. To test the approval flow
  locally, temporarily switch to a paid-provider model name (the call can
  fail with a bad key — the approval queue entry still gets created before
  any LLM call happens).
