# API Keys & the Public Widget — Implementation Analysis

What this document is: a walkthrough of everything added for the embeddable
chatbot, why each piece is shaped the way it is, and what has and has not been
verified. The plan it implements is `API_KEY_PLAN.md`.

The feature in one sentence: **a workspace owner mints an API key, drops it into
their website's JavaScript, and anonymous visitors chat against their documents
with no login anywhere in the picture.**

---

## 1. The shape of the thing

Two credentials now exist in the system, and they are not interchangeable.

| | Dashboard JWT | Workspace API key |
|---|---|---|
| Identifies | a person | a workspace |
| Lives in | memory of a logged-in browser | the source of a public web page |
| Sent as | `Authorization: Bearer` | `X-Api-Key` |
| Reaches | `/api/auth`, `/api/tenants/*` | `/api/public/*` only |
| Can mint keys | yes | never |

A key embedded in a page is readable by anyone who opens devtools. There is no
version of this feature where that key stays secret, so nothing in the design
depends on its secrecy. It is treated the way Stripe treats a publishable key:
public by construction, and useful to an attacker only in proportion to what it
is *permitted* to do.

That is the whole security argument, and everything in §3 is a consequence of it.

## 2. One request, end to end

```text
POST /api/public/chat        X-Api-Key: pk_live_…
        │
        ├─ cors                 answers the preflight; no credentials, ever
        ├─ express.json(32kb)   the only cost an unauthenticated caller imposes
        │
        ├─ apiKeyAuth           regex → Redis cache → one indexed SELECT
        │                       → req.tenantId, from the row, never the request
        ├─ originGuard          is this key allowed on the site that asked?
        ├─ requireScope         does this key hold chat:query?
        ├─ enforceQuota         key/minute, visitor/minute, key/day — in Redis
        ├─ promptGuardrails     injection and abuse screening on the words
        │
        └─ handler              clamp the inputs, retrieve, generate,
                                redact the sources, stream or answer
```

Five gates before a paid provider is touched, ordered cheapest-first. A flood of
malformed keys costs a regex each. A flood of well-formed unissued keys costs a
Redis GET each. Nothing reaches Voyage, Pinecone or NVIDIA without a live key
that is inside its limits.

---

## 3. The key itself

### Minting — `src/services/apiKeyService.js`

```text
pk_live_Ea7yR2mQ…            43 base64url chars = 32 bytes from randomBytes
│  │    └─ secret
│  └─ environment marker
└─ pk = public (browser)   sk = secret (server-to-server)
```

Four things are stored, and the key is not one of them:

| Column | Value | Why |
|---|---|---|
| `keyHash` | `sha256(full key)`, unique index | the only thing that authenticates |
| `keyPrefix` | `pk_live_` + 6 chars | so a list can name a key; reveals 36 of 256 bits |
| `keyLast4` | last 4 chars | for the `pk_live_abc123••••••••xy9z` mask |
| `type` | `public` / `secret` | decides which scopes and guards apply |

**Why SHA-256 and not bcrypt.** Bcrypt exists to slow down dictionary attacks on
human-chosen passwords. This input is 256 bits of `crypto.randomBytes` — there is
no dictionary and nothing to slow down. What the fast hash buys is real: one
indexed equality per request instead of bcrypt-comparing every row in the table,
on a route that runs on every keystroke-triggered page load. GitHub and Stripe
verify tokens the same way.

**The plaintext is returned exactly once**, by `POST /api-keys` or
`POST /api-keys/:id/rotate`, and the response says so. It cannot be recovered
afterwards by the owner, by an operator with database access, or by me.

### Resolution and caching

`resolveApiKey(raw)` is the hot path:

```text
looksLikeApiKey(raw)          regex, no I/O — a garbage flood costs nothing
      ↓
Redis apikey:v1:<hash>        hit → done. miss → ↓
      ↓
SELECT … WHERE keyHash = ?    one indexed equality
      ↓
cache the answer              300s for a real key, 30s for a nonexistent one
```

Three details that matter more than they look:

- **Nonexistent keys are cached too** (the ` none` sentinel, 30s). Without it,
  invented keys convert directly into database lookups at whatever rate the
  attacker can send them.
- **Revoked and expired keys still resolve.** `apiKeyAuth` reads `keyStatus` and
  picks the error, so a dead key gets a fast, specific rejection
  (`API_KEY_REVOKED` / `API_KEY_EXPIRED`) instead of a database round trip per
  retry — and the widget can tell "rotate happened, update your snippet" from
  "this key never existed".
- **Status is computed against the clock on every request**, never baked into the
  cached record. A key cached one second before its grace window closes must not
  keep working for the remaining 299 seconds of the TTL. There is a test that
  busy-waits 60ms to prove exactly this.

Any change to a key (`PATCH`, revoke, rotate) calls `invalidateKeyCache`, so it
takes effect on the next request rather than at the end of the TTL. That failing
silently is the one path by which a revoked key keeps working, so it logs at
`error` level with the window during which the change may not have landed.

---

## 4. The five gates

The first is `apiKeyAuth`, which is §3 — resolving the string to a record is itself
the gate that establishes identity. The four below all run after it, and each one
can only be checked because the key has already been resolved. They are grouped here
by what they defend rather than in chain order; the chain order is the diagram in
§2, and it is `originGuard` → `requireScope` → `enforceQuota` → `promptGuardrails`.

### 4.1 Scopes — `requireScope`

| Scope | Grants | Public key may hold it |
|---|---|---|
| `chat:query` | ask a question | yes |
| `chat:config` | read the widget config | yes |
| `chat:filter` | aim retrieval at chosen documents | yes, opt-in |
| `documents:read` | list documents | **no** |
| `documents:write` | upload documents | **no** |

`normaliseScopes` refuses to attach a `documents:*` scope to a `public` key at
all, whatever the owner asks for — the owner is not the only person who will be
holding that key.

`chat:filter` is the interesting one. It exists so document filtering is a
property of the *key* rather than of the request: without it, `documentIds` in
the body is dropped, so a lifted widget key cannot be used to walk the corpus one
document at a time looking for what is in there. `GET /config` reports
`capabilities.filterByDocument` so a widget can tell "this key cannot filter"
from "my filter silently did nothing".

A failure here is **403 `SCOPE_FORBIDDEN`**, not 401. The key is valid; it is
just not permitted here. Conflating the two costs whoever is debugging the widget
an hour.

### 4.2 Origin allowlist — `src/middleware/originGuard.js`

Per key, a list like `["https://acme.com", "https://*.acme.com"]`. Empty list
means unrestricted; secret keys are exempt, because server-to-server traffic has
no `Origin` and no browser to protect.

Matching is on the normalised origin — scheme, host, non-default port — because
that is exactly the granularity the browser reports. The near-miss cases are the
ones worth stating, and each has a test:

| Candidate | Pattern | Result |
|---|---|---|
| `https://app.acme.com` | `https://*.acme.com` | allowed |
| `https://a.b.acme.com` | `https://*.acme.com` | allowed (any depth) |
| `https://acme.com` | `https://*.acme.com` | **refused** — list the apex explicitly |
| `https://evil-acme.com` | `https://*.acme.com` | **refused** |
| `https://acme.com.evil.io` | `https://*.acme.com` | **refused** |
| `http://acme.com` | `https://acme.com` | **refused** — scheme is identity |
| `https://acme.com:8443` | `https://acme.com` | **refused** — port is identity |
| anything | `garbage` (unparseable stored pattern) | **refused** — fails closed |

Patterns are validated when they are saved, not when they are matched:
`https://*.com` is rejected as too broad, as are paths, embedded credentials,
non-leftmost wildcards, and plain `http` anywhere but loopback.

**What this buys, stated honestly.** Browsers set `Origin` on cross-origin
requests and page JavaScript cannot forge it, so this stops someone lifting the
key and embedding your widget on their own site — the easy attack, and the one
that actually happens. It does *not* stop `curl`, which can send any `Origin` it
likes. The daily quota is what bounds a determined direct caller. Both layers are
load-bearing; neither is sufficient alone.

### 4.3 Rate limits and quota — `src/services/quotaService.js`, `enforceQuota`

Three buckets, because each stops something the others cannot:

| Bucket | Redis key | Default | Stops |
|---|---|---|---|
| key / minute | `q:rate:key:<id>` | 30 | one site outrunning its allowance |
| visitor / minute | `q:rate:key:<id>:ip:<ip>` | 10 | one visitor spending the whole site's allowance |
| key / UTC day | `q:day:<id>:<yyyymmdd>` | 500 | the hard cost ceiling — the only one a patient attacker cannot wait out |

Counting is a Lua `EVAL` so `INCR` and `EXPIRE` are one atomic step. As two
commands, concurrent callers can all observe `current > 1`, nobody sets the TTL,
and the counter never resets — a limiter that permanently locks the key out.

They are **fixed windows**, not sliding. A burst on a window boundary can briefly
reach twice the limit, which costs a handful of requests; a sliding window costs a
sorted set per key per window to prevent that, and the daily quota already caps
the total.

They live in **Redis, not process memory.** `express-rate-limit`'s default store
is per-process, so N instances allow N× the limit. That is tolerable for the
dashboard and not tolerable here, where the limit is the only thing between a
leaked key and an unbounded bill.

**Denied requests are counted.** A limiter that refunds rejections rewards
hammering it.

**Redis unreachable fails closed — 503 `QUOTA_UNAVAILABLE`.** Every request past
this point spends money at three paid providers, so "we could not check the quota"
must never be read as "this request is within quota". `consumeRate` and
`consumeDailyQuota` *throw* rather than return a flag, specifically so a caller
cannot accidentally treat the failure as a pass. The app already requires Redis to
boot, so this adds no dependency — only an explicit behaviour when that dependency
is degraded. A limit configured as `0` or negative means "switched off" and skips
Redis entirely, so disabling a tier does not still cost a round trip.

The bookkeeping counters take the opposite line and stay silent, because a lost
usage figure is cosmetic: `bumpTotalRequests` counts served requests in Redis, and
`touchApiKey` folds the total into `api_keys.totalRequests` and refreshes
`lastUsedAt` at most once a minute per key — a `SET NX` acting as a cross-process
throttle, so a busy widget costs one `UPDATE` per minute rather than one per
message. `peekDailyUsage` returns `null`, not `0`, when Redis is down: a dashboard
showing "0 of 500 used" during an outage is a lie an owner would act on.

The widget is told where it stands via `RateLimit-Limit` / `-Remaining` /
`-Reset`, `Retry-After` and `X-Quota-Limit` / `-Remaining`, all listed in
`exposedHeaders` — without that, cross-origin JavaScript cannot read them and has
no way to back off except guessing.

### 4.4 Prompt guardrails

The existing `promptGuardrails` middleware, unchanged, running last. It is the
cheapest thing in the chain to hammer, which is why the quota is spent *before* it
rather than after.

---

## 5. What a visitor may send

Everything on `POST /api/public/chat` is attacker-controlled, so it is clamped
rather than trusted (`src/api/publicChat.js`):

| Field | Treatment |
|---|---|
| `query` | required, trimmed, **400** past 1000 chars |
| `history` | roles filtered, last 6 turns only, each turn truncated to 1000 chars, then oldest turns dropped until the whole thing is under 6000 chars |
| `topK` | **clamped** to 6, not rejected |
| `documentIds` | UUID-shaped only, max 20, and **ignored entirely without `chat:filter`** |
| `sessionId` | analytics only; `[A-Za-z0-9_-]{1,64}` or dropped |
| `tenantId` | not accepted — it comes from the key's row |

Two of those deserve a note. The **history budget** is enforced in characters as
well as turns because "six turns" alone is not a bound: six turns of 100 kB each
is still a fortune in tokens, and the widget holds the conversation, so that array
is entirely the caller's. **`topK` is clamped rather than 400'd** because a widget
sending `topK: 50` is far more likely to be an over-eager integrator than an
attacker, and silently serving six good sources beats a 400 they have to debug
from inside a customer's site.

`sessionId` is never a rate-limit bucket. An attacker rotates a client-generated
id for free, so bucketing on it would be a limiter that asks permission to be
bypassed. Its character set is restricted because it is the one caller-controlled
string that reaches a log line, and a newline in it would let a visitor forge log
entries.

## 6. What a visitor may see

### Source redaction — `redactSources`

The internal source shape carries a 240-character `snippet` of raw chunk text, the
internal `documentId`, `chunkIndex`, `breadcrumb` and relevance scores. On a public
widget that leaks internal filenames and lets a caller reconstruct the corpus 240
characters at a time. So the owner picks a mode, per workspace:

| Mode | A visitor receives |
|---|---|
| `full` | everything the dashboard sees |
| `labels` | `citation`, `filename`, `page` — **the default** |
| `hidden` | `[]` |

An unrecognised mode falls back to redacting, not to disclosing. There is a test
asserting the exact key set in `labels` mode, so a field added to the internal
shape later cannot quietly ride along into a public response.

### The streamed answer — `src/rag/answerSse.js`

The SSE relay was extracted from `src/api/query.js` and is now shared by both
routes. The fragile part is not the HTTP plumbing but the answer contract enforced
on the way out: the `NOT_IN_CONTEXT` sentinel swapped for user-facing prose, and
citations pointing at sources that were never supplied stripped. Two copies of
that would drift, and the copy that drifted would be the public one.

`buildSourcesEvent` is the only seam. The public route uses it to redact the source
list and to drop `searchQuery` and `rewritten` — the internal reformulation of the
question, which belongs to the workspace and not to a visitor on someone else's
site. Events (`sources`, `chunk`, `done`, `error`) are unchanged, so the existing
dashboard client keeps working; `produce` is passed as a thunk precisely so
`writeHead` happens first and a retrieval failure still surfaces as an SSE `error`
on an open 200 stream rather than as an HTTP status the current client does not
expect.

### Errors are vendor-anonymous

`handlePublicError` maps any provider failure to **503 `SERVICE_UNAVAILABLE`**, a
timeout to **504 `TIMEOUT`**, and anything else to **500 `INTERNAL_ERROR`**. A
visitor cannot act on "Voyage is down", and which embedding vendor a workspace uses
is not something its owner agreed to publish on their website. The real cause is
logged server-side with the key prefix.

---

## 7. Mount order in `src/app.js` is part of the design

```js
app.use('/api/public', publicChatRoutes)   // ← first, deliberately
app.use(cors({ origin: config.allowedOrigins, … }))
app.use(express.json({ limit: '1mb' }))
app.use('/api', generalLimiter)
app.use('/api/tenants/:tenantId/api-keys', apiKeyRoutes)
app.use('/api/tenants/:tenantId/widget', widgetRoutes)
```

Three independent reasons the public router has to be above the rest:

1. **CORS.** The app's `cors()` is an allowlist of the dashboard's own origins,
   which is the opposite of what a widget needs — it is embedded on customer sites
   whose origins this server cannot enumerate in advance. The `cors` package
   answers every `OPTIONS` itself and, on a non-match, simply omits
   `Access-Control-Allow-Origin`; the browser then fails the request before the
   real check ever runs. Per-key origin enforcement *cannot* happen during a
   preflight anyway, because `OPTIONS` carries no custom headers and therefore no
   key. So the public router reflects the asking origin and `originGuard` — which
   runs after the key is resolved — is the actual boundary.
2. **Body limit.** 32kb here versus 1mb for the dashboard. This parse happens
   before the key is known, so it is the only cost an unauthenticated caller can
   impose; 1mb would make that cost 32× larger.
3. **The limiter.** `generalLimiter` keeps its counters in process memory, so N
   instances would allow N× the limit. Public traffic is bounded by the Redis
   counters in `enforceQuota` instead, which hold across processes.

There are tests that hold all three in place over a real HTTP server
(`src/tests/publicRoutes.test.js`), because this is exactly the kind of ordering a
later refactor breaks silently.

## 8. Lifecycle

```text
POST   /api-keys                 201 + plaintext (once) ─┐
PATCH  /api-keys/:id             scopes, origins, limits │ cache invalidated
DELETE /api-keys/:id             soft revoke, row kept   │ on every one of
POST   /api-keys/:id/rotate      new row + grace window ─┘ these
```

**Rotation** creates a *new row* rather than replacing the secret on the existing
one, and links them with `rotatedFromId`. The old key keeps working until
`expiresAt` (default 24h), so a widget can be redeployed without a window in which
the customer's chat is broken. `graceHours: 0` closes the old key immediately,
which is the right call for a suspected leak and the wrong one for routine
hygiene.

**Revocation** is soft. The row survives as a record of what was issued, to whom,
and when it was withdrawn — and because `keyHash` is unique, the same key can
never be re-issued.

Ownership is enforced structurally: `requireTenant` proves the `:tenantId` in the
URL is the caller's own, and every service function takes that tenant id as its
first argument, so a key id belonging to another workspace resolves to a 404
rather than to someone else's key.

---

## 9. Using it

Owner mints a key:

```bash
curl -X POST https://your-host/api/tenants/$TENANT/api-keys \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"name":"acme.com widget","type":"public",
       "allowedOrigins":["https://acme.com","https://*.acme.com"]}'
```

```json
{
  "success": true,
  "key": "pk_live_Ea7yR2mQ…",
  "warning": "This is the only time the key is shown. Store it now — it cannot be retrieved later, only rotated.",
  "apiKey": { "id": "…", "maskedKey": "pk_live_Ea7yR2••••••••mQ9z", "scopes": ["chat:query","chat:config"], "unrestricted": false, "status": "active" }
}
```

The customer's page then talks to two endpoints and needs nothing else:

```js
const KEY = 'pk_live_Ea7yR2mQ…'            // public by design

const config = await fetch('/api/public/config', {
  headers: { 'X-Api-Key': KEY }
}).then((r) => r.json())

const answer = await fetch('/api/public/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
  body: JSON.stringify({ query: 'What is the refund window?' })
}).then((r) => r.json())
```

`GET /config` returns the workspace name, the widget's appearance, the input
limits it should enforce client-side, and its capabilities. It consumes a
rate-limit slot but **not** a daily-quota message, because it is hit once per page
load including on pages nobody ever chats on.

### Error codes a widget should handle

| Status | Code | Meaning |
|---|---|---|
| 400 | `QUERY_REQUIRED` / `QUERY_TOO_LONG` | fix the input |
| 401 | `API_KEY_MISSING` / `_INVALID` / `_REVOKED` / `_EXPIRED` | the snippet needs a new key |
| 403 | `SCOPE_FORBIDDEN` | valid key, not permitted here |
| 403 | `ORIGIN_REQUIRED` / `ORIGIN_NOT_ALLOWED` | this site is not on the key's list |
| 404 | `WORKSPACE_UNAVAILABLE` | the workspace is gone |
| 413 | — | body over 32kb |
| 429 | `RATE_LIMITED` | back off; read `Retry-After` |
| 429 | `QUOTA_EXCEEDED` | done for the day |
| 503 | `QUOTA_UNAVAILABLE` | counter store down; failing closed |
| 503 | `SERVICE_UNAVAILABLE` | an upstream provider is down |
| 504 | `TIMEOUT` | too slow |

---

## 10. Files

### Added

| File | Role |
|---|---|
| `src/migrations/0003-api-keys.js` | `api_keys` table, its indexes, and `tenants.widgetConfig`. `IF NOT EXISTS` throughout, so re-applying is a no-op |
| `src/models/ApiKey.js` | the model, plus `toSafeJSON()` — deliberately *not* `toJSON`, so an accidental `res.json(apiKey)` is a visible mistake rather than a silent hash leak |
| `src/services/apiKeyService.js` | mint, resolve, cache, validate, update, revoke, rotate, usage |
| `src/services/quotaService.js` | the Redis counters and the fail-closed contract |
| `src/services/widgetService.js` | widget defaults, partial-update validation, `redactSources` |
| `src/middleware/apiKeyAuth.js` | `apiKeyAuth`, `requireScope`, `enforceQuota` |
| `src/middleware/originGuard.js` | pattern parsing, allowlist matching, the guard |
| `src/rag/answerSse.js` | the SSE relay both routes now share |
| `src/api/publicChat.js` | the public surface: `GET /config`, `POST /chat` |
| `src/api/apiKeys.js` | owner-facing key management |
| `src/api/widget.js` | owner-facing widget configuration |
| `.env.example` | every one of the 85 variables the code reads, with its default |

### Changed

| File | Change |
|---|---|
| `src/app.js` | public router mounted first, with the three reasons documented at the mount point |
| `src/config.js` | `publicApiConfig`, `API_KEY_SCOPES`, `WIDGET_SOURCE_MODES`, default scope sets |
| `src/models/Tenant.js` | added `widgetConfig`; marked the legacy `apiKey` column deprecated |
| `src/models/index.js` | `Tenant hasMany ApiKey` (cascade), `ApiKey belongsTo User` as creator (set-null) |
| `src/api/query.js` | ~115 lines of duplicated SSE handling replaced by `streamAnswer` |
| `src/middleware/errorHandler.js` | 4xx logs one line; 5xx keeps the stack |
| `README.md` | new endpoints, the widget section, corrected setup instructions |

### Tests added

| File | Covers |
|---|---|
| `src/tests/apiKey.test.js` | key shape, hashing, status-against-the-clock, scope gate, the I/O-free rejections |
| `src/tests/originGuard.test.js` | pattern parsing and every near-miss in the §4.2 table |
| `src/tests/quota.test.js` | UTC day rollover, the fail-closed contract, switched-off limits |
| `src/tests/widgetConfig.test.js` | redaction key sets, partial updates, every validation bound |
| `src/tests/publicRoutes.test.js` | the wiring, over a real HTTP server: preflight, 32kb ceiling, auth-before-everything |

---

## 11. Fixed in passing

Six of these were found while reading the surrounding code closely enough to write
this document. None were part of the plan, all are in the diff.

**The rate limiter bucketed every logged-in user by IP.** `keyFor` read
`req.user?.id`, but `authenticate` puts `userId` on `req.user` from the JWT
payload — there is no `id`. So the per-user branch was dead and every
authenticated request fell through to the IP bucket, which is precisely the
office-behind-one-NAT problem the comment above it claimed to avoid. One word:

```js
req.user?.userId ? `u:${req.user.userId}` : `ip:${ipKeyGenerator(req.ip)}`
```

**The guardrail log said `anonymous` for everyone.** Same wrong field, in
`console.warn`. A rejection log that cannot name who was rejected has no reason
to exist. Now it prefers `req.user.userId`, falls back to `req.apiKey.keyPrefix`
so a widget rejection names the key, and only then says `anonymous`.

**The user profile shipped a credential.** `getUserProfile` selected
`['id', 'name', 'slug', 'apiKey']` off the tenant — the deprecated per-tenant
plaintext key, in a response the dashboard fetches on every page load and any
session store may cache. Dropped from the projection.

**So did three tenant lookups.** `getTenantById` and `getTenantByOwnerId` were
bare `findByPk`/`findOne`, and `createTenant` returned the instance it had just
created, whose column default had generated a key a moment earlier. All three now
go through one shared exclusion:

```js
const SAFE_ATTRIBUTES = { exclude: ['apiKey'] }
```

Excluded at the query level, not stripped from the result — a future caller
cannot reintroduce the leak by forgetting a step. `createTenant` re-reads through
`getTenantById` for the same reason.

**Any caller could fill the log with stack traces.** `errorHandler` ran
`console.error(err)` for every status, so a 32kb-plus body — free, unauthenticated,
repeatable — produced a full `PayloadTooLargeError` stack each time. 4xx is now one
line naming method, path, code and message; 5xx keeps the stack, because that one
is ours. The response body is unchanged either way.

**A visitor could forge log lines.** `sessionId` is client-generated and is
interpolated into the `[PUBLIC CHAT]` label, so a newline in it wrote whatever the
visitor liked into the log as a fresh entry. It is now accepted only as
`/^[A-Za-z0-9_-]{1,64}$/` and dropped otherwise — it is analytics, so dropping it
costs nothing.

**A dead call and two lying comments.** `rotateApiKey` called
`resetKeyCounters(replacement.id)` under a comment claiming it stopped the new key
inheriting the old key's usage; every bucket is keyed by row id and the replacement
is a new row, so it reset counters that were empty by construction. Removed, and
the comment now says why nothing is needed. `peekDailyUsage` documented a `0`
return on Redis failure and returns `null` — deliberately, so a dashboard can say
"unknown" instead of "0 of 500 used" during an outage. And `countActiveKeys`
carried a leftover sentence about an `Op.ne` fast path that does not exist.

**One repair outside the repo.** The local `.env` had `DATABASE_URL=DATABASE_URL=postgres://…`
— the name written twice, which the config loader rejects at boot. Fixed in place,
without printing the value or leaving a copy on disk.

---

## 12. What has been verified, and what has not

```
ℹ tests 233   ℹ suites 46   ℹ pass 230   ℹ fail 0   ℹ todo 3   ℹ duration_ms 2584
```

```bash
npm test
```

The 3 todo are pre-existing placeholders, unrelated to this work. Every test runs
without Postgres, Redis or a provider key, which is why the suite finishes in
under three seconds and why it will still run on a machine that has none of them.
That is a design constraint, not an accident: the rules worth testing here — key
shape, clock-based status, scope arithmetic, origin matching, day rollover,
redaction, clamping — are all pure, and the request-level tests are written so
every request dies at the key check before any I/O is attempted.

Two kinds of coverage, deliberately separated:

| | |
|---|---|
| the four unit suites | the rules — 220 or so assertions over pure functions |
| `publicRoutes.test.js` | the wiring the rules depend on, over a real `app.listen(0)`: that the preflight is answered at all for an origin the server has never seen, that the ceiling in force on this router is 32kb and not the app's 1mb, and that a perfectly-formed request with no key is 401 rather than 400 — proving authentication runs ahead of anything that costs money |

The second suite exists because the first cannot fail when someone reorders
`app.js`. Mount order is load-bearing here (§7), and it is exactly the kind of
thing a later refactor breaks silently.

### Not verified

Stated plainly, because the distance between "the tests pass" and "this works in
production" is where this sort of feature usually goes wrong:

- **The migration has not been applied.** `0003-api-keys.js` has never run against
  a live database. Its SQL is `IF NOT EXISTS` throughout and reversible, but it is
  unexecuted code.
- **No live boot.** The server has not been started with a real `DATABASE_URL`,
  `REDIS_URL` and the four provider keys.
- **No end-to-end request.** Nothing has travelled the full path — mint a key,
  embed it in a page, ask a question, get an answer with redacted sources. The
  pieces are individually tested; the seam between them is reasoned about, not
  observed.
- **No load or concurrency test.** The Lua counters are atomic by construction and
  the `SET NX` throttle is correct by inspection, but no two processes have
  actually raced them.

---

## 13. Before this goes live

**1. Apply the migration.**

```bash
npm run migrate
```

```bash
npm run migrate:status
```

`0003-api-keys` should be listed as executed. There is a matching
`npm run migrate:undo` if it needs to come back out.

**2. Set the six credentials.** Copy `.env.example` to `.env` and fill in
`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `VOYAGE_API_KEY`, `NVIDIA_AI_KEY` and
`PINECONE_API_KEY`. Everything else in that file is a tunable with a compiled-in
default; those six have none and the boot fails without them.

**3. Have Redis actually running.** Not optional here. Without it the quota gate
has no counters, and it fails closed — every public chat request answers 503
`QUOTA_UNAVAILABLE` rather than serving traffic it cannot meter. That is the
correct behaviour (§4.3) and it is also a hard dependency.

**4. Turn on the origin requirement.**

```env
PUBLIC_KEY_REQUIRE_ORIGINS=true
```

It defaults to `false` so a developer can mint a key and `curl` it without
ceremony. In production a public key with an empty allowlist is a key that works
from anywhere, and the whole point of the origin field is that it does not.

**5. Mint one key and use it once.** The one thing the test suite structurally
cannot do (§12): create a key through the dashboard route, put it in a page, ask a
real question. That single request exercises the migration, the cache, the three
counters, all four gates, retrieval, the SSE relay and redaction at once.

**6. Watch the first day's logs for two lines.** `[API KEY] cache invalidation
failed` means a revocation may not have taken effect yet — it is logged at error
level for that reason. `[QUOTA] failing closed` means requests are being refused
because the counter store is unreachable, not silently served unmetered.

---

## 14. Deliberate tradeoffs and known limits

Every one of these is a choice, not an oversight. They are written down so a future
change can argue with the reasoning instead of rediscovering it.

**The origin allowlist does not stop `curl`.** `Origin` is a header, and a header
is whatever the sender says it is. The allowlist stops a *browser* on a page the
owner did not list — which is the actual observed abuse, someone dropping a lifted
`<script>` onto their own site. Against a script author it does nothing. That is
why it is the third gate of five and not the only one: the quota is what bounds the
cost of a determined attacker, and revocation is what ends it. A key that must
survive a hostile holder is a `sk_live_` key, kept on a server.

**Fixed windows can double at a boundary.** 30/minute means up to 60 requests
across two adjacent windows if they are timed at the seam. A sliding window would
not, at the cost of a sorted set per key and a heavier Lua script. For a limiter
whose job is to bound spend rather than shape traffic precisely, a factor of two at
one instant is not worth that; the daily quota is the ceiling that actually
matters.

**Quota state is not durable.** The counters live only in Redis. Lose Redis and the
day's usage resets — a workspace could exceed its daily quota once, on the day of an
outage. The alternative is a write to Postgres per request, which is a real cost on
every request to avoid an occasional over-serve. `drainTotalRequests` folds the
counters into the row periodically, so the audit total survives even though the
window does not.

**Key changes take up to 300 seconds if Redis cannot be written to.** Revocation
and scope edits invalidate the cache entry directly, so the normal path is
immediate. But if the `DEL` fails, the old record stays live until
`PUBLIC_KEY_CACHE_TTL` lapses. That is why the failure is logged at error level and
says the number out loud. Lower the TTL if that window is unacceptable; it trades
against a database lookup per request.

**Widget configuration is last-write-wins.** Two dashboard tabs editing the widget
will have the second save win, silently. Partial updates keep this from being as
bad as it sounds — a `PUT` touching only `title` cannot clobber `primaryColor` —
but there is no version check. For a single owner editing their own widget, an
optimistic-concurrency token would be ceremony for a conflict that essentially does
not happen.

**`GET /config` is metered but not quota'd.** It consumes a rate-limit slot and no
daily message. So a page that loads 10,000 times and is never chatted on costs
10,000 config calls against zero quota. That is intentional — charging a workspace's
message allowance for page views nobody used would be indefensible — but it does
mean the cheap endpoint is the one with the weaker ceiling. It touches one indexed
row and no provider, so the floor on its cost is very low.

**The key is visible. That is the design.** It sits in a public bundle and anyone
who opens devtools can read it. Nothing here pretends otherwise — the string is not
a secret, it is a *workspace identity* with capabilities attached. Everything that
makes it safe is a property of the record it resolves to: the scopes it does not
hold, the origins it is bound to, the quota it cannot exceed, and the fact that it
can be rotated with a grace window or killed outright in one request. Treating a
browser-embedded string as confidential is the mistake this whole design is
arranged to avoid.

**The legacy `tenants.apiKey` column is still there.** Deprecated, no longer read
by anything, and now excluded from every projection (§11) — but not dropped. Doing
that is a separate migration and a separate decision about what else might be
reading the column outside this repository.

---

*Written alongside the implementation. `API_KEY_PLAN.md` is the plan this was built
from; where the two disagree, the code is right and this file is the explanation.*

