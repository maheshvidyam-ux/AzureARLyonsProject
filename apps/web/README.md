# @coa/web — Reviewer SPA

The production reviewer UI (Vite + React + TypeScript). It talks to the reviewer API over HTTP
(`/api/orders…`) and is environment-agnostic: in dev, Vite proxies `/api` to a seeded in-memory
API; in prod the same path is served by the real Fastify API behind the same origin.

## Run locally (two terminals)

```bash
npm install                              # once, from the repo root (installs the web workspace)

npm --workspace @coa/web run dev:api     # seeded in-memory reviewer API on :5174
npm --workspace @coa/web run dev         # the SPA on :5173  (open http://localhost:5173)
```

`dev:api` seeds a small, varied queue by running the recorded sample POs
(`sample-po-001/002/003`) through the **real** order pipeline with mock DI/Foundry/blob and an
in-memory master-data reader — the same path the workers use in production. So the SPA exercises
the genuine `/orders` routes, ETag/`If-Match` optimistic concurrency, and RBAC.

## What's wired

- **Queue** — `GET /orders` (status filter, refresh).
- **Order detail** — `GET /orders/:id` two-pane (canonical CDM left, normalized evidence right);
  edit header + lines → `PATCH` (`If-Match`), **Approve/Reject** → `POST`. A `409` conflict
  reloads instead of clobbering.
- **Dev role switcher** (top bar) — Supervisor / OrderProcessor / Viewer. Viewer is read-only and
  the server returns `403` on writes.

## Auth

Today the client sends the DEV header identity (`x-dev-user` / `x-dev-roles`), matching
`apps/api/src/auth.ts`. When Entra OIDC lands, only `src/auth/AuthContext.tsx` +
`authHeaders()` in `src/api/client.ts` change (bearer token); the rest of the app is untouched.
This dev API must never be exposed on a reachable network — it trusts those headers.

## Not yet in this slice

Dashboard, the AP invoice reviewer, bounding-box PDF overlay (the evidence pane currently shows
the normalized JSON), the manual-upload UI, and URL-based routing.
