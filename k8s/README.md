# Kubernetes manifests (RT-070)

Targets a generic cluster with `ingress-nginx` installed. Not tied to any
specific managed Kubernetes provider (EKS/GKE/AKS) — PVC/StorageClass
choices, TLS certificate issuance (cert-manager, etc.), and the actual
container registry are all deployment-specific and left out.

## What's here

- `namespace.yaml` — the `o2n-runtime` namespace everything else lives in.
- `configmap.yaml` — non-secret env for the gateway and web deployments.
- `secret.yaml.example` — **template only**. Copy to `secret.yaml`, fill in
  real values, and apply directly — do not commit the filled-in version.
  `kubectl create secret generic o2n-gateway-secrets --from-env-file=.env
  -n o2n-runtime` is a safer alternative to editing this file.
- `gateway-deployment.yaml` / `gateway-service.yaml` / `gateway-hpa.yaml` —
  the API gateway, liveness/readiness probes wired to the DB/Redis-aware
  `/health` endpoint (`routes/health.ts`), HPA scaling 2-10 replicas on CPU.
- `web-deployment.yaml` / `web-service.yaml` — the Next.js dashboard,
  probes wired to `/api/health`.
- `ingress.yaml` — routes `api.example.com` → gateway, `app.example.com` →
  web. Replace both hostnames before applying.

## What's NOT here (documented gaps, not oversights)

- No image build/push pipeline — build `Dockerfile.gateway`/`Dockerfile.web`
  and push to your own registry; the manifests reference placeholder image
  names.
- No TLS/cert-manager config — add an `Issuer`/`ClusterIssuer` and
  `tls:` block to `ingress.yaml` for your cluster's certificate setup.
- No StatefulSet for Postgres/Redis — same as `docker-compose.yml`, this
  assumes an already-existing external Postgres/Redis (managed service or
  a separately-operated cluster), not something this app should own.
- No multi-region/VPC config — that's cluster/cloud-account infrastructure
  outside what a set of manifests can express (see `docs/spect/DONE.md`'s
  Phase 5 section for why this is explicitly out of scope for this batch).

## Applying

```sh
kubectl apply -f namespace.yaml
kubectl apply -f configmap.yaml
kubectl apply -f secret.yaml   # your filled-in copy, not the .example
kubectl apply -f gateway-deployment.yaml -f gateway-service.yaml -f gateway-hpa.yaml
kubectl apply -f web-deployment.yaml -f web-service.yaml
kubectl apply -f ingress.yaml
```

Validate syntax without a cluster: `kubectl apply --dry-run=client -f <file>`.
