# API Reference

Every HTTP endpoint this backend exposes, grouped by who calls it.

There are **two entirely separate credentials** in this system and they are not
interchangeable:

| | Credential | Header | Who holds it | Base path |
|---|---|---|---|---|
| **Owner API** | JWT access token | `Authorization: Bearer <jwt>` | the logged-in user, in your dashboard | `/api/auth`, `/api/tenants/…` |
| **Public API** | workspace API key | `X-Api-Key: pk_live_…` | the chat widget, on a customer's website | `/api/public/…` |

A `pk_live_` key cannot mint keys, read documents, or reach anything under
`/api/tenants`. A JWT cannot reach `/api/public`. Sending the wrong one gets a 401
in both directions.

- For the step-by-step embed walkthrough, see [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md).
- For why the design looks like this, see [API_KEY_IMPLEMENTATION.md](API_KEY_IMPLEMENTATION.md).

---

## Contents

1. [Conventions](#1-conventions)
2. [Owner API — authentication](#2-owner-api--authentication)
3. [Owner API — workspaces](#3-owner-api--workspaces)
4. [Owner API — documents](#4-owner-api--documents)
5. [Owner API — dashboard chat](#5-owner-api--dashboard-chat)
6. [Owner API — API keys](#6-owner-api--api-keys)
7. [Owner API — widget configuration](#7-owner-api--widget-configuration)
8. [Public API — the widget surface](#8-public-api--the-widget-surface)
9. [Response headers](#9-response-headers)
10. [Scopes](#10-scopes)
11. [Error code index](#11-error-code-index)

---

## 1. Conventions

### Base URL

`http://localhost:4500` in development (`PORT`, default `4500`). Every path below is
absolute from that origin.

### Content type

`application/json` on every request that has a body, except document upload, which
is `multipart/form-data`.

Body size limits differ by router and this matters:

| Router | Limit | Set by |
|---|---|---|
| `/api/public/*` | **32 kb** | `PUBLIC_BODY_LIMIT` |
| everything else | 1 mb | hard-coded in `app.js` |
| document upload | 10 mb per file | `UPLOAD_MAX_BYTES` |

### The success envelope

Almost every response carries `success`:

```json
{ "success": true, "…": "…" }
```

### The three error shapes

This is the single most important thing to get right in a client, because there are
**three** of them and they are not the same shape.

**Shape A — a route handler rejected the request.** The common case: all 4xx from
business logic, all 401/403, all 429.

```json
{ "success": false, "error": "This API key has been revoked.", "code": "API_KEY_REVOKED" }
```

`error` is a **human-readable string**. `code` is a stable machine token, present on
most but not all of them (see §11 for which).

**Shape B — Express rejected the request before any handler ran.** An oversized
body (413) or malformed JSON (400). `error` is an **object**, and there is no
`success` and no `code`.

```json
{ "error": { "message": "request entity too large" } }
```

**Shape C — no route matched.** A typo in the path.

```json
{ "error": "Not found", "path": "/api/publik/chat" }
```

Normalise all three at your transport layer once, and never touch `error` directly
again:

```js
/** Turns any of the three server error shapes into { message, code }. */
function normaliseError (status, body) {
  if (body && typeof body.error === 'object' && body.error !== null) {
    return { message: body.error.message ?? 'Request failed', code: null }   // B
  }

  if (body && typeof body.error === 'string') {
    return { message: body.error, code: body.code ?? null }                  // A and C
  }

  return { message: `Request failed with status ${status}`, code: null }
}
```

A fourth case exists and is the one that catches people out: **a non-JSON body**. A
502 from a reverse proxy in front of this server is HTML, and `await res.json()`
throws a `SyntaxError` that has nothing to do with the actual failure. Always guard
the parse:

```js
const body = await response.json().catch(() => null)
```

### CORS

Two different policies, because the two audiences are different.

| | `/api/public/*` | everything else |
|---|---|---|
| Allowed origins | **any** — reflected back | allowlist from `FRONTEND_ORIGIN` |
| Credentials | **never** | not enabled |
| Allowed headers | `Content-Type`, `X-Api-Key`, `Authorization` | `Content-Type`, `Authorization` |
| Methods | `GET`, `POST`, `OPTIONS` | + `PUT`, `PATCH`, `DELETE` |
| Preflight cache | 24 h (`Access-Control-Max-Age: 86400`) | browser default |

The public router reflects any origin **by design** — a widget is embedded on
customer sites that cannot be enumerated in advance. The real per-key origin check
happens after the key is resolved, and returns `403 ORIGIN_NOT_ALLOWED` (§8). A
preflight carries no `X-Api-Key`, so it cannot be checked there.

Consequence for your dashboard: `FRONTEND_ORIGIN` must list your dashboard's origin
or every owner-API call fails at the browser with an opaque CORS error, before any
status code exists to read. It defaults to `http://localhost:5173` and takes a
comma-separated list.

Consequence for the widget: **never** set `credentials: 'include'` on a
`/api/public` request. `Access-Control-Allow-Credentials` is deliberately absent, so
the browser will reject the response and your `catch` block sees a bare
`TypeError: Failed to fetch` with no status.

### Rate limiting, in three layers

| Layer | Applies to | Bucket | Store | Default |
|---|---|---|---|---|
| `generalLimiter` | all `/api/*` **except** `/api/public` | user id, else IP | process memory | 300/min |
| `authLimiter` | `/api/auth/*` | user id, else IP | process memory | 20/min |
| `queryLimiter` | `/api/tenants/:id/query` | user id, else IP | process memory | 20/min |
| `uploadLimiter` | document upload | user id, else IP | process memory | 10/min |
| `enforceQuota` | `/api/public/*` | key, visitor IP, key-day | **Redis** | 30/min, 10/min, 500/day |

Only the public tier is Redis-backed, so only it holds across multiple server
processes. See §9 for the headers each one sets.

### UUIDs

`tenantId`, `keyId`, `documentId` are all v4 UUIDs. Where a route validates the
format it returns `400`; where it does not, a malformed id becomes a `404`.

---

## 2. Owner API — authentication

All tokens are JWTs signed with `JWT_SECRET`. The access token expires in **15
minutes** (`JWT_ACCESS_EXPIRY`), the refresh token in **7 days**
(`JWT_REFRESH_EXPIRY`).

The access token payload carries `userId`, `email`, `tenantId`, `role`, `type`, `jti`.
**`tenantId` is baked into the token**, which has a consequence you must handle: after
creating a workspace, the token you were holding does not know about it. `POST
/api/tenants` returns a fresh pair for exactly that reason (§3).

### `POST /api/auth/signup`

No credential required. Rate limited to 20/min.

```json
{
  "email": "owner@acme.com",
  "password": "at-least-8-chars",
  "firstName": "Ada",
  "lastName": "Lovelace"
}
```

**201**

```json
{
  "success": true,
  "message": "Account created successfully",
  "user": {
    "id": "9f1c…",
    "email": "owner@acme.com",
    "firstName": "Ada",
    "lastName": "Lovelace",
    "tenantId": null,
    "role": "owner",
    "isActive": true,
    "lastLoginAt": null,
    "createdAt": "2026-09-01T10:00:00.000Z",
    "updatedAt": "2026-09-01T10:00:00.000Z"
  },
  "accessToken": "eyJhbGciOi…",
  "refreshToken": "eyJhbGciOi…"
}
```

`user` is the whole row minus `password`. Do not assume the key set is closed —
treat it as "at least these fields".

| Status | When |
|---|---|
| 400 | a field is missing, or the password is under 8 characters |
| 409 | that email already has an account |
| 429 | more than `RATE_LIMIT_AUTH_MAX` attempts in a minute |

A new account has **no workspace**. Its access token has `tenantId: null`, so every
`/api/tenants/:tenantId/*` call returns `403 TENANT_REQUIRED` until §3 runs.

### `POST /api/auth/login`

```json
{ "email": "owner@acme.com", "password": "…" }
```

**200** — same shape as signup, with `message: "Login successful"`.

| Status | When |
|---|---|
| 400 | email or password missing |
| 401 | wrong credentials, **or** the account is deactivated — deliberately the same message either way |
| 429 | rate limited |

### `POST /api/auth/refresh`

```json
{ "refreshToken": "eyJhbGciOi…" }
```

**200**

```json
{ "success": true, "accessToken": "eyJhbGciOi…", "refreshToken": "eyJhbGciOi…" }
```

Both tokens are replaced. The old refresh token is **not** blacklisted, so it stays
usable until it expires — store the new one and drop the old.

| Status | When |
|---|---|
| 400 | `refreshToken` missing from the body |
| 401 | expired, malformed, wrong `type`, or the user is gone/inactive |

The client contract: on any `401` with `code: "TOKEN_EXPIRED"`, refresh once and
replay the original request. On a `401` from `/refresh` itself, the session is over
— clear storage and route to login. Guard against a refresh storm by ensuring only
one refresh is in flight at a time:

```js
let refreshing = null

const refresh = () => {
  refreshing ??= doRefresh().finally(() => { refreshing = null })
  return refreshing
}
```

### `POST /api/auth/logout`

Requires `Authorization: Bearer <access>`. Body is optional:

```json
{ "refreshToken": "eyJhbGciOi…" }
```

**200** `{ "success": true, "message": "Logged out successfully" }`

Both tokens' `jti` values are added to a Redis blacklist for their remaining
lifetime. Two things follow:

- **Send the refresh token.** Omit it and it stays valid for up to 7 days.
- **Logout is best-effort.** If Redis is down the blacklist write is skipped, the
  endpoint still returns 200, and the access token keeps working until it expires.
  Clear client state regardless — never treat a failed logout as "still logged in".

### `GET /api/auth/me`

Requires a bearer token.

**200**

```json
{
  "success": true,
  "user": {
    "id": "9f1c…",
    "email": "owner@acme.com",
    "firstName": "Ada",
    "lastName": "Lovelace",
    "tenantId": "3a7d…",
    "role": "owner",
    "isActive": true,
    "tenant": { "id": "3a7d…", "name": "Acme Docs", "slug": "acme-docs" }
  }
}
```

`tenant` is `null` when the user has no workspace yet. Use this endpoint on app boot
to decide between the dashboard and the create-workspace screen — it is the
authoritative answer, whereas the `tenantId` in your stored JWT may be stale.

| Status | When |
|---|---|
| 401 | missing/invalid/expired token, or `code: "TOKEN_REVOKED"` after logout |
| 404 | the token is valid but the user row is gone |

---

## 3. Owner API — workspaces

A **workspace** (tenant) owns documents, API keys and the widget configuration. One
user, one workspace.

### `POST /api/tenants`

Requires a bearer token.

```json
{ "name": "Acme Docs", "slug": "acme-docs" }
```

| Field | Rules |
|---|---|
| `name` | required, 2–100 characters |
| `slug` | required, 2–60 characters, `^[a-z0-9]+(?:-[a-z0-9]+)*$`, globally unique |

**201**

```json
{
  "success": true,
  "message": "Workspace created successfully",
  "tenant": { "id": "3a7d…", "name": "Acme Docs", "slug": "acme-docs", "ownerId": "9f1c…", "widgetConfig": {}, "createdAt": "…", "updatedAt": "…" },
  "accessToken": "eyJhbGciOi…",
  "refreshToken": "eyJhbGciOi…"
}
```

**Replace both stored tokens with these.** This is not optional. `tenantId` is a JWT
claim, the token you authenticated this call with has `tenantId: null`, and every
subsequent `/api/tenants/:tenantId/*` request would fail `403 TENANT_REQUIRED` if you
kept using it. A client that ignores these two fields appears to create the workspace
successfully and then finds the whole dashboard broken until the user logs out and
back in.

| Status | When |
|---|---|
| 400 | missing field, or a slug that is not lowercase-hyphenated |
| 401 | no valid bearer token |
| 404 | the authenticated user no longer exists |
| 409 | that slug is taken, or this user already has a workspace |

### `GET /api/tenants/me`

Requires a bearer token. Looked up by `ownerId`, not by the token's `tenantId`.

**200** `{ "success": true, "tenant": { … } }` — same tenant shape as above.

**404** `{ "success": false, "error": "No workspace found. Please create one first." }`

Treat the 404 as a routing signal, not an error to surface: it means "show the
create-workspace screen".

---

## 4. Owner API — documents

Base: `/api/tenants/:tenantId/documents`. Bearer token required, and `:tenantId` must
equal the token's own `tenantId` or you get `403 TENANT_MISMATCH`.

Only **PDF** is accepted. Documents are what the widget answers from; a workspace with
no `COMPLETED` document will answer every question with the no-results message.

### `POST /api/tenants/:tenantId/documents`

`multipart/form-data`, one field named `file`. Rate limited to 10/min.

```bash
curl -X POST http://localhost:4500/api/tenants/$TENANT/documents \
  -H "Authorization: Bearer $JWT" \
  -F "file=@handbook.pdf"
```

**202 — accepted, processing queued**

```json
{
  "success": true,
  "message": "Upload accepted. Processing has been queued.",
  "documentId": "c41f…",
  "filename": "handbook.pdf",
  "status": "PENDING",
  "statusUrl": "/api/tenants/3a7d…/documents/c41f…",
  "queuePosition": 1
}
```

**200 — the same bytes were already uploaded**

```json
{ "success": true, "duplicate": true, "message": "This file has already been uploaded.", "document": { … } }
```

Two success codes for one endpoint, and they mean different things. **Branch on
`response.status`, not on `success`.** 202 means start polling; 200 means the document
already exists and may already be `COMPLETED`. Deduplication is by SHA-256 of the
file content, so a renamed copy of the same PDF is a duplicate, and two different PDFs
with the same filename are not.

| Status | When |
|---|---|
| 400 | no file in the request, or a multer error |
| 413 | over `UPLOAD_MAX_BYTES` (10 mb default) — **shape A**, not shape B, with a message naming the limit |
| 415 | not `application/pdf` |
| 503 | `code: "INGESTION_BUSY"` — the queue is full; retry in a few minutes |

### `GET /api/tenants/:tenantId/documents/:documentId`

The polling endpoint for that 202.

```json
{
  "success": true,
  "document": {
    "id": "c41f…",
    "filename": "handbook.pdf",
    "mimeType": "application/pdf",
    "fileSize": 284133,
    "totalChunks": 96,
    "numPages": 41,
    "status": "COMPLETED",
    "failureReason": null,
    "processingStartedAt": "…",
    "processingCompletedAt": "…",
    "createdAt": "…"
  },
  "processing": false
}
```

`status` is one of `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`. **Poll while
`processing` is `true`** — the server computes it, so you do not have to enumerate the
states yourself. A long PDF can take minutes; poll every 2–3 seconds, back off, and cap
the total wait. On `FAILED`, `failureReason` is the string to show.

| Status | When |
|---|---|
| 400 | `:documentId` is not a UUID |
| 404 | no such document **in this workspace** |

### `GET /api/tenants/:tenantId/documents`

**200** `{ "success": true, "documents": [ … ] }` — newest first, same per-document
fields as above. No pagination; the whole list comes back.

### `DELETE /api/tenants/:tenantId/documents/:documentId`

**200**

```json
{ "success": true, "message": "Document deleted", "documentId": "c41f…", "vectorsDeleted": 96, "chunksDeleted": 96 }
```

| Status | When |
|---|---|
| 400 | `:documentId` is not a UUID |
| 404 | not found in this workspace |
| 409 | `code: "DOCUMENT_BUSY"` — still `PENDING`/`PROCESSING`; also returns `status` |
| 503 | the vector store is unreachable, so nothing was deleted |

The 409 is the one to design for: disable the delete button while `processing` is
true, and if the user gets there anyway, show "still processing" rather than a generic
failure.

---

## 5. Owner API — dashboard chat

### `POST /api/tenants/:tenantId/query`

The owner's own chat, for testing the corpus from the dashboard. Bearer token, rate
limited to 20/min, and it runs the same retrieval pipeline as the public widget — but
with **no redaction**: full snippets, internal `documentId`s and relevance scores all
come back.

```json
{
  "query": "What is the refund window?",
  "stream": false,
  "topK": 6,
  "documentIds": ["c41f…"],
  "history": [
    { "role": "user", "content": "Do you sell in the EU?" },
    { "role": "assistant", "content": "Yes — see [1]." }
  ]
}
```

| Field | Limit | On violation |
|---|---|---|
| `query` | required, ≤ 2000 chars | **400** |
| `stream` | `true` sends SSE instead of JSON | — |
| `topK` | integer, 1–20 (`RETRIEVAL_MAX_FINAL_TOP_K`) | silently ignored |
| `documentIds` | ≤ 50 UUIDs | **400** if any entry is not a UUID, or over 50 |
| `history` | last 6 turns kept, each truncated to 2000 chars | silently trimmed |

Note the deliberate asymmetry with the public route: here a bad `documentIds` is a
**400**, because the caller is a developer who should see their mistake. On the public
route it is silently dropped, because the caller is a visitor's browser.

**200** (non-streaming)

```json
{
  "success": true,
  "answer": "The refund window is 30 days [1].",
  "sources": [
    {
      "citation": 1,
      "documentId": "c41f…",
      "filename": "handbook.pdf",
      "chunkIndex": 12,
      "page": 4,
      "breadcrumb": "Returns › Refunds",
      "relevanceScore": 0.82,
      "scoreType": "rerank",
      "snippet": "Customers may return any item within 30 days…"
    }
  ],
  "citedSources": [1],
  "query": "What is the refund window?",
  "searchQuery": "refund window return period",
  "rewritten": true,
  "chunksUsed": 4,
  "retrieval": { "stage": "hybrid+rerank", "stats": { "elapsedMs": 1840 } },
  "cached": false
}
```

`citedSources` is the set of `citation` numbers the answer actually referenced —
useful for greying out sources the model ignored. `rewritten` tells you the question
was reformulated before retrieval, and `searchQuery` is what was actually searched.

**Fields that are conditionally absent.** Do not destructure these without a default:

| Field | Absent when |
|---|---|
| `cached` | any cache miss — it is only ever `true`, never `false` |
| `citedSources` | nothing was retrieved, or the model emitted the refusal sentinel |
| `searchQuery`, `rewritten` | a cached answer is returned (they are inside the cached object, so in practice present — but not guaranteed) |
| `retrieval` | a cached answer is returned |

An answer is cached (1 h, `CACHE_ANSWER_TTL`) only when `history` is empty — the same
words mean different things mid-thread. The cache key includes the workspace's corpus
version, so uploading or deleting a document invalidates every stale answer at once.

**Two "no answer" outcomes, both HTTP 200.** Neither is an error and both must render
as a normal assistant message:

1. Retrieval found nothing → `sources: []`, `chunksUsed: 0`.
2. Retrieval found chunks but the model judged them insufficient → `sources: []`,
   `chunksUsed: 4`.

In both, `answer` is the literal string:

> `I could not find any relevant information in the uploaded documents to answer your question.`

---

## 6. Owner API — API keys

Base: `/api/tenants/:tenantId/api-keys`. Bearer token, and `:tenantId` must equal the
token's own `tenantId`.

This is the section your dashboard's "Developers" screen is built from. The key is what
the widget authenticates with, and everything governing how much it may do lives on the
key row rather than in the widget's code — which is the point, because the widget's code
is published.

`:keyId` is **not** format-validated. A non-UUID id reaches Postgres as a bad cast and
comes back as a **500**, not a 400 or 404. Validate the id client-side.

### The key object

Every endpoint here returns keys in this exact shape. The hash never appears, and
neither does the plaintext:

```json
{
  "id": "7b2e…",
  "name": "acme.com production widget",
  "type": "public",
  "maskedKey": "pk_live_a1b2c3••••••••Z9x8",
  "keyPrefix": "pk_live_a1b2c3",
  "scopes": ["chat:query", "chat:config"],
  "allowedOrigins": ["https://acme.com", "https://www.acme.com"],
  "unrestricted": false,
  "rateLimitPerMinute": null,
  "dailyQuota": null,
  "lastUsedAt": "2026-09-01T11:04:22.000Z",
  "totalRequests": 1841,
  "expiresAt": null,
  "revokedAt": null,
  "status": "active",
  "createdAt": "2026-08-20T09:12:00.000Z"
}
```

Three fields need explaining:

- **`unrestricted`** is `allowedOrigins.length === 0`, and it means the key works from
  anywhere — including `curl`. Warn next to it in the UI.
- **`rateLimitPerMinute` and `dailyQuota` are `null` by default**, and `null` means
  "follow the deployment default", not "unlimited". The effective numbers come back
  from `GET /` under `defaults`, or per key from `GET /:keyId/usage`.
- **`status`** is derived from the clock on read: `active`, `revoked` or `expired`.

### `POST /api/tenants/:tenantId/api-keys`

Mints a key.

```json
{
  "name": "acme.com production widget",
  "type": "public",
  "scopes": ["chat:query", "chat:config"],
  "allowedOrigins": ["https://acme.com", "https://www.acme.com"],
  "rateLimitPerMinute": 60,
  "dailyQuota": 2000
}
```

| Field | Rules | Default |
|---|---|---|
| `name` | required, non-empty, ≤ 80 chars after trim | — |
| `type` | `"public"` or `"secret"` | `"public"` |
| `scopes` | array, every entry from §10; a **public** key may hold only `chat:query`, `chat:config`, `chat:filter` | public → `["chat:query","chat:config"]`, secret → those three plus `documents:read` |
| `allowedOrigins` | array, ≤ 20 entries (`PUBLIC_MAX_ORIGINS_PER_KEY`), each `http(s)://host[:port]` with no path | `[]` — unrestricted |
| `rateLimitPerMinute` | integer 1–6000 | `null` → 30 (`PUBLIC_RATE_PER_MINUTE`) |
| `dailyQuota` | integer 1–1 000 000 | `null` → 500 (`PUBLIC_DAILY_QUOTA`) |

**201**

```json
{
  "success": true,
  "key": "pk_live_a1b2c3d4e5f6…Z9x8",
  "warning": "This is the only time the key is shown. Store it now — it cannot be retrieved later, only rotated.",
  "apiKey": { "…": "the key object above" }
}
```

`key` appears in this response and in **no other**, ever. Only its SHA-256 is stored, so
it is unrecoverable by the owner and by an operator with database access alike. Render it
once, next to a copy button, and make the warning visible — a UI that shows it in a
toast that auto-dismisses will generate support tickets.

| Status | When |
|---|---|
| 400 | any rule in the table above, or an unknown scope named in the message |
| 400 `ORIGINS_REQUIRED` | `PUBLIC_KEY_REQUIRE_ORIGINS=true` and a public key was requested with no origins |
| 403 `TENANT_REQUIRED` / `TENANT_MISMATCH` | token has no workspace, or `:tenantId` is not the caller's |
| 409 `KEY_LIMIT_REACHED` | 25 live keys already (`PUBLIC_MAX_KEYS_PER_TENANT`) — revoke one first |

Asking for a document scope on a public key is a 400 with a message that explains
itself, and it is not a bug to work around:

> `A public key cannot hold documents:read. Public keys are readable by anyone who loads the page they ship on.`

If you need document access, mint a **separate** `secret` key and keep it on your own
server. Never put an `sk_live_` key in browser code.

### `GET /api/tenants/:tenantId/api-keys`

**200**

```json
{
  "success": true,
  "apiKeys": [ { "…": "key object" } ],
  "scopes": ["chat:query", "chat:config", "chat:filter", "documents:read", "documents:write"],
  "defaults": {
    "ratePerMinute": 30,
    "visitorRatePerMinute": 10,
    "dailyQuota": 500,
    "maxKeysPerTenant": 25,
    "originsRequired": false
  }
}
```

Live keys first, then revoked ones, each group newest first. Build the create form from
`scopes` and `defaults` rather than hardcoding them — they are deployment configuration
and will differ between environments. `originsRequired` tells you whether to mark the
origins field required.

### `GET /api/tenants/:tenantId/api-keys/:keyId/usage`

**200**

```json
{
  "success": true,
  "usage": {
    "…": "every field of the key object, plus:",
    "todayUsed": 128,
    "dailyQuotaEffective": 500,
    "rateLimitEffective": 30
  }
}
```

The two `…Effective` fields resolve `null` against the deployment default, so this is
what you render as "128 of 500 used today" without doing the fallback yourself.

**`todayUsed` can be `null`** — that is Redis being unreachable, not a key with no
traffic. Render "unknown", never "0". A separate endpoint from the list because it costs
a Redis round trip per key, and a table of 25 keys should not cost 25.

The day is a **UTC** calendar day, so `todayUsed` resets at 00:00 UTC and not at the
owner's local midnight. Label it accordingly or an owner in UTC+10 will report a bug.

### `PATCH /api/tenants/:tenantId/api-keys/:keyId`

Partial update. Send only what changed.

```json
{ "allowedOrigins": ["https://acme.com", "https://*.acme.com"], "dailyQuota": 5000 }
```

| Mutable | Same rules as `POST` |
|---|---|
| `name`, `scopes`, `allowedOrigins`, `rateLimitPerMinute`, `dailyQuota` | yes |

**`type` is immutable.** A public key cannot be promoted to a secret one, because its
plaintext may already be sitting in a published bundle. Sending `type` does not error —
it is simply ignored, and if it was the *only* field you sent you get
`400 No supported fields to update`.

**200** `{ "success": true, "apiKey": { … } }`

| Status | When |
|---|---|
| 400 | a validation rule, or no recognised field in the body |
| 404 | no such key **in this workspace** |
| 409 | the key is revoked — revoked keys cannot be edited, only replaced |

A scope or origin change invalidates the resolved-key cache immediately, so it takes
effect on the next request. If that Redis `DEL` fails the server logs
`[API KEY] cache invalidation failed` and the change lands within
`PUBLIC_KEY_CACHE_TTL` (300 s) instead. Do not promise the owner it is instant.

### `POST /api/tenants/:tenantId/api-keys/:keyId/rotate`

Issues a replacement and puts the old key on a grace timer, so a site can be redeployed
without a window in which its chat is broken.

```json
{ "graceHours": 24 }
```

| Field | Rules |
|---|---|
| `graceHours` | number 0–720; omit for the deployment default of 24 (`PUBLIC_ROTATION_GRACE_HOURS`) |

**201**

```json
{
  "success": true,
  "key": "pk_live_9z8y7x…Q1w2",
  "warning": "This is the only time the new key is shown. Deploy it before the old key expires.",
  "apiKey": { "…": "the new key" },
  "previous": { "…": "the old key, now with expiresAt or revokedAt set" }
}
```

The replacement is a **new row with a new id**, not a new secret on the same row. It
inherits `name`, `type`, `scopes`, `allowedOrigins`, `rateLimitPerMinute` and
`dailyQuota`, and starts with empty counters and `totalRequests: 0`. The link between
them survives as `rotatedFromId`, so the old row stays a usable audit record.

`graceHours: 0` revokes the old key **immediately** — right for a suspected leak, wrong
for routine hygiene. With any other value the old key keeps working until
`previous.expiresAt`, then starts returning `401 API_KEY_EXPIRED`.

Two consequences worth designing for:

- **The grace window is a deadline, not a safety net.** Nothing reminds you. Show
  `previous.expiresAt` prominently and treat a rotation as an open task until the new
  key is deployed.
- **Rotation does not check the 25-key cap.** Rotating while at the limit leaves you
  with 26 live keys, and the next `POST` fails with `KEY_LIMIT_REACHED` until the old
  one expires or is revoked.

| Status | When |
|---|---|
| 400 | `graceHours` outside 0–720 |
| 404 | no such key in this workspace |
| 409 | the key is already revoked — create a new one instead |

### `DELETE /api/tenants/:tenantId/api-keys/:keyId`

**200** `{ "success": true, "apiKey": { "…": "status is now revoked" } }`

Soft delete: the row survives as a record of what was issued and when it was withdrawn,
and the id keeps resolving in `GET /`. **Idempotent** — deleting an already-revoked key
returns 200 with the same row, so a double-click is harmless.

The cache entry is dropped, so the key stops working on the next request rather than at
the end of the TTL — subject to the same `[API KEY] cache invalidation failed` caveat as
`PATCH`.

| Status | When |
|---|---|
| 404 | no such key in this workspace |

There is no hard delete, and no endpoint that returns a plaintext key. If a key is lost,
rotate it.

---

## 7. Owner API — widget configuration

Base: `/api/tenants/:tenantId/widget`. Bearer token, `:tenantId` must be the caller's.

One JSONB blob per workspace holding how the widget looks and how much of a source an
anonymous visitor is allowed to see. The widget reads the resolved version of this from
`GET /api/public/config`, so everything here is **published to the visitor's browser** —
do not put anything internal in `footerNote`.

### `GET /api/tenants/:tenantId/widget`

**200**

```json
{
  "success": true,
  "widget": {
    "title": "Ask us anything",
    "greeting": "Hi! Ask me anything about this site and I will answer from our documentation.",
    "placeholder": "Type your question…",
    "suggestions": [],
    "accentColor": "#2563eb",
    "position": "right",
    "showBranding": true,
    "footerNote": "",
    "sourceMode": "labels"
  },
  "defaults": { "…": "the same nine keys, at their factory values" },
  "sourceModes": ["full", "labels", "hidden"]
}
```

`widget` is always complete — stored values merged over the defaults — so you never have
to fall back yourself. `defaults` is there so the settings form can show a "reset"
affordance and mark which fields the owner has actually customised.

Defaults are applied **on read, not on write**. Only the keys the owner has changed are
stored, which means raising a default (or adding a setting) takes effect for every
workspace that never touched it, instead of leaving a fleet of rows frozen at whatever
the defaults were the day they were created.

### `PUT /api/tenants/:tenantId/widget`

**Partial update, merged over what is stored.** A form that posts one field does not
reset the other eight.

```json
{ "title": "Acme Support", "accentColor": "#ff6600", "sourceMode": "labels" }
```

| Field | Type | Bound |
|---|---|---|
| `title` | string | ≤ 60 chars after trim |
| `greeting` | string | ≤ 300 |
| `placeholder` | string | ≤ 80 |
| `footerNote` | string | ≤ 120 |
| `suggestions` | string array | ≤ 6 entries, each ≤ 120 chars; empty strings are dropped |
| `accentColor` | string | `#rgb` or `#rrggbb`, stored lowercased |
| `position` | string | `"left"` or `"right"` |
| `showBranding` | boolean | must be a real boolean, not `"true"` |
| `sourceMode` | string | `"full"`, `"labels"` or `"hidden"` |

**200** `{ "success": true, "widget": { "…": "the resolved config after the merge" } }`

Every string is trimmed before storage, so `"  "` becomes `""` — for `title` that means
the widget falls back to nothing rather than to the default, because `""` is a stored
value. Send the field omitted, not blank, if you want the default back.

| Status | When |
|---|---|
| 400 | any bound above, a non-object body, or no recognised setting in it |
| 404 | the workspace row is gone |

**These 400s carry no `code`** — only `{ success: false, error: "…" }` with the message
naming the offending field. Show the message; do not switch on it.

**Last write wins.** Two browser tabs on the settings page will clobber each other's
changes with no conflict signal. These are single-owner presentation settings, so a
version column and a conflict dialog would cost more than the problem — but if your
dashboard supports multiple sessions, re-`GET` after a save rather than trusting local
state.

### `sourceMode` is a privacy control, not a display preference

It decides what `POST /api/public/chat` returns in `sources[]`, and it is enforced
server-side. The widget cannot override it.

| Mode | Visitor sees | Use when |
|---|---|---|
| `full` | `documentId`, `chunkIndex`, `breadcrumb`, `relevanceScore`, `scoreType` and a 240-char `snippet` | the corpus is already public |
| `labels` (default) | `citation`, `filename`, `page` only | almost always |
| `hidden` | `sources: []` — always empty, whatever was retrieved | filenames themselves are sensitive |

`full` on a public widget leaks internal filenames and lets a determined caller walk your
corpus out 240 characters at a time. Choose it deliberately.

Under `hidden`, `citedSources` may still contain numbers pointing at sources that were
not returned. Render citation markers only for entries present in `sources`.

---

## 8. Public API — the widget surface

Base: `/api/public`. Credential: `X-Api-Key: pk_live_…`. **No user authentication**, by
design — anyone who loads the customer's page can chat.

Two endpoints, and that is the whole public surface. There is no way from here to list
documents, read a workspace, mint a key, or discover another tenant. `tenantId` is never
accepted from the request; it is read off the key's database row.

Send the key as `X-Api-Key`. `Authorization: Bearer pk_live_…` also works, and a query
parameter does **not** — deliberately, because query strings land in access logs, browser
history and the `Referer` header of every outbound link on the page.

### The middleware chain

Both routes run the same gates in the same order, and the order is the security story:

```
apiKeyAuth      → 401  is this a real, live key?
originGuard     → 403  did the request come from a site the owner listed?
requireScope    → 403  is this key allowed to do this?
enforceQuota    → 429 / 503  has it got budget left?
promptGuardrails→ 400  (chat only) is the question trying to break the grounding?
```

Quota is spent **before** the guardrail check, on purpose: a limiter that refunds
rejected requests rewards hammering it, and the guardrail is the cheapest thing in the
chain to hammer. A question rejected as prompt injection still costs a message.

### `GET /api/public/config`

Everything the widget needs to render itself before the first message. Call it once per
page load, on mount, before showing the launcher.

Requires scope `chat:config`. Consumes a per-minute rate slot but **not** a daily quota
message — it is hit on pages nobody ever chats on.

```bash
curl http://localhost:4500/api/public/config \
  -H "X-Api-Key: pk_live_…" \
  -H "Origin: https://acme.com"
```

**200**

```json
{
  "success": true,
  "workspace": { "name": "Acme Docs" },
  "widget": {
    "title": "Ask us anything",
    "greeting": "Hi! Ask me anything…",
    "placeholder": "Type your question…",
    "suggestions": ["What is your refund policy?"],
    "accentColor": "#2563eb",
    "position": "right",
    "showBranding": true,
    "footerNote": "",
    "sourceMode": "labels"
  },
  "limits": { "maxQueryLength": 1000, "maxHistoryTurns": 6 },
  "capabilities": { "filterByDocument": false }
}
```

`workspace.name` is the only workspace field exposed — no id, no slug.

Three things to actually use rather than ignore:

- **`limits.maxQueryLength`** — wire it to the textarea's `maxlength`. The server's cap
  is `PUBLIC_MAX_QUERY_LENGTH` (1000 by default) and it is **not** the same as the
  dashboard's 2000. Enforcing it client-side turns a 400 into a character counter.
- **`limits.maxHistoryTurns`** — how many turns the server will actually keep (6). Send
  more and the oldest are dropped silently, so trim locally and keep your UI honest
  about what the model can see.
- **`capabilities.filterByDocument`** — whether this key holds `chat:filter`. When
  `false`, a `documentIds` array is **silently ignored**, not rejected. Without this flag
  "the filter did nothing" and "the key cannot filter" are indistinguishable.

| Status | When |
|---|---|
| 401 | `API_KEY_MISSING`, `API_KEY_INVALID`, `API_KEY_REVOKED`, `API_KEY_EXPIRED` |
| 403 | `ORIGIN_REQUIRED`, `ORIGIN_NOT_ALLOWED`, `SCOPE_FORBIDDEN` (needs `chat:config`) |
| 404 | `WORKSPACE_UNAVAILABLE` — the key resolved but its workspace is gone |
| 429 | `RATE_LIMITED` |
| 503 | `QUOTA_UNAVAILABLE` — the quota store is unreachable and the gate fails closed |

A failure here means the widget cannot be trusted to render. Fail quietly: log it, do
not mount the launcher, and never show a visitor on someone else's website a stack of
API errors.

### `POST /api/public/chat`

One message. Requires scope `chat:query`. Consumes a rate slot, a visitor-IP slot **and**
a daily quota message.

```json
{
  "query": "What is the refund window?",
  "stream": false,
  "sessionId": "v-8f3a1c9e",
  "topK": 6,
  "history": [
    { "role": "user", "content": "Do you ship to the EU?" },
    { "role": "assistant", "content": "Yes — see [1]." }
  ],
  "documentIds": ["c41f…"]
}
```

`query` is the only required field.

| Field | Handling | On violation |
|---|---|---|
| `query` | required, non-empty after trim, ≤ 1000 chars (`limits.maxQueryLength`) | **400** `QUERY_REQUIRED` / `QUERY_TOO_LONG` |
| `stream` | `true` (strictly the boolean) switches to SSE | anything else is treated as `false` |
| `sessionId` | analytics only, `^[A-Za-z0-9_-]{1,64}$` | **silently dropped** |
| `topK` | integer ≥ 1, **clamped** to 6 (`PUBLIC_MAX_TOP_K`) | silently clamped; non-integers ignored |
| `history` | last 6 turns; each trimmed to 1000 chars; oldest dropped until the total is ≤ 6000 chars; entries need `role` of `user`/`assistant` and a non-empty string `content` | **silently trimmed** |
| `documentIds` | UUIDs only, first 20 kept — and only if the key holds `chat:filter` | **silently ignored** |

Note the deliberate asymmetry with the dashboard route (§5): there, a malformed
`documentIds` is a 400 because the caller is a developer who should see the mistake; here
it is dropped, because the caller is a visitor's browser and a 400 they cannot act on is
worse than a slightly wider search.

`sessionId` is never a rate-limit bucket. A caller can rotate a client-generated id for
free, so bucketing on it would be a limiter that asks permission to be bypassed. Use it
only to correlate a conversation in the server logs.

The body limit on this router is **32 kb** (`PUBLIC_BODY_LIMIT`), far below the app's
1 mb. The parse happens before the key is known, so it is the one cost an
unauthenticated caller can impose — and growing `history` is what pushes a real widget
over it. Exceeding it returns **413 in error shape B** (§1), with no `code`.

#### Non-streaming response

**200**

```json
{
  "success": true,
  "answer": "The refund window is 30 days from delivery [1].",
  "sources": [
    { "citation": 1, "filename": "handbook.pdf", "page": 4 }
  ],
  "citedSources": [1],
  "chunksUsed": 4
}
```

Four fields, always all four. This is a much narrower shape than the dashboard's (§5) and
that is deliberate: no `documentId`, no `chunkIndex`, no `relevanceScore`, no `snippet`,
no `searchQuery`, no `rewritten`, no `retrieval`, no `cached`. The internal reformulation
of the question belongs to the workspace, not to a visitor on a third-party site.

`sources` is shaped by the workspace's `sourceMode` (§7): three fields under `labels`,
the full record under `full`, and always `[]` under `hidden`.

`citedSources` is the citation numbers the answer actually used. `chunksUsed` is how many
retrieved chunks reached the model — useful only for telling the two no-answer cases
apart.

**The "no answer" case is a 200.** Both of these are normal outcomes and neither is an
error:

| `sources` | `chunksUsed` | Meaning |
|---|---|---|
| `[]` | `0` | nothing in the corpus matched |
| `[]` | `> 0` | chunks matched but the model judged them insufficient |

In both, `answer` is exactly:

> `I could not find any relevant information in the uploaded documents to answer your question.`

Render it as an ordinary assistant message. Do not show an error state, do not retry, and
do not treat `sources: []` as a failure — a workspace with no `COMPLETED` document
answers every question this way.

#### Streaming response (`stream: true`)

Same URL, same gates, same quota cost. The response is `text/event-stream` with
`Cache-Control: no-cache`, `Connection: keep-alive` and `X-Accel-Buffering: no` (which
stops nginx holding every token until the answer is complete).

The rate-limit and quota headers set by `enforceQuota` survive onto the stream, so you can
read them from the `Response` object before consuming the body.

Three event types, in this order:

```
event: sources
data: {"sources":[{"citation":1,"filename":"handbook.pdf","page":4}],"chunksUsed":4}

event: chunk
data: {"content":"The refund window is "}

event: chunk
data: {"content":"30 days [1]."}

event: done
data: {"success":true}
```

| Event | Payload | Notes |
|---|---|---|
| `sources` | `{ sources, chunksUsed }` | always first, always exactly once, redacted per `sourceMode` |
| `chunk` | `{ content }` | zero or more; concatenate in order — there is no index |
| `done` | `{ success: true }` | the answer is complete |
| `error` | `{ error: "…" }` | generation failed; **no `code`, no `success`** |

The public `sources` event carries only `sources` and `chunksUsed`. The dashboard's also
carries `query`, `searchQuery` and `rewritten`; those are withheld here.

**`EventSource` cannot be used for this.** It only issues `GET` and cannot set headers, so
it can neither send the body nor the `X-Api-Key`. Use `fetch` and read
`response.body` as a stream:

```js
const response = await fetch(`${API}/api/public/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
  body: JSON.stringify({ query, stream: true, history })
  // no credentials: 'include' — see §1
})
```

Four things about the streaming contract that will bite a client written from the happy
path alone:

**1. The status code is decided before retrieval runs.** Headers go out first so that a
failure surfaces on an open stream. So a 200 means "the gates passed", not "the answer
worked" — a vector-store outage arrives as an `error` **event** inside a 200, and your
`response.ok` check will have already passed. Every 4xx/5xx in the table below still
arrives as a normal JSON body, because those all happen in middleware before the stream
opens. Branch on the content type:

```js
if (!response.ok) { /* JSON error body, shapes A/B in §1 */ }
else if (response.headers.get('content-type')?.includes('text/event-stream')) { /* read events */ }
```

**2. A refusal arrives as a `chunk`, not an `error`.** When the model judges the context
insufficient, the internal sentinel is swapped for the standard no-answer sentence and
sent as an ordinary `chunk` before `done`. Nothing partial precedes it — the decision is
made from the first couple of dozen characters, which are held back for exactly this
reason. The no-results case behaves identically: a `sources` event with `sources: []`,
then one `chunk` carrying that sentence, then `done`.

**3. The stream can end without `done`.** A dropped connection, a killed process or a
proxy timeout all end the body with no terminal event. Track whether `done` arrived and,
if it did not, mark the message incomplete rather than leaving a spinner running forever:

```js
let finished = false
// … on 'done': finished = true
// after the reader completes:
if (!finished) markIncomplete()
```

**4. An `error` event can arrive mid-answer.** By then you have already rendered text.
Keep what was streamed and append a failure note; discarding it looks like a bug to the
visitor, who watched the text appear.

A minimal parser — SSE frames are separated by a blank line, and a frame can be split
across chunks, so buffer:

```js
const reader = response.body.getReader()
const decoder = new TextDecoder()
let buffer = ''

while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })

  const frames = buffer.split('\n\n')
  buffer = frames.pop() ?? ''

  for (const frame of frames) handleFrame(frame)
}
```

```js
function handleFrame (frame) {
  let event = 'message'
  let data = ''

  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim()
    else if (line.startsWith('data: ')) data += line.slice(6)
  }

  if (!data) return

  let payload
  try { payload = JSON.parse(data) } catch { return }   // never throw on a bad frame

  if (event === 'sources') setSources(payload.sources)
  else if (event === 'chunk') appendText(payload.content)
  else if (event === 'done') finished = true
  else if (event === 'error') showStreamError(payload.error)
}
```

#### Status codes for `POST /api/public/chat`

| Status | `code` | Meaning and what the widget should do |
|---|---|---|
| 400 | `QUERY_REQUIRED` | empty question — a client-side guard should have caught it |
| 400 | `QUERY_TOO_LONG` | over `limits.maxQueryLength`; enforce it in the input instead |
| 400 | `PROMPT_INJECTION` | the question tried to override instructions or forged source markers |
| 400 | `INVALID_CHARACTERS` | control characters or bidi overrides in the text |
| 400 | `DEGENERATE_QUERY` | a run of 60+ identical characters |
| 401 | `API_KEY_MISSING` | no `X-Api-Key` header |
| 401 | `API_KEY_INVALID` | wrong format, or no such key |
| 401 | `API_KEY_REVOKED` | the owner revoked it — the widget is dead until redeployed |
| 401 | `API_KEY_EXPIRED` | rotation grace window closed; deploy the new key |
| 403 | `ORIGIN_REQUIRED` | the key is origin-restricted and the request carried no `Origin`/`Referer` |
| 403 | `ORIGIN_NOT_ALLOWED` | this site is not on the key's allowlist; the message names the origin |
| 403 | `SCOPE_FORBIDDEN` | the key lacks `chat:query` |
| 404 | `WORKSPACE_UNAVAILABLE` | the key resolved but its workspace is gone |
| 429 | `RATE_LIMITED` | per-key **or** per-visitor minute window; read `Retry-After` |
| 429 | `QUOTA_EXCEEDED` | daily quota spent; resets at **00:00 UTC** |
| 500 | `AUTH_UNAVAILABLE` | key resolution itself failed |
| 500 | `INTERNAL_ERROR` | unclassified failure answering the question |
| 503 | `QUOTA_UNAVAILABLE` | quota store unreachable, gate failed closed; `Retry-After: 30` |
| 503 | `SERVICE_UNAVAILABLE` | an upstream provider (embeddings, rerank, LLM, vector store) is down |
| 504 | `TIMEOUT` | generation took too long; suggest a shorter question |

Retry `503` and `504` with backoff. **Never** retry the 400s — the input will not become
valid on its own — and never retry a 401 or 403, which need an owner or a redeploy.

The three 503/504/500 messages deliberately do not name the failing provider. A visitor
cannot act on "Voyage is down", and the identity of the workspace's embedding vendor is
not something its owner agreed to publish on their website.

---

## 9. Response headers

The two APIs report their limits through **different** headers, and only one of the two
sets is readable from a browser. This trips up dashboards in particular.

### Public API (`/api/public/*`)

Set by `enforceQuota` on both endpoints:

| Header | Set when | Meaning |
|---|---|---|
| `RateLimit-Limit` | the key's per-minute limit is finite | messages per minute for this key |
| `RateLimit-Remaining` | as above | left in the current window |
| `RateLimit-Reset` | as above | **seconds** until the window resets, not a timestamp |
| `X-Quota-Limit` | `POST /chat` only, finite quota | messages per UTC day |
| `X-Quota-Remaining` | as above | left today |
| `Retry-After` | on a 429, and on the 503 `QUOTA_UNAVAILABLE` (always `30`) | seconds to wait |

All six are in the public router's `exposedHeaders`, so the widget can read them
cross-origin. That is the point: without it a widget has no way to back off except by
guessing.

Two behaviours to code around:

- **On a visitor-bucket 429 the `RateLimit-*` triple describes a different bucket than the
  one that rejected you.** The key's headers are written before the visitor bucket is
  consulted, so a visitor-limited 429 can carry `RateLimit-Remaining: 57` alongside its
  refusal — that 57 is the *key's* remaining allowance, and the key is not the thing that is
  over. Only `Retry-After` reflects the bucket that actually said no. On any 429, read
  `Retry-After`; never infer the wait from `RateLimit-Reset`.
- **Both 429 buckets use `code: "RATE_LIMITED"`.** You cannot tell "this whole site is
  busy" from "you personally are typing too fast" from the code — only from the message
  string, which differs ("This chat is receiving too many messages right now." versus
  "You are sending messages too quickly."). Show the message and honour `Retry-After`.

`X-Quota-*` are absent from `GET /config` entirely, because that endpoint does not spend a
daily message. Absent headers there are not an error.

If a key is configured with a non-positive limit, that tier is unlimited and its headers
are **omitted rather than set to a sentinel**. Treat a missing header as "no limit
reported", not as zero.

### Owner API (everything else)

`express-rate-limit` in `draft-7` mode, which is a different scheme entirely:

| Header | Value |
|---|---|
| `RateLimit` | `limit=300, remaining=287, reset=41` — one combined header |
| `RateLimit-Policy` | `300;w=60` |
| `Retry-After` | seconds, on a 429 only |

There are **no** `RateLimit-Limit` / `-Remaining` / `-Reset` headers here, and no
`X-Quota-*` at all.

**Your dashboard cannot read any of them.** The owner-API CORS configuration sets no
`exposedHeaders`, so a browser on a different origin from the API — which is the normal
deployment — sees only the CORS-safelisted response headers. `RateLimit`,
`RateLimit-Policy` and `Retry-After` are all invisible to `response.headers.get(…)`.

That is why the owner 429 body carries the wait in the payload instead:

```json
{
  "success": false,
  "error": "Too many requests. Please slow down.",
  "code": "RATE_LIMITED",
  "retryAfterSeconds": 60
}
```

`retryAfterSeconds` appears **only** on owner-API 429s. The public API does the opposite:
`Retry-After` header, no body field. A shared retry helper has to check both.

---

## 10. Scopes

A scope is a capability on the key. `requireScope` checks exactly one per route and
returns `403 SCOPE_FORBIDDEN` naming the missing one.

| Scope | Grants | Route |
|---|---|---|
| `chat:query` | ask a question | `POST /api/public/chat` |
| `chat:config` | read the widget configuration | `GET /api/public/config` |
| `chat:filter` | restrict retrieval to chosen `documentIds` | `POST /api/public/chat` |
| `documents:read` | reserved — no public route consumes it yet | — |
| `documents:write` | reserved — no public route consumes it yet | — |

| | `public` (`pk_live_`) | `secret` (`sk_live_`) |
|---|---|---|
| May hold | `chat:query`, `chat:config`, `chat:filter` **only** | any of the five |
| Default on create | `chat:query`, `chat:config` | `chat:query`, `chat:config`, `chat:filter`, `documents:read` |
| Origin allowlist | enforced | **exempt** — no browser, no `Origin` to check |
| Belongs in | browser code | your own server, never shipped to a client |

A widget needs `chat:query` and `chat:config`. Add `chat:filter` only if the site actually
scopes questions to particular documents — it lets whoever holds the key probe the corpus
document by document, which is a meaningful widening of what a lifted key can do.

`documents:read` and `documents:write` are accepted, stored and returned today but no
route consumes them; document access is JWT-only. Do not build a client against them.

---

## 11. Error code index

Every `code` the server emits, in one place. `code` appears in **error shape A** only
(§1) — shapes B and C have no `code` at all, so a client keyed purely on `code` will
mis-handle a 413 and a 404.

### Owner API

| Status | `code` | Do this |
|---|---|---|
| 401 | *(none)* | missing/malformed `Authorization`, an invalid signature, or the wrong token `type`. Three different failures, no code on any of them — treat a 401 without a code as "log in again" |
| 401 | `TOKEN_EXPIRED` | refresh once, replay the original request |
| 401 | `TOKEN_REVOKED` | the `jti` is blacklisted after logout — clear storage, route to login |
| 403 | `TENANT_REQUIRED` | the token has `tenantId: null` — send the user to create a workspace |
| 403 | `TENANT_MISMATCH` | `:tenantId` in the URL is not the token's. Usually a stale token after workspace creation (§3), not a permissions bug |
| 400 | `ORIGINS_REQUIRED` | `PUBLIC_KEY_REQUIRE_ORIGINS=true` and a public key was requested with no origins |
| 409 | `KEY_LIMIT_REACHED` | 25 live keys — revoke one |
| 409 | `DOCUMENT_BUSY` | still `PENDING`/`PROCESSING`; the body also carries `status` |
| 503 | `INGESTION_BUSY` | the ingestion queue is full — retry in a few minutes |
| 429 | `RATE_LIMITED` | body carries `retryAfterSeconds`; the header is not readable cross-origin (§9) |

The 400s from `PUT /widget`, and most 400/404/409s from the key routes, carry **no code**
— only a message naming the field. Display the message; do not parse it.

### Public API

| Status | `code` | Retry? | Do this |
|---|---|---|---|
| 400 | `QUERY_REQUIRED` | no | guard the empty input client-side |
| 400 | `QUERY_TOO_LONG` | no | enforce `limits.maxQueryLength` in the textarea |
| 400 | `PROMPT_INJECTION` | **never** | show the message, keep the conversation open |
| 400 | `INVALID_CHARACTERS` | **never** | ask the visitor to retype as plain text |
| 400 | `DEGENERATE_QUERY` | **never** | a 60+ character run of one character |
| 401 | `API_KEY_MISSING` | no | the header never got sent — a build/config bug |
| 401 | `API_KEY_INVALID` | no | wrong format or no such key; check for a truncated build variable |
| 401 | `API_KEY_REVOKED` | no | the owner revoked it; the widget stays dead until redeployed |
| 401 | `API_KEY_EXPIRED` | no | rotation grace window closed — deploy the new key |
| 403 | `ORIGIN_REQUIRED` | no | no `Origin` **or** `Referer`; see the `null`-origin case below |
| 403 | `ORIGIN_NOT_ALLOWED` | no | add this exact origin to the key's allowlist |
| 403 | `SCOPE_FORBIDDEN` | no | the key lacks `chat:query` or `chat:config` |
| 404 | `WORKSPACE_UNAVAILABLE` | no | the workspace is gone; hide the widget |
| 429 | `RATE_LIMITED` | after `Retry-After` | per-key or per-visitor minute window |
| 429 | `QUOTA_EXCEEDED` | not today | daily quota spent; resets at **00:00 UTC** |
| 500 | `AUTH_UNAVAILABLE` | yes, backoff | key resolution itself failed |
| 500 | `INTERNAL_ERROR` | once | unclassified failure |
| 503 | `QUOTA_UNAVAILABLE` | yes, after 30 s | Redis is unreachable and the gate fails closed |
| 503 | `SERVICE_UNAVAILABLE` | yes, backoff | an upstream provider is down |
| 504 | `TIMEOUT` | yes, once | suggest a shorter question |

### Codes you will never see over HTTP

These are internal and either get mapped to one of the above or surface somewhere other
than a `code` field. Do not branch on them:

| Code | Where it actually shows up |
|---|---|
| `NO_TEXT` | `document.failureReason` — a PDF with no extractable text, usually a scan |
| `EMBEDDING_INPUT_TOO_LARGE` | ingestion internals |
| `VECTOR_STORE_NOT_READY`, `EMBEDDING_NOT_CONFIGURED`, `RERANK_NOT_CONFIGURED`, `LLM_NOT_CONFIGURED` | mapped to `503 SERVICE_UNAVAILABLE` on the public route |
| `QUOTA_UNAVAILABLE` (thrown) | mapped to the `503 QUOTA_UNAVAILABLE` response |

### One helper for both APIs

The two APIs disagree about where the retry delay lives, and the error shapes disagree
about what `error` is. Both belong in one place:

```js
/** Normalises any response from either API into { ok, status, data, message, code, retryAfter }. */
async function call (url, init) {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => null)

  if (response.ok) return { ok: true, status: response.status, data }

  const { message, code } = normaliseError(response.status, data)   // §1

  return {
    ok: false,
    status: response.status,
    message,
    code,
    // public API: header. owner API: body, because the header is not exposed.
    retryAfter:
      Number(response.headers.get('Retry-After')) || data?.retryAfterSeconds || null
  }
}
```

---

Next: [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md) walks through mounting the widget on a
real site, with the edge cases each step has to survive.
