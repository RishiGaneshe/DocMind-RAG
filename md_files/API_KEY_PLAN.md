# Public API Keys & Embeddable Chat Widget — Implementation Plan

Approved 2026-09-01. Supersedes the single plaintext `tenants.apiKey`.

## 1. Goal

A signed-in workspace owner mints API keys from the dashboard. Each key resolves
to exactly one workspace server-side. A **public** key is embedded in a chat
widget that ships on the owner's own website, where visitors chat with no
account and no login. The backend learns the workspace from the key alone — no
`tenantId` in any public URL, and no end-user JWT anywhere in the flow.

## 2. Current state

- `tenants.apiKey` exists: a bare `crypto.randomUUID()`, stored **in plaintext**,
  one per tenant, with no rotation, revocation, scoping, or usage accounting.
  Nothing in the codebase authenticates with it.
- It is surfaced through `GET /api/tenants/me` and `GET /api/auth/me`
  (`services/authService.js:165`) and rendered on a settings page whose own copy
  reads *"This key cannot be rotated… never ship it in a browser bundle."*
  The frontend already documents the gap this plan fills.
- Every route requires a JWT: `authenticate` → `requireTenant` → limiter →
  `promptGuardrails`. Tenant identity comes from the token, and `requireTenant`
  proves the URL's `:tenantId` matches it.
- `queryRAG(tenantId, query, opts)` is tenant-scoped end to end (Pinecone
  namespace + SQL `where tenantId`), so it can be driven by any caller that can
  resolve a tenant.

## 3. The constraint that shapes everything

A key shipped in browser JavaScript is **not secret**, regardless of how deeply
it is buried in a bundle. It is readable from the Network tab in seconds.
Therefore the key is designed as a *publishable identifier* — like a Stripe
publishable key or a Google Maps browser key — and security comes from what the
key is permitted to do, not from concealing it.

| Layer | What it actually stops |
|---|---|
| Scopes (`chat:query` only) | A lifted widget key cannot upload, list, or delete documents |
| Origin allowlist | Someone pasting your widget onto their own site |
| Per-key rate limit + daily quota | Cost abuse — the layer that truly caps the bill |
| Instant revoke + rotate-with-grace | Leak response without widget downtime |

Origin checking is honest-but-partial: browsers set `Origin` and page JS cannot
forge it, but `curl` can. The quota — not the origin check — is the real
ceiling. Every `/query` costs three paid upstream calls (Voyage embed, Voyage
rerank, NVIDIA generate), so an uncapped public key is a billing incident in
waiting.

## 4. Resolved decisions

1. **Both key types ship now.** Storage and verification are identical, so the
   secret variant costs a `type` column and a scope set.
   - `pk_live_…` — public/publishable. Goes in the widget. Scopes limited to
     `chat:query` and `chat:config`. Origin-locked.
   - `sk_live_…` — secret. Server-to-server (automated ingestion, a customer's
     own backend proxy). Never origin-checked; may carry document scopes.
2. **Conversation history is client-sent**, reusing the existing `history`
   parameter. Zero server state. Hard-capped on both turn count *and* total
   characters so history cannot be used to inflate LLM cost. A client-supplied
   `sessionId` is recorded for analytics only and never used as a rate-limit
   bucket — an attacker simply rotates it. Rate limiting buckets on visitor IP.
3. **Default limits**, all owner-adjustable per key: 30 requests/minute per key,
   10 requests/minute per visitor IP within a key, 500 messages/day per key.
4. **An empty origin allowlist means allow-all**, reported back as
   `unrestricted: true` so the dashboard can warn. Operators who want strictness
   set `PUBLIC_KEY_REQUIRE_ORIGINS=true`, which rejects key creation without at
   least one origin.

## 5. Architecture

The key **does not encode** the workspace. It is a random token that *maps* to a
tenant row server-side. This is deliberately different from stuffing `tenantId`
into a signed JWT-style key: mapping buys revocation, rotation, per-key limits,
and usage stats, and keeps tenant UUIDs off the public internet. The cost is one
lookup, which Redis absorbs.

```
POST /api/public/chat            ← no tenantId in the URL, ever
  X-Api-Key: pk_live_…
     │
     ├─ format check (regex; no DB hit for garbage)
     ├─ sha256(key) → Redis `apikey:v1:<hash>` → Postgres on miss
     ├─ revoked? expired?
     ├─ scopes include 'chat:query'?
     ├─ Origin/Referer ∈ allowedOrigins?
     ├─ Redis quota: per-key/min, per-visitor-IP/min, per-key/day
     ├─ promptGuardrails
     └─ queryRAG(key.tenantId, …) → redacted response
```

## 6. Data model

New `api_keys` table, migration `0003-api-keys.js`:

```
id                    UUID PK
tenantId              UUID → tenants(id) ON DELETE CASCADE
createdBy             UUID → users(id) ON DELETE SET NULL   (audit)
name                  VARCHAR(80)     "Marketing site widget"
type                  enum            'public' | 'secret'
keyPrefix             VARCHAR(32)     'pk_live_a1b2c3'  ← shown in dashboard
keyLast4              CHAR(4)
keyHash               CHAR(64) UNIQUE ← sha256 hex; the only copy retained
scopes                TEXT[]
allowedOrigins        TEXT[]
rateLimitPerMinute    INTEGER
dailyQuota            INTEGER NULL    (null → config default)
lastUsedAt            TIMESTAMPTZ NULL
lastUsedIp            VARCHAR(64) NULL
totalRequests         BIGINT DEFAULT 0
expiresAt             TIMESTAMPTZ NULL  ← rotation grace window
revokedAt             TIMESTAMPTZ NULL
rotatedFromId         UUID NULL
createdAt, updatedAt  TIMESTAMPTZ
```

Indexes: unique on `keyHash` (the hot lookup), plain on `tenantId`, partial on
`tenantId WHERE revokedAt IS NULL` for the dashboard list.

Plus `tenants.widgetConfig JSONB NOT NULL DEFAULT '{}'` — title, greeting,
suggested questions, theme, and the source-exposure mode from §8.

### Why SHA-256 and not bcrypt

Bcrypt at cost 12 is ~250 ms, unusable on a chat hot path, and an unindexable
hash would force a full scan of every key per request. SHA-256 is safe *in this
specific case* because the input is 256 bits from `crypto.randomBytes`, not a
human-chosen password — fast-hash weakness only matters for guessable inputs.
Lookup becomes a single unique-index equality. This is how GitHub and Stripe
verify tokens.

Generation: `pk_live_` + `crypto.randomBytes(32).toString('base64url')`.

## 7. Route surface

### Public — key auth, no user auth

```
POST /api/public/chat      { query, history?, stream?, sessionId? }
GET  /api/public/config    → workspace name + widget branding, for bootstrap
```

Responses mirror `/api/tenants/:id/query` exactly — same JSON shape, same SSE
`sources` / `chunk` / `done` events — so the widget and the dashboard can share
one client. `GET /config` also lets the widget fail fast on a dead or misscoped
key before the visitor types anything.

Enforced server-side for public keys, ignoring whatever the client asks for:

- `topK` is clamped to `publicApiConfig.maxTopK`.
- `documentIds` is dropped unless the key carries the `chat:filter` scope.
- `history` is capped on turns and on total characters.
- `promptGuardrails` runs before anything paid.

### Management — JWT, workspace owner only

```
POST    /api/tenants/:tenantId/api-keys              create → full key, once
GET     /api/tenants/:tenantId/api-keys              list (prefix/last4 + usage)
PATCH   /api/tenants/:tenantId/api-keys/:keyId       rename, origins, limits
POST    /api/tenants/:tenantId/api-keys/:keyId/rotate new secret + grace window
DELETE  /api/tenants/:tenantId/api-keys/:keyId       revoke (soft, audit kept)
GET     /api/tenants/:tenantId/api-keys/:keyId/usage counters
GET/PUT /api/tenants/:tenantId/widget                widget config
```

The plaintext key is returned by exactly two endpoints — create and rotate — and
never again.

## 8. Two things that need care

### CORS ordering

`app.js` mounts `cors({ origin: config.allowedOrigins })` globally. The `cors`
package answers **every** `OPTIONS` with 204 and simply omits
`Access-Control-Allow-Origin` when the origin does not match — so a preflight
from a customer's site would receive a headerless 204 and the browser would block
the request before our code ran.

The public router therefore mounts **before** the global CORS, carrying its own
`cors({ origin: true, credentials: false })` and its own
`express.json({ limit: '32kb' })`. A preflight cannot carry the key (custom
headers are not sent on `OPTIONS`, only announced in
`Access-Control-Request-Headers`), so the allowlist is enforced on the actual
POST and returns readable 403 JSON rather than an opaque CORS failure. Reflecting
the origin costs nothing because the route sets no cookies — CORS is not the
protection layer here, the origin *check* is.

### Source redaction

`rag/ragEngine.js:44` returns per source: `documentId`, `filename`, `page`,
`relevanceScore`, `scoreType`, and a 240-character `snippet` of raw chunk text.
Handing all of that to anonymous internet visitors leaks internal filenames
(`2026-restructuring-draft.pdf`) and lets a caller walk the corpus out 240
characters at a time.

The public route gets a redaction pass driven by `widgetConfig.sourceMode`:

| Mode | Exposes |
|---|---|
| `full` | Everything, as the dashboard sees it |
| `labels` (default) | Citation number, filename, page — no snippet, no ids, no scores |
| `hidden` | Nothing; `sources: []` |

## 9. Phases

| # | Scope | Files |
|---|---|---|
| 1 | Schema | `migrations/0003-api-keys.js`, `models/ApiKey.js`, `models/index.js`, `models/Tenant.js` |
| 2 | Key service | `services/apiKeyService.js` (mint / verify / rotate / revoke, Redis cache with negative caching), `services/quotaService.js` (Redis `INCR` fixed-window, cross-process) |
| 3 | Middleware | `middleware/apiKeyAuth.js`, `middleware/originGuard.js` |
| 4 | Public API | `api/publicChat.js`, wiring in `app.js` ahead of the global CORS |
| 5 | Management API | `api/apiKeys.js`, `api/widget.js` |
| 6 | Hardening | stop leaking `tenants.apiKey` from `authService.js:165` and `/api/tenants/me`; deprecate the column; add `publicApiConfig` to `config.js`; README and `.env` docs |
| 7 | Tests | `tests/apiKey.test.js`, `tests/originGuard.test.js`, `tests/quota.test.js` — key parsing, origin matching including `https://*.acme.com` wildcards and the `evil-acme.com` near-miss, scope gating, redaction |

## 10. Incidental fixes folded into phase 6

`middleware/rateLimit.js:14` buckets on `req.user?.id`, but `authenticate` sets
`req.user.userId`. `id` is therefore always undefined and **every authenticated
request falls through to IP bucketing** — precisely the shared-NAT problem the
comment above it claims to avoid. The same slip at `middleware/guardrails.js:101`
makes every rejection log read `anonymous`.

## 11. Non-goals for this pass

- Serving the widget bundle itself (`GET /api/public/widget.js`). The contract
  above is what a separately built widget consumes.
- Server-side conversation sessions (see §4.2).
- `test` vs `live` key environments; only `live` is minted.
- Per-plan quota tiers. Quotas are per-key values with a config default.
- Flushing Redis usage counters into a durable analytics table.

