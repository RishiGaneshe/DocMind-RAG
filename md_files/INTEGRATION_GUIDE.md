# Integration Guide

How to put a document-grounded chat widget on a website, end to end.

This is the walkthrough. [API_REFERENCE.md](API_REFERENCE.md) is the per-endpoint
specification — every field, every status code, every limit. Read this one first, reach for
that one when you need the exact shape of something.

There are two people in this story and they never share a credential:

| | Who | Credential | What they do |
|---|---|---|---|
| **Owner** | your customer, logged into your dashboard | JWT access token | creates a workspace, uploads PDFs, configures the widget, mints keys |
| **Visitor** | anyone who lands on the customer's website | `pk_live_…` in the page's JavaScript | asks questions |

The visitor never logs in. That is the whole point of the design: the API key identifies
the *workspace*, not a person, so the widget can answer questions from a public page with
no sign-up in the way.

## Contents

**Part A — Owner setup**
1. [Prerequisites](#a1-prerequisites)
2. [Create an account and a workspace](#a2-create-an-account-and-a-workspace)
3. [Upload the documents](#a3-upload-the-documents)
4. [Configure the widget](#a4-configure-the-widget)
5. [Mint the key](#a5-mint-the-key)

**Part B — Embedding on a website**
6. [How the integration is shaped](#b1-how-the-integration-is-shaped)
7. [Where the key goes](#b2-where-the-key-goes)
8. [Bootstrap: `GET /config`](#b3-bootstrap-get-config)
9. [Sending a message](#b4-sending-a-message)
10. [Streaming the answer](#b5-streaming-the-answer)
11. [Rendering sources and citations](#b6-rendering-sources-and-citations)
12. [Managing history](#b7-managing-history)
13. [A complete drop-in widget](#b8-a-complete-drop-in-widget)
14. [The same thing in React](#b9-the-same-thing-in-react)

**Part C — Edge cases**
15. [Origins and CORS](#c1-origins-and-cors)
16. [Key lifecycle](#c2-key-lifecycle)
17. [Rate limits and quota](#c3-rate-limits-and-quota)
18. [Request size and input limits](#c4-request-size-and-input-limits)
19. [Answers that are not answers](#c5-answers-that-are-not-answers)
20. [Streaming failures](#c6-streaming-failures)
21. [The browser environment](#c7-the-browser-environment)
22. [Server and infrastructure](#c8-server-and-infrastructure)
23. [Owner dashboard edge cases](#c9-owner-dashboard-edge-cases)

**Part D — Going live**
24. [Test matrix](#d1-test-matrix)
25. [Go-live checklist](#d2-go-live-checklist)

---

# Part A — Owner setup

Five steps, in order, each one a prerequisite for the next. This is the flow your
dashboard UI wraps; the `curl` below is what it does underneath.

Set these once for the examples:

```bash
API=http://localhost:4500
```

## A1. Prerequisites

The server must be running with Postgres, Redis and Pinecone reachable, and the
`0003-api-keys` migration applied. Check:

```bash
curl -s $API/ready | jq
```

```json
{
  "ready": true,
  "dependencies": { "postgres": "up", "redis": "up", "vectorStore": "up" },
  "models": { "embedding": "voyage-4@1024", "rerank": "rerank-2.5", "llm": "meta/llama-3.2-11b-vision-instruct" }
}
```

`ready: true` does **not** mean the widget will work. Readiness ignores Redis on purpose —
caching is best-effort — but the public chat route treats the quota store as mandatory and
returns `503 QUOTA_UNAVAILABLE` when it is unreachable. **Check
`dependencies.redis` explicitly before blaming the widget.**

## A2. Create an account and a workspace

```bash
curl -s -X POST $API/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@acme.com","password":"correct-horse","firstName":"Ada","lastName":"Lovelace"}'
```

Keep `accessToken` and `refreshToken`. A brand-new account has **no workspace** and its
token carries `tenantId: null`, so create one immediately:

```bash
curl -s -X POST $API/api/tenants \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"name":"Acme Docs","slug":"acme-docs"}'
```

> **The single most common dashboard bug lives here.** `POST /api/tenants` returns a
> **new token pair**, and you must store it in place of the one you just authenticated
> with. `tenantId` is a claim baked into the JWT; the token you sent has `tenantId: null`
> and always will. Ignore the returned tokens and the workspace is created correctly while
> every subsequent `/api/tenants/:tenantId/*` call fails `403 TENANT_REQUIRED` — a
> dashboard that looks broken in a way that logging out and back in "fixes", which is the
> worst kind of bug to be handed by a customer.

Save the returned `tenant.id` as `$TENANT`.

## A3. Upload the documents

PDF only, 10 mb per file by default.

```bash
curl -s -X POST $API/api/tenants/$TENANT/documents \
  -H "Authorization: Bearer $JWT" -F "file=@handbook.pdf"
```

**202** means queued — take `documentId` and poll:

```bash
curl -s $API/api/tenants/$TENANT/documents/$DOC -H "Authorization: Bearer $JWT" | jq '.document.status, .processing'
```

Poll while `processing` is `true`, every 2–3 seconds, backing off, with a total cap. A long
PDF takes minutes.

**200** instead of 202 means these exact bytes were already uploaded — check
`duplicate: true` and branch on `response.status`, not on `success`.

Until at least one document reaches `COMPLETED`, the widget answers every question with the
no-results sentence. That is not a bug, and it is the number one "the chatbot doesn't work"
report. Block the embed instructions in your UI until a document is `COMPLETED`.

If `status` becomes `FAILED`, show `failureReason`. The most common one is a scanned PDF
with no extractable text layer.

## A4. Configure the widget

```bash
curl -s -X PUT $API/api/tenants/$TENANT/widget \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"title":"Acme Support","accentColor":"#ff6600","suggestions":["What is your refund policy?"],"sourceMode":"labels"}'
```

Partial update — the fields you omit keep their current values. Everything here is served
to the visitor's browser by `GET /api/public/config`, so nothing internal belongs in
`footerNote`.

`sourceMode` is the one setting that is not cosmetic. It decides how much of a retrieved
document an anonymous visitor sees, it is enforced server-side, and `full` exposes internal
filenames plus a 240-character snippet of raw document text. Leave it on `labels` unless
the corpus is already public.

## A5. Mint the key

```bash
curl -s -X POST $API/api/tenants/$TENANT/api-keys \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{
    "name": "acme.com production widget",
    "type": "public",
    "scopes": ["chat:query", "chat:config"],
    "allowedOrigins": ["https://acme.com", "https://www.acme.com"],
    "rateLimitPerMinute": 60,
    "dailyQuota": 2000
  }'
```

**201** carries `key` — the plaintext, shown **once**, in this response and nowhere else
ever. Only its SHA-256 is stored; no owner and no operator can recover it. If it is lost,
rotate.

Four decisions to get right at mint time:

**`type: "public"`.** A `pk_live_` key is designed to be readable. It ships in browser
code, so anyone who views source has it — that is the model, the same one Stripe's
publishable keys use. What protects the workspace is not secrecy but the origin allowlist,
the scopes, the rate limits, the daily quota and revocability. A `secret` key is the
opposite: server-side only, exempt from origin checks, and **must never** reach a browser.

**Scopes: `chat:query` and `chat:config`, and nothing else.** Add `chat:filter` only if the
site genuinely scopes questions to chosen documents — it lets whoever lifts the key probe
the corpus document by document. The API refuses `documents:read` on a public key outright.

**`allowedOrigins`: list every origin the widget will actually run on.** Get this wrong and
the widget fails with `403 ORIGIN_NOT_ALLOWED` on production only. See
[C1](#c1-origins-and-cors) — the apex/`www` distinction alone accounts for most first-deploy
failures.

**`dailyQuota`: the real cost ceiling.** The origin allowlist stops someone embedding the
key on their own site; it does not stop `curl`, which can send any `Origin` header it
likes. The daily quota is what bounds the bill when a key leaks. Set it to a multiple of
expected traffic, not to the maximum.

Verify the key works before handing over the embed snippet:

```bash
curl -s $API/api/public/config -H "X-Api-Key: $PK" -H "Origin: https://acme.com" | jq
```

A `403 ORIGIN_NOT_ALLOWED` here, with the right `Origin`, means the allowlist entry does
not match — compare scheme, host and port character by character.

---

# Part B — Embedding on a website

## B1. How the integration is shaped

Two calls. That is the entire public API.

```
page load ──► GET  /api/public/config   once, on mount
                    ├─ title, greeting, colours, suggestions
                    ├─ limits.maxQueryLength, limits.maxHistoryTurns
                    └─ capabilities.filterByDocument

user sends ──► POST /api/public/chat    once per message
                    └─ { answer, sources, citedSources, chunksUsed }
                       or an SSE stream of the same
```

Three rules that fall out of the design and are not negotiable:

1. **The server holds no conversation state.** There is no thread id and no server-side
   session. You send the history you want the model to see, every time. This is why the
   history caps in [C4](#c4-request-size-and-input-limits) matter to you and not just to us.
2. **Never send `credentials: 'include'`.** The public API deliberately does not return
   `Access-Control-Allow-Credentials`, so the browser will reject the whole response and
   your `catch` will see a bare `TypeError: Failed to fetch` with no status to read. There
   are no cookies here by design — a widget on a third-party page must not be able to make
   the visitor's browser attach credentials.
3. **The key goes in a header.** `X-Api-Key`. Not a query parameter — those end up in access
   logs, browser history and the `Referer` of every outbound link on the page.

## B2. Where the key goes

A `pk_live_` key is not a secret, but it is not litter either. The sane placement:

```js
// Injected at build time. Vite, Next, webpack — all the same idea.
const API = import.meta.env.VITE_CHAT_API_URL
const KEY = import.meta.env.VITE_CHAT_PUBLIC_KEY
```

| Do | Don't |
|---|---|
| inject at build time from CI environment variables | commit the key to the repository |
| use a different key per environment (dev/staging/prod) | reuse one key across all sites |
| scope each key's origins to that environment's hosts | ship an `sk_live_` key to a browser, ever |
| rotate on a schedule and after any suspected leak | assume minification hides it |

A per-environment key means a leak from staging is revoked without touching production, and
the usage numbers in the dashboard mean something. One key across three sites tells the
owner nothing about which site is burning the quota.

## B3. Bootstrap: `GET /config`

Call it once when the widget mounts, before the launcher is visible.

```js
async function bootstrap () {
  const response = await fetch(`${API}/api/public/config`, {
    headers: { 'X-Api-Key': KEY }
  })

  const body = await response.json().catch(() => null)

  if (!response.ok) {
    // Log it. Do not mount. A visitor on someone else's website must never see
    // our error text.
    console.warn('[chat] config failed', response.status, body?.code)
    return null
  }

  return body
}
```

What to actually do with the result:

| Field | Use |
|---|---|
| `widget.title`, `greeting`, `placeholder`, `accentColor`, `position`, `showBranding`, `footerNote` | render the shell |
| `widget.suggestions` | up to 6 starter chips; empty array means show none |
| `workspace.name` | the only workspace detail exposed — safe to display |
| `limits.maxQueryLength` | the textarea's `maxlength` and character counter |
| `limits.maxHistoryTurns` | how many turns to keep locally |
| `capabilities.filterByDocument` | whether a document filter UI should exist at all |

Fail **closed and quietly**. A widget that renders a broken shell, or an alert box, on a
customer's marketing page is worse than a widget that does not appear. Log to the console
for the integrator and stop.

Do not cache the config across page loads in `localStorage`. It is cheap, it is one request,
and stale colours or a stale `sourceMode` are exactly the kind of thing an owner changes and
then reports as "not applying".

## B4. Sending a message

The non-streaming path first, because it is the one to get right before adding streaming.

```js
async function ask (query, history) {
  const response = await fetch(`${API}/api/public/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
    body: JSON.stringify({ query, history, sessionId })
  })

  const body = await response.json().catch(() => null)

  if (!response.ok) throw new ChatError(response, body)

  return body   // { success, answer, sources, citedSources, chunksUsed }
}
```

`ChatError` needs to survive all three server error shapes and a non-JSON body. This is the
one piece of plumbing worth writing carefully — see §1 of the API reference for why:

```js
class ChatError extends Error {
  constructor (response, body) {
    // Shape B (413, malformed JSON): `error` is an object, no `code`.
    // Shape A (everything from a handler) and C (404): `error` is a string.
    const message =
      body && typeof body.error === 'object' && body.error !== null
        ? body.error.message ?? 'Request failed'
        : typeof body?.error === 'string'
          ? body.error
          : `Request failed with status ${response.status}`

    super(message)

    this.status = response.status
    this.code = typeof body?.error === 'string' ? body?.code ?? null : null
    this.retryAfter = Number(response.headers.get('Retry-After')) || null
  }
}
```

`await response.json()` on its own is a trap: a 502 from a reverse proxy in front of the API
is **HTML**, and the `SyntaxError` it throws has nothing to do with the actual failure. The
`.catch(() => null)` above is not defensive padding, it is the difference between "the
service is down" and a confusing parse error in your logs.

Now the error routing. Group by what the *visitor* should experience, not by status code:

```js
function explain (error) {
  switch (error.code) {
    case 'RATE_LIMITED':
      return { text: error.message, retryIn: error.retryAfter ?? 30, retryable: true }
    case 'QUOTA_EXCEEDED':
      return { text: error.message, retryable: false, disableInput: true }
    case 'QUOTA_UNAVAILABLE':
    case 'SERVICE_UNAVAILABLE':
    case 'TIMEOUT':
      return { text: 'The assistant is briefly unavailable. Please try again.', retryable: true }
    case 'PROMPT_INJECTION':
    case 'INVALID_CHARACTERS':
    case 'DEGENERATE_QUERY':
    case 'QUERY_TOO_LONG':
    case 'QUERY_REQUIRED':
      return { text: error.message, retryable: false }        // never auto-retry
    case 'API_KEY_MISSING':
    case 'API_KEY_INVALID':
    case 'API_KEY_REVOKED':
    case 'API_KEY_EXPIRED':
    case 'SCOPE_FORBIDDEN':
    case 'ORIGIN_REQUIRED':
    case 'ORIGIN_NOT_ALLOWED':
    case 'WORKSPACE_UNAVAILABLE':
      // Integrator-facing. The visitor cannot fix any of these.
      console.error('[chat] configuration error:', error.code, error.message)
      return { text: 'Chat is unavailable right now.', retryable: false, hideWidget: true }
    default:
      return { text: 'Something went wrong. Please try again.', retryable: true }
  }
}
```

The one thing that switch cannot express: **there is no idempotency key on this API.** A
retried `POST /chat` is a second message and spends a second unit of quota. So retry only
what the table above marks retryable, never automatically more than once, and never on a
timeout you cannot distinguish from a slow success.

## B5. Streaming the answer

Add `stream: true`. Everything else about the request is identical, including the cost.

**`EventSource` cannot do this.** It is `GET`-only and cannot set headers, so it can neither
carry the body nor the `X-Api-Key`. Use `fetch` and read the response body as a stream:

```js
async function askStreaming (query, history, handlers, signal) {
  const response = await fetch(`${API}/api/public/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
    body: JSON.stringify({ query, history, sessionId, stream: true }),
    signal
  })

  // Every gate failure (401/403/429/503) still arrives as ordinary JSON, because
  // it happens before the stream opens.
  if (!response.ok) {
    throw new ChatError(response, await response.json().catch(() => null))
  }

  // Read the limit headers while you still have the Response object.
  handlers.onLimits?.({
    remaining: Number(response.headers.get('RateLimit-Remaining')) || null,
    quotaRemaining: Number(response.headers.get('X-Quota-Remaining')) || null
  })

  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  let buffer = ''
  let finished = false

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // SSE frames are separated by a blank line, and a frame can be split
      // across network chunks — so keep the trailing fragment.
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        const parsed = parseFrame(frame)

        if (!parsed) continue

        if (parsed.event === 'sources') handlers.onSources(parsed.data.sources ?? [])
        else if (parsed.event === 'chunk') handlers.onChunk(parsed.data.content ?? '')
        else if (parsed.event === 'done') finished = true
        else if (parsed.event === 'error') handlers.onStreamError(parsed.data.error)
      }
    }
  } finally {
    reader.releaseLock()
  }

  // A dropped connection or a proxy timeout ends the body with no `done`.
  if (!finished) handlers.onIncomplete()
}
```

```js
function parseFrame (frame) {
  let event = 'message'
  let data = ''

  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim()
    else if (line.startsWith('data: ')) data += line.slice(6)
  }

  if (!data) return null

  try {
    return { event, data: JSON.parse(data) }
  } catch {
    return null    // a malformed frame is skipped, never thrown
  }
}
```

Four properties of this stream that a happy-path client gets wrong:

**A 200 does not mean the answer worked.** Headers are sent before retrieval runs, so a
vector-store outage arrives as an `error` **event** inside a stream you already accepted.
`response.ok` will have passed. Handle `onStreamError` as a real failure path.

**The `sources` event always arrives first, exactly once, before any text.** Render the
citation list from it immediately — you do not have to wait for `done`.

**A refusal arrives as a `chunk`, not an `error`.** When the retrieved context is
insufficient the server swaps its internal sentinel for the standard no-answer sentence and
sends it as ordinary text. Nothing partial precedes it. So an answer that reads "I could not
find any relevant information…" is a *successful* response, and your UI must not decorate it
with a retry button.

**The stream can end without `done`.** That is what `onIncomplete` is for. Keep the text you
received, mark the message as truncated, and stop the spinner — the failure mode to avoid is
a spinner that runs forever because you were waiting for an event that will never come.

Always pass an `AbortSignal` and abort on unmount or when the visitor closes the widget.
Without it, a closed chat panel keeps a stream open and keeps calling `onChunk` into a
component that no longer exists.

```js
const controller = new AbortController()
// on close/unmount:
controller.abort()
```

An aborted fetch throws `AbortError`. Filter it out before showing an error — the visitor
closed the panel on purpose:

```js
catch (error) {
  if (error.name !== 'AbortError') showError(error)
}
```

## B6. Rendering sources and citations

The answer text contains inline markers — `[1]`, `[2]` — that index into `sources` by its
`citation` field. Out-of-range markers are stripped server-side before they reach you, so
any marker you receive pointed at a real source **at generation time**.

Under `labels` (the default) a source is three fields:

```json
{ "citation": 1, "filename": "handbook.pdf", "page": 4 }
```

`page` can be `null` — not every chunk carries one. Render "handbook.pdf" without a page
rather than "handbook.pdf, page null".

Three rendering rules:

**Render markers as links only for sources you actually have.** Under `sourceMode: "hidden"`
the server returns `sources: []` while the answer text still contains `[1]`. A naive
renderer produces a dead link or a crash on `sources[0].filename`. Look the citation up and
fall back to plain text:

```js
function renderAnswer (answer, sources) {
  const byNumber = new Map(sources.map((s) => [s.citation, s]))

  return answer.replace(/\[(\d{1,3})\]/g, (marker, digits) => {
    const source = byNumber.get(Number(digits))
    return source ? link(marker, source) : ''   // or keep `marker` as plain text
  })
}
```

**`citedSources` is the subset the answer actually referenced.** Grey out or omit the rest —
retrieval returns up to 6 sources and a good answer often uses two. It can also name numbers
absent from `sources` under `hidden`; intersect, do not assume.

**`filename` is shown to the public under `labels` and `full`.** Whatever the owner uploaded
is what visitors read, so `Q3-pricing-DRAFT-do-not-share.pdf` becomes a citation on their
marketing site. Worth a warning in your dashboard's upload UI, and a reason to prefer
`hidden` when filenames are themselves sensitive.

## B7. Managing history

You own the conversation; the server keeps nothing between requests.

```js
const history = messages
  .filter((m) => m.role === 'user' || m.role === 'assistant')
  .slice(-maxHistoryTurns)                       // from limits.maxHistoryTurns
  .map((m) => ({ role: m.role, content: m.content }))
```

Rules the server enforces whether or not you do:

| Rule | Value | If you exceed it |
|---|---|---|
| turns kept | last 6 (`limits.maxHistoryTurns`) | older turns dropped **silently** |
| per-turn length | 1000 chars (`limits.maxQueryLength`) | truncated silently |
| total history | 6000 chars | oldest turns dropped until it fits |
| `role` | `user` or `assistant` only | any other entry is discarded |
| `content` | non-empty string after trim | discarded |

All of it is silent. Nothing tells you a turn was dropped, so if your UI shows twenty
messages and the model only ever sees six, the visitor will experience the assistant
"forgetting" and you will have no signal. Trim locally to the advertised limits and, if the
conversation is long, say so in the UI.

Do **not** put the current question into `history` — send it as `query`. Sending it in both
places makes the model see it twice and answer as if it were being repeated.

One non-obvious consequence: **a question with empty `history` may be answered from cache**
(1 hour, invalidated by any upload or delete), while every follow-up in a thread is computed
fresh. So the first message in a conversation is often noticeably faster than the second. The
public response does not expose a `cached` flag, so this is only ever visible as latency —
worth knowing before you go looking for the bug.

Also: a "new conversation" button that clears `history` is not cosmetic. It restores cache
eligibility and it drops the visitor's earlier turns from every subsequent request.

## B8. A complete drop-in widget

Dependency-free, streaming, and handling every failure path above. Drop it in a `<script
type="module">`, or bundle it.

```html
<script type="module">
const API = 'https://chat.example.com'
const KEY = 'pk_live_…'                       // injected at build time

const state = { messages: [], open: false, busy: false, config: null, blocked: false }
const sessionId = crypto.randomUUID().replace(/-/g, '').slice(0, 32)

const el = (tag, props = {}) => Object.assign(document.createElement(tag), props)

async function json (response) {
  return await response.json().catch(() => null)
}

function describe (status, body) {
  if (body && typeof body.error === 'object' && body.error !== null) {
    return { message: body.error.message ?? 'Request failed', code: null }
  }
  if (typeof body?.error === 'string') {
    return { message: body.error, code: body.code ?? null }
  }
  return { message: `Request failed with status ${status}`, code: null }
}
```

```js
// ── bootstrap ──────────────────────────────────────────────────────────────
async function boot () {
  let response

  try {
    response = await fetch(`${API}/api/public/config`, { headers: { 'X-Api-Key': KEY } })
  } catch (networkError) {
    // No status to read: CORS rejection, DNS, offline, or a blocked request.
    console.warn('[chat] unreachable:', networkError.message)
    return
  }

  const body = await json(response)

  if (!response.ok) {
    const { message, code } = describe(response.status, body)
    console.warn(`[chat] config failed (${response.status} ${code ?? '-'}): ${message}`)
    return                                    // never mount a broken widget
  }

  state.config = body
  mount()
}

// ── one message ────────────────────────────────────────────────────────────
async function send (text) {
  if (state.busy || state.blocked) return

  const query = text.trim()

  if (!query) return
  if (query.length > state.config.limits.maxQueryLength) return

  state.busy = true
  state.messages.push({ role: 'user', content: query })

  const assistant = { role: 'assistant', content: '', sources: [], status: 'streaming' }
  state.messages.push(assistant)
  render()

  const history = state.messages
    .slice(0, -2)                             // exclude this question and the placeholder
    .filter((m) => m.content)
    .slice(-state.config.limits.maxHistoryTurns)
    .map((m) => ({ role: m.role, content: m.content }))

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)

  try {
    await stream({ query, history, assistant, signal: controller.signal })
  } catch (error) {
    if (error.name !== 'AbortError') handleFailure(error, assistant)
    else if (assistant.status === 'streaming') assistant.status = 'incomplete'
  } finally {
    clearTimeout(timeout)
    state.busy = false
    render()
  }
}
```

```js
// ── the stream ─────────────────────────────────────────────────────────────
async function stream ({ query, history, assistant, signal }) {
  const response = await fetch(`${API}/api/public/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
    body: JSON.stringify({ query, history, sessionId, stream: true }),
    signal
  })

  if (!response.ok) {
    const body = await json(response)
    const { message, code } = describe(response.status, body)
    const error = new Error(message)

    error.code = code
    error.status = response.status
    error.retryAfter = Number(response.headers.get('Retry-After')) || null

    throw error
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()

    if (done) break

    buffer += decoder.decode(value, { stream: true })

    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''

    for (const frame of frames) {
      let event = 'message'
      let data = ''

      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim()
        else if (line.startsWith('data: ')) data += line.slice(6)
      }

      if (!data) continue

      let payload

      try { payload = JSON.parse(data) } catch { continue }

      if (event === 'sources') assistant.sources = payload.sources ?? []
      else if (event === 'chunk') assistant.content += payload.content ?? ''
      else if (event === 'done') assistant.status = 'complete'
      else if (event === 'error') assistant.status = 'failed'

      render()
    }
  }

  // No `done` event ever arrived — the connection ended early.
  if (assistant.status === 'streaming') assistant.status = 'incomplete'
}
```

```js
// ── failures ───────────────────────────────────────────────────────────────
const FATAL = new Set([
  'API_KEY_MISSING', 'API_KEY_INVALID', 'API_KEY_REVOKED', 'API_KEY_EXPIRED',
  'SCOPE_FORBIDDEN', 'ORIGIN_REQUIRED', 'ORIGIN_NOT_ALLOWED', 'WORKSPACE_UNAVAILABLE'
])

function handleFailure (error, assistant) {
  assistant.status = 'failed'

  if (FATAL.has(error.code)) {
    // The visitor cannot fix this and should not read about it.
    console.error(`[chat] ${error.code}: ${error.message}`)
    assistant.content = 'Chat is unavailable right now.'
    state.blocked = true                       // stop accepting input
    return
  }

  if (error.code === 'QUOTA_EXCEEDED') {
    assistant.content = error.message           // "…daily message limit…"
    state.blocked = true
    return
  }

  if (error.code === 'RATE_LIMITED') {
    const wait = error.retryAfter ?? 30
    assistant.content = `${error.message} (about ${wait}s)`
    state.busy = true
    setTimeout(() => { state.busy = false; render() }, wait * 1000)
    return
  }

  if (error.status === 413) {
    // Shape B, no code. The history grew past the 32 kb body limit.
    assistant.content = 'This conversation got too long. Starting a new one will help.'
    state.messages = state.messages.slice(-2)
    return
  }

  // 400s from the guardrails, and everything unclassified.
  assistant.content = error.message || 'Something went wrong. Please try again.'
}

boot()
</script>
```

The rendering half is deliberately omitted — it is your design system, not ours. What matters
is above it: the bootstrap that fails closed, the history slice, the frame loop, the
`incomplete` state, and a `blocked` flag that stops the widget hammering an endpoint that
will keep saying no.

## B9. The same thing in React

One hook. The important detail is the abort on unmount — without it a closed panel keeps
streaming into a dead component.

```jsx
import { useCallback, useEffect, useRef, useState } from 'react'

export function useChat ({ api, apiKey }) {
  const [config, setConfig] = useState(null)
  const [messages, setMessages] = useState([])
  const [busy, setBusy] = useState(false)
  const [blocked, setBlocked] = useState(null)      // null | { reason, message }

  const sessionId = useRef(crypto.randomUUID().replace(/-/g, '').slice(0, 32))
  const abort = useRef(null)

  // Bootstrap once. `cancelled` guards against a StrictMode double-mount
  // resolving after the first effect was torn down.
  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        const response = await fetch(`${api}/api/public/config`, {
          headers: { 'X-Api-Key': apiKey }
        })

        if (!response.ok) throw new Error(`config ${response.status}`)

        const body = await response.json()

        if (!cancelled) setConfig(body)
      } catch (error) {
        console.warn('[chat] config failed:', error.message)
      }
    })()

    return () => { cancelled = true }
  }, [api, apiKey])

  // Abort any in-flight stream when the component goes away.
  useEffect(() => () => abort.current?.abort(), [])
```

The send function, still inside the same hook:

```jsx
  const send = useCallback(async (text) => {
    if (busy || blocked) return

    const question = text.trim()

    if (!question || question.length > 1000) return

    // History is derived from state *before* the new turn is appended, and
    // trimmed to the last 6 — the server would trim it anyway, and sending less
    // keeps the body away from the 32 kb limit.
    const history = messages
      .filter((m) => m.text)
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.text }))

    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', text: question },
      { id: crypto.randomUUID(), role: 'assistant', text: '', pending: true }
    ])
    setBusy(true)

    abort.current = new AbortController()

    try {
      const response = await fetch(`${api}/api/public/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
        body: JSON.stringify({
          query: question,
          stream: true,
          sessionId: sessionId.current,
          history
        }),
        signal: abort.current.signal
      })

      if (!response.ok) {
        // A failed stream request still answers with JSON, not SSE.
        const body = await response.json().catch(() => null)
        throw new ChatError(response, body)
      }

      await consume(response, {
        onChunk: (delta) =>
          setMessages((prev) => patchLast(prev, (m) => ({ ...m, text: m.text + delta }))),
        onSources: (payload) =>
          setMessages((prev) => patchLast(prev, (m) => ({ ...m, sources: payload.sources }))),
        onDone: () =>
          setMessages((prev) => patchLast(prev, (m) => ({ ...m, pending: false })))
      })
    } catch (error) {
      if (error.name === 'AbortError') return          // unmounted; state is gone
      handle(error)
    } finally {
      setBusy(false)
      abort.current = null
    }
  }, [api, apiKey, busy, blocked, messages])
```

The rest of the hook — the failure branch, the immutable "patch the last message"
helper, and what the hook hands back:

```jsx
  const handle = (error) => {
    if (FATAL.has(error.code)) {
      setBlocked({ reason: error.code, message: 'Chat is unavailable right now.' })
    } else if (error.code === 'QUOTA_EXCEEDED') {
      setBlocked({ reason: error.code, message: 'The assistant is busy today. Try tomorrow.' })
    } else if (error.code === 'RATE_LIMITED') {
      const seconds = error.retryAfter ?? 30
      setBlocked({ reason: error.code, message: `Too many questions. Wait ${seconds}s.` })
      setTimeout(() => setBlocked(null), seconds * 1000)
    }

    setMessages((prev) =>
      patchLast(prev, (m) => ({
        ...m,
        pending: false,
        failed: true,
        text: m.text || 'Sorry, something went wrong.'
      }))
    )
  }

  return { config, messages, busy, blocked, send, stop: () => abort.current?.abort() }
}

// Replaces the last element without mutating the array — React needs a new
// reference to re-render, and mutating `prev` in place gives you neither.
const patchLast = (list, fn) =>
  list.length === 0 ? list : [...list.slice(0, -1), fn(list[list.length - 1])]
```

Three things this hook does that a first attempt usually does not:

| Detail | Why it matters |
| --- | --- |
| `abort.current?.abort()` in an unmount effect | Closing the panel mid-answer otherwise leaves a `fetch` writing into a dead component; React logs a warning and the connection stays open until the answer finishes. |
| `history` read from `messages` *before* the optimistic append | Otherwise the current question is sent twice — once as `query`, once as the last history turn — and the model answers a duplicated prompt. |
| `blocked` as an object, not a boolean | The widget has three distinct dead states (fatal, quota, cooling off) and only one of them recovers on its own. Collapsing them loses the ability to re-enable the input. |

`consume`, `ChatError` and `FATAL` are the same ones from [B5](#b5-streaming-the-answer)
and [B8](#b8-a-complete-drop-in-widget) — nothing in them is framework-specific.

---

# Part C — Edge cases

This is the part to read before you ship, not after. Every entry below is a real behaviour
of this server, traced to the code that produces it — not a generic list of things that can
go wrong with HTTP. Each one says what the visitor sees and what your widget should do.

## C1. Origins and CORS

The allowlist on a public key is checked in [`originGuard`](src/middleware/originGuard.js),
*after* the key has been resolved. It compares normalised origins: **scheme, host, and
non-default port**. That is exactly what the browser sends in `Origin`, and nothing finer.

**An empty allowlist means every origin is allowed.** `originGuard` returns early when
`allowedOrigins.length === 0` — the key works from anywhere, including `curl`. This is
convenient during development and it is the single most common way a production key ends up
unprotected. A key that ships in a public page should always have at least one origin.

### What matches what

| Allowlist entry | `https://acme.com` | `https://www.acme.com` | `https://app.acme.com` | `http://acme.com` | `https://acme.com:8443` |
|---|---|---|---|---|---|
| `https://acme.com` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `https://www.acme.com` | ❌ | ✅ | ❌ | ❌ | ❌ |
| `https://*.acme.com` | ❌ | ✅ | ✅ | ❌ | ❌ |
| `https://acme.com:8443` | ❌ | ❌ | ❌ | ❌ | ✅ |

Four traps in that table:

- **`www` is a different origin from the apex.** Almost every site serves both, or redirects
  one to the other in a way that still leaves some pages on the loser. List both.
- **A wildcard does not cover the apex.** `https://*.acme.com` matches `www.` and `app.` and
  `staging.` but not `acme.com` itself — the match is a suffix test against `.acme.com` plus
  an explicit `hostname !== base` check. This is deliberate: the alternative silently widens
  every wildcard an owner writes by one extra host.
- **Scheme is part of identity.** An `http://` page cannot use a key allowlisted for
  `https://`. And a plain-`http` entry is *rejected at mint time* for anything other than a
  loopback host unless the deployment sets `PUBLIC_ALLOW_INSECURE_ORIGINS=true`.
- **Port is part of identity, but only when non-default.** `https://acme.com` and
  `https://acme.com:443` normalise to the same thing; `:8443` does not.

`localhost`, `127.0.0.1`, `[::1]` and anything ending `.localhost` are always accepted over
plain `http` at mint time, so a dev key needs no special flag.

### Requests with no origin at all

`Origin` is the authority; `Referer` is a fallback, with its path discarded, for the browser
and proxy combinations that strip `Origin` on same-site requests. A request with neither is
not a browser request, and an origin-restricted key rejects it with **403
`ORIGIN_REQUIRED`**.

Three real cases produce this:

| Situation | What the browser sends | Result |
|---|---|---|
| Page opened from disk (`file:///…/index.html`) | `Origin: null` | ❌ `ORIGIN_REQUIRED` |
| `<iframe sandbox>` without `allow-same-origin` | `Origin: null` | ❌ `ORIGIN_REQUIRED` |
| `Referrer-Policy: no-referrer` on a same-site request that also drops `Origin` | neither header | ❌ `ORIGIN_REQUIRED` |

The literal string `"null"` is explicitly not treated as an origin, so an opaque origin
cannot slip through by matching a pattern. If your integrators test by double-clicking an
HTML file, tell them to run a local server instead — `npx serve` is enough, and
`http://localhost:3000` is allowlistable.

### CORS is not the security boundary

The public router reflects **whatever origin asked** (`origin: true`) and mounts before the
app's own CORS allowlist. That is not a hole; it is the only workable configuration. A widget
lives on customer sites this server cannot enumerate in advance, and a CORS preflight cannot
help anyway: `OPTIONS` carries no `X-Api-Key`, so at preflight time the server does not yet
know which key — and therefore which allowlist — applies.

So the order is: browser preflight always succeeds → the real request arrives with the key →
`originGuard` decides. The consequences worth knowing:

- **A CORS failure in your console is almost never an allowlist problem.** An
  `ORIGIN_NOT_ALLOWED` rejection is a normal 403 with a JSON body your code can read. If you
  instead see "blocked by CORS policy" with no status, you are hitting the wrong path — most
  often `/api/tenants/…` (the dashboard API, which *does* have a strict allowlist) instead of
  `/api/public/…`.
- **Preflights are cached for 24 hours** (`maxAge: 86400`). Changing CORS config on the server
  will not visibly take effect in an already-open browser for up to a day.
- **The origin check does not stop `curl`.** Any client can send any `Origin` it likes. This
  guard raises the cost of the easy attack — lifting a key out of a bundle and dropping the
  widget on your own site. What bounds a determined direct caller is the daily quota, which is
  why [A5](#a5-mint-the-key) treats `dailyQuota` as the real ceiling.
- **Secret keys skip the check entirely.** `sk_live_…` is server-to-server; there is no
  `Origin` to check and no browser to protect. Never put one in a page.

## C2. Key lifecycle

A key can stop working while the page it is embedded in is still live. All four failures
arrive as **401** with a `code`, and none of them are retriable — a widget that retries a 401
just burns rate-limit slots against a key that will never work again.

| `code` | Cause | Fix, and who does it |
|---|---|---|
| `API_KEY_MISSING` | no `X-Api-Key` and no `Authorization: Bearer` | you — the header was dropped, usually by a proxy or a stripped `fetch` config |
| `API_KEY_INVALID` | fails the `^(pk\|sk)_live_[A-Za-z0-9_-]{40,64}$` shape check, or no row matches its hash | you — truncated key, wrong environment, a template that HTML-escaped it |
| `API_KEY_REVOKED` | owner deleted the key, or rotated it with `graceHours: 0` | the owner mints a new one; the site needs a redeploy |
| `API_KEY_EXPIRED` | the key was rotated and its grace window has now closed | the owner already has the replacement — the site was never redeployed |

`API_KEY_EXPIRED` is the one worth designing for, because it is the only one that is
*scheduled*. Rotation with `graceHours: 24` means the old key keeps working for exactly 24
hours and then stops, whether or not anyone deployed the new one. It will happen at whatever
hour the owner clicked rotate, which is unlikely to be during your working day.

Two practical consequences:

- **Log the code, not just the status.** A widget that reports "chat unavailable" for all
  four gives whoever debugs it nothing. `console.warn('[chat]', error.code)` costs one line
  and turns a support ticket into a one-minute fix.
- **Do not paper over it with a fallback key.** Shipping two keys so one can take over
  defeats the point of rotation: the leaked key is still live.

### The cache lag

A resolved key is cached in Redis for `keyCacheTtlSeconds` (300 s by default); a *miss* is
cached as a sentinel for `keyNegativeCacheTtlSeconds` (30 s). Revocation, rotation and any
scope or origin edit explicitly delete the entry, so the normal case takes effect on the very
next request. But `invalidateKeyCache` swallows a Redis failure — it logs at error level and
moves on — so in the rare case where the `DEL` fails:

- a **revoked** key can keep working for up to 300 s;
- a **scope or origin change** can take up to 300 s to bite;
- a key created and used within 30 s of a failed lookup of the same string can 401 for the
  remainder of the negative window.

`revoked` and `expired` are computed from `revokedAt` / `expiresAt` **at request time**, not
baked into the cached blob — so a key whose grace window closes mid-TTL does stop working on
schedule regardless of the cache.

### Minting limits

- A workspace may hold **25 live keys** (`maxKeysPerTenant`). The 26th mint fails with 409
  `KEY_LIMIT_REACHED`. Revoked keys do not count.
- **Rotation does not check that cap.** Rotating while at 25 leaves 26 rows with a live
  status, because rotate inserts the replacement and only schedules the old one's expiry. Not
  a security problem, but a dashboard that shows "25 / 25" will look wrong.
- **The plaintext key is returned once, at mint or rotate time, and never again.** Only
  `keyPrefix` and `keyLast4` are stored in a readable form. There is no recovery endpoint; a
  lost key is rotated, not retrieved.

## C3. Rate limits and quota

Three independent counters, all in Redis, all fixed-window. A request has to pass all three.

| Bucket | Default | Window | Applies to | Code when exceeded |
|---|---|---|---|---|
| per key | 30 / min | 60 s | `GET /config` and `POST /chat` | 429 `RATE_LIMITED` |
| per key **per visitor IP** | 10 / min | 60 s | `POST /chat` only | 429 `RATE_LIMITED` |
| per key per **UTC day** | 500 | UTC calendar day | `POST /chat` only | 429 `QUOTA_EXCEEDED` |

The owner can raise the per-key and daily numbers when minting; the visitor number is a
deployment-wide setting the owner cannot change.

### Both rate buckets share one code

`RATE_LIMITED` covers "the whole site is over its per-minute allowance" and "this one visitor
is typing too fast". Your code cannot distinguish them from `code` — only the message string
differs, and you should not parse it. Treat both the same way: honour `Retry-After` and
re-enable the input when it elapses.

Do not infer the wait from `RateLimit-Reset`. On a visitor-bucket 429 the `RateLimit-*`
headers were already written from the *key's* counter before the visitor counter was
consulted, so they can cheerfully report remaining capacity on a request that was just
refused. `Retry-After` is the only header that describes the bucket that said no.

### Visitors sharing an IP

The visitor bucket is `key:<id>:ip:<req.ip>`. Everyone behind one corporate NAT, one campus
gateway, or one mobile carrier CGNAT is **one visitor** to this limiter. Ten messages a minute
across a whole office is a plausible amount of traffic, so a widget on an intranet-adjacent
page will see `RATE_LIMITED` from real users behaving normally.

There is no way to opt out per key. If this is your deployment, raise
`PUBLIC_VISITOR_RATE_PER_MINUTE` — and note that `trust proxy` is set on the app, so `req.ip`
is the client address from `X-Forwarded-For`, not the load balancer's. If that header is not
being set correctly by your proxy, **every visitor collapses into one bucket** and the widget
will look broken under any real traffic. Verify it before blaming the limit.

### The daily quota

`QUOTA_EXCEEDED` is the one refusal that does not clear in a minute, and it resets at
**midnight UTC** — not the visitor's midnight, not the owner's. Tell the visitor "try again
tomorrow" rather than computing a local time you would get wrong.

Once you see it, **stop sending**. Every subsequent request is counted even though it is
refused (denied requests increment the counter; a limiter that forgives rejections rewards
hammering it), so a widget that retries makes the recovery no sooner and the owner's usage
graph a lie. Set a `blocked` flag and leave it set — see [B8](#b8-a-complete-drop-in-widget).

`GET /config` costs a rate-limit slot but **not** a daily message. A page that loads the
widget on every route and never chats will never consume quota. It can still exhaust the
per-minute bucket, though — 30 page loads a minute from one busy site is enough.

### 503 `QUOTA_UNAVAILABLE` — the one 5xx you should retry

If Redis is unreachable, `enforceQuota` **fails closed**: 503 with `Retry-After: 30`. It does
not let the request through. Every request past that middleware spends money at three upstream
providers, so "we could not check the quota" must never be read as "the request is within
quota".

For your widget this is the friendliest failure in the whole list, because it is genuinely
transient and it carries its own backoff. Retry once after `Retry-After` seconds; if it fails
again, fail closed and quiet.

### Window seams and double-spending

Two rough edges that are not bugs but will show up in a test suite:

- **Fixed windows, not sliding.** A burst straddling a window boundary can briefly get up to
  twice the limit through — 30 messages at 11:59:59 and 30 more at 12:00:01. The daily quota
  is what caps the total, and a sliding window would cost a sorted set per key per window to
  avoid a handful of extra requests.
- **There is no idempotency key.** A retried `POST /chat` — by your code, by a user
  double-clicking send, by a proxy replaying a timed-out request — spends quota twice and pays
  the LLM twice. Guard on the client: disable send while a request is in flight (`busy` in the
  examples above) and never retry a 5xx from `/chat` automatically except the
  `QUOTA_UNAVAILABLE` case above, where nothing was spent.

## C4. Request size and input limits

Some limits reject; most **silently clamp**. The silent ones are the dangerous ones, because
the widget looks like it is working and the server is quietly doing something narrower than
what you asked.

| Input | Limit | On violation |
|---|---|---|
| whole request body | 32 kb | **413**, and it does not look like other errors |
| `query` | 1000 chars | 400 `QUERY_TOO_LONG` |
| `query` empty / not a string | — | 400 `QUERY_REQUIRED` |
| `history` | last 6 turns, 6000 chars total | silently trimmed, oldest first |
| each history turn | 1000 chars | silently truncated |
| `topK` | 6 | silently clamped |
| `sessionId` | `^[A-Za-z0-9_-]{1,64}$` | silently dropped |
| `documentIds` | 20 UUIDs, and requires the `chat:filter` scope | silently ignored |

### The 413 does not look like your other errors

The body limit is enforced by `express.json` **before** any of the route's own code runs, so
the response is generated by Express, not by a handler. It has a different shape: `error` is an
*object*, and there is no `success` and no `code`.

```json
{ "error": { "message": "request entity too large" } }
```

Malformed JSON in the body produces the same shape with a 400 and a parser message. Any error
normaliser that reads `body.error` as a string, or switches on `body.code`, gets `undefined`
for both of these — which is why the `ChatError` in [B4](#b4-sending-a-message) checks whether
`error` is an object before using it.

**What actually causes a 413 here:** history. A question is a few hundred bytes; six turns of
a conversation about a long document can be tens of kilobytes, and each turn is only truncated
at 1000 chars *after* the body has already been parsed. So the failure appears mid-conversation
on a widget that worked fine for the first few messages. The fix is the one in
[B7](#b7-managing-history) — send fewer turns — and the recovery is what `handleFailure` does:
on a 413, trim the local history and let the visitor resend.

### The silent clamps, and how to detect them

- **`topK`** above 6 is clamped, not rejected. Nothing in the response tells you; count
  `sources` if you need to know.
- **`sessionId`** is dropped if it contains anything outside `[A-Za-z0-9_-]`, and it is *only*
  used for log correlation — never as a rate-limit bucket, because a client-generated id an
  attacker can rotate for free would be a limiter that asks permission to be bypassed. If your
  ids contain a `:` or a `.`, they are being discarded and you will not notice until you try to
  trace a conversation in the logs.
- **`documentIds`** requires the `chat:filter` scope. Without it the field is dropped and the
  answer is drawn from the whole workspace — which looks identical to a filter that matched
  everything. Check `capabilities.filterByDocument` from `GET /config` before offering a
  document picker in your UI; that flag exists precisely so you can tell "this key cannot
  filter" from "the filter did nothing".
- **`history`** is trimmed oldest-first to fit both caps. The model therefore may not see the
  turn the visitor is referring to when they say "and the second one?".

Enforce the 1000-character query cap **client-side** as well. A `maxlength` on the textarea and
a live counter turn a round trip and a 400 into a disabled button.

## C5. Answers that are not answers

A 200 does not mean the visitor got what they asked for. There are two distinct
non-answers, both successful HTTP, and they read very differently to a user.

Both produce the same text — `NO_ANSWER_MESSAGE`:

> I could not find any relevant information in the uploaded documents to answer your question.

| | Retrieval found nothing | The model refused |
|---|---|---|
| What happened | no chunk cleared the relevance bar for this question | chunks were retrieved, but the model judged them insufficient and emitted its `NOT_IN_CONTEXT` sentinel |
| `chunksUsed` | `0` | greater than `0` |
| `sources` | `[]` | may be non-empty |
| Streaming | one `chunk` frame with the whole message, then `done` | same |

You can tell them apart from `chunksUsed`, and it is worth doing: the first usually means the
documents do not cover the topic, the second usually means they cover it badly — different
advice for the owner.

**A refusal never arrives after partial text.** The answer filter holds back the head of the
stream — at most a couple of dozen characters, imperceptible next to first-token latency —
until it has either matched the sentinel or clearly diverged from it. So a widget will never
render half a real answer and then have it replaced. You do not need to handle that case.

### Uploaded but not ready

Chunks only exist after a document finishes processing. A document sitting at `PROCESSING` (or
`FAILED`) contributes nothing, so a workspace whose upload is still running answers every
question with the no-answer message and looks completely broken. Before shipping, confirm the
owner has at least one document at `COMPLETED` — see [A3](#a3-upload-the-documents).

### Guardrail rejections are not retriable

`promptGuardrails` runs *after* the quota is spent and inspects the question itself. Three 400s
come out of it:

| `code` | Trigger |
|---|---|
| `PROMPT_INJECTION` | the question looks like an attempt to override the system prompt |
| `INVALID_CHARACTERS` | control characters, or other bytes that have no business in a question |
| `DEGENERATE_QUERY` | no real content — punctuation, a single repeated character, keyboard mashing |

Never retry these. The same text will always be rejected, the quota was already spent on the
first attempt, and the retry spends another. Show the visitor a rephrase prompt instead.

They also fire on legitimate input occasionally — a question that quotes an instruction
("what does the manual mean by 'ignore all previous steps'?") can look like injection. That is
the intended trade: this endpoint is open to the internet.

### Citations without sources

Under `sourceMode: 'hidden'` the answer text still carries its `[1]`, `[2]` markers while
`sources` comes back `[]`. Redaction happens *after* citation validation, so the markers are
real references to a list you are not being shown.

If the owner has chosen `hidden`, either strip `[n]` markers from the text before rendering or
leave them as inert plain text. Do not render them as links to nothing — and make sure your
marker-to-source lookup tolerates a miss, which is what the guard in
[B6](#b6-rendering-sources-and-citations) is for.

## C6. Streaming failures

Streaming trades a clean error contract for latency. Once `writeHead(200)` has gone out there
is no status code left to send, so **every** subsequent failure arrives as an SSE `error`
frame on a 200 response. Four consequences, all of which need code.

### The 200 is sent before retrieval runs

`streamAnswer` writes the headers, *then* calls the thunk that does retrieval and generation.
So `response.ok` being true tells you the middleware chain passed — key, origin, scope, quota,
guardrail — and nothing at all about whether an answer is coming.

This is deliberate: resolving retrieval first would let the route answer with an HTTP error
instead, which reads better but breaks clients already written against the event contract.

What it means for you: `if (!response.ok) throw` is still correct and still necessary — a 401,
403, 429 or 400 on a `stream: true` request comes back as ordinary JSON, not as SSE — but do
not treat passing that check as "the answer started".

### An `error` frame can be the first frame

The failure order is: headers → `sources` → `chunk`… → `done`. If retrieval throws, the
`error` frame arrives with no `sources` and no `chunk` before it. If generation throws
mid-answer, it arrives *after* text you have already rendered.

The frame carries no `code` — only prose:

```
event: error
data: {"error":"An error occurred while generating the answer."}
```

Handle both positions:

- **No text yet** — replace the pending bubble with a failure state and offer retry.
- **Partial text already rendered** — keep it, mark it incomplete, and do not silently retry.
  Re-sending spends quota again and the visitor will get a second, differently-worded partial
  answer appended to the first. That is what the `incomplete` flag in
  [B8](#b8-a-complete-drop-in-widget) is for.

### The stream can end without `done`

`done` is the only signal that an answer is complete. A dropped connection, a proxy timeout, a
laptop lid closing — none of them send anything. Your reader loop exits, and if you only clear
the pending state inside the `done` handler, the bubble spins forever.

Clear pending state in a `finally`, not in `onDone`, and treat "loop ended without `done`" as
the same incomplete case as an `error` frame after partial text.

### Proxy buffering

The relay sets `X-Accel-Buffering: no` because nginx buffers proxied responses by default,
which holds every token until the answer is finished and defeats the whole point. That header
handles nginx. It does not handle every CDN, corporate middlebox, or `compression()` middleware
someone adds later.

The symptom is unmistakable: the whole answer appears at once after a long pause, then `done`.
Everything still *works*, so nothing errors — which is why it survives to production. If you
see it, the fix is server-side or infrastructure-side, not in the widget. Test through your
real CDN, not just against localhost.

### Aborting

Always keep the `AbortController` and abort it when the panel closes or the component
unmounts. Two reasons: the request keeps streaming into nothing otherwise, and the
`AbortError` it raises must be distinguished from a real failure — `if (error.name ===
'AbortError') return`, before any error rendering. An abort is not something to tell the
visitor about.

Aborting does **not** refund the quota. It was spent when the request passed
`enforceQuota`, long before the first token.

## C7. The browser environment

Failures that have nothing to do with this API and everything to do with the page your widget
was dropped into. You do not control that page — your customer's marketing team does.

### `EventSource` cannot be used

The browser's built-in SSE client only issues `GET` requests and cannot set custom headers. The
chat endpoint is a `POST` and needs `X-Api-Key`. So streaming has to be read from a `fetch`
body with a `ReadableStream` reader, which is what [B5](#b5-streaming-the-answer) does.

Consequences of not having `EventSource`: no automatic reconnection, no `Last-Event-ID`
resumption, and you must parse the frames yourself. There is no partial-answer resume — a
dropped stream means resending the question, which spends quota again.

### Never send credentials

`credentials: 'include'` on any request to this API is a mistake. The public router sets
`credentials: false`, so the browser will reject the response outright and you will see a CORS
error that looks like a server misconfiguration. It is not — it is the design. A widget embedded
on a third-party page must not be able to make the visitor's browser attach cookies to this
API.

Do not add `withCredentials`, do not set cookies on the API's domain, and do not try to carry
visitor identity in one. `sessionId` in the request body is the whole identity mechanism, and
it is for log correlation only.

### CSP on the customer's site

If the customer's site sends a `Content-Security-Policy`, your widget's requests are subject to
it. Two directives matter:

| Directive | Needs | Symptom if missing |
|---|---|---|
| `connect-src` | your API origin | every `fetch` is blocked before it leaves the page; console says "Refused to connect" |
| `script-src` | wherever the widget bundle is served from | the widget never loads at all |

A CSP block is not an HTTP failure. `fetch` rejects with a `TypeError`, there is no status, no
response, and no body. Your error handler must survive an error object with `status`
`undefined`.

Give integrators the exact line to add:

```
connect-src 'self' https://api.yourdomain.com;
```

### `TypeError: Failed to fetch` has no status

Four separate causes produce this same statusless rejection, and none of them reach your
server:

- the visitor is offline, or the API is unreachable
- a CSP `connect-src` block
- an ad-blocker or privacy extension matching the request (a URL containing `chat`, `widget` or
  `analytics` attracts filter lists; so does a third-party domain on a tracker list)
- a corporate proxy interposing and failing

There is nothing to distinguish them from the browser, and your code cannot fix any of them.
Fail closed and quiet: no error text on the customer's page, one `console.warn` for whoever is
debugging. This is why [B3](#b3-bootstrap-get-config) treats a failed bootstrap as "do not
render the launcher" rather than "render an error".

Design for the widget being *absent*, not broken. A chat bubble that opens onto an error
message is worse for your customer's page than no chat bubble at all.

### Storage inside an iframe

If the widget runs in a cross-origin iframe, modern browsers partition `localStorage` and
`sessionStorage` by the top-level site — and some block third-party storage entirely. A
`sessionId` persisted to `localStorage` may therefore be unavailable, or silently different per
embedding site. `localStorage.setItem` can even throw (`QuotaExceededError`) in a partitioned
or private context.

Generate the `sessionId` in memory per page load, as the examples above do, and treat any
persistence as an optimisation that is allowed to fail. Wrap it in try/catch or skip it.

## C8. Server and infrastructure

### Redis is a hard dependency for public chat, and `/ready` does not say so

`GET /ready` computes readiness as `postgres === 'up' && vectorStore === 'up'`. Redis is
reported in `dependencies` but **not** part of the verdict, because caching is best-effort for
the dashboard.

Public chat is the exception: `enforceQuota` fails closed, so with Redis down every widget
request is a 503 `QUOTA_UNAVAILABLE` while `/ready` cheerfully returns `200 {"ready":true}`.

If you run health checks or a status page, read the nested field, not the top-level flag:

```bash
curl -s $API/ready | jq '.dependencies.redis'
```

Anything other than `"up"` there means the widget is down regardless of what `ready` says.

### `WORKSPACE_UNAVAILABLE`

404, from both `/config` and `/chat`. The key resolved — so it is a real, live key — but the
workspace row behind it is gone. A cached key record can briefly outlive its tenant, so this is
a real possibility rather than an impossibility worth ignoring.

Treat it as fatal, like a revoked key. The widget should disappear, not retry: there is no
workspace for the question to be answered from and nothing will change that within the page's
lifetime.

### Upstream provider failures

503 `SERVICE_UNAVAILABLE` covers every failure at the embedding, rerank, LLM or vector-store
layer, and it deliberately does **not** name the provider. Two reasons: a visitor can do nothing
with "the embedding vendor is down", and the identity of your infrastructure vendors is not
something the workspace owner agreed to publish on their website.

For the widget this is retriable but not aggressively so. One retry after a few seconds; if it
fails again, fail closed. The server-side logs carry the real cause with the provider named — if
you are the operator, look there rather than trying to infer it from the response.

### 504 `TIMEOUT`

The pipeline exceeded its budget. A rerank stage plus generation over a long context can run
long on a big corpus, and the abort fires rather than holding the connection open.

The response text already contains the useful advice — "Try a shorter or more specific
question" — so surface it. A blind retry of the same question will usually time out again,
because the cost is a property of the question and the corpus, not of luck.

Note that a `stream: true` request cannot produce a 504: the 200 has already been sent, so a
timeout mid-generation arrives as an SSE `error` frame instead. Same cause, different shape.

### One more asymmetry worth knowing

The dashboard and the widget do not share a failure profile at all. The dashboard degrades
gracefully when Redis is down (caching stops, token blacklisting fails open, `todayUsed` reads
`null`); the widget stops entirely. If you are building both, do not test the widget's
resilience by exercising the dashboard's.

## C9. Owner dashboard edge cases

These are the other half of the integration — the authenticated app where the owner mints keys.
Different credential, different failure modes.

### The token-replacement trap

`tenantId` is a **claim inside the access token**, not something looked up per request. So
`POST /api/tenants` — creating the workspace — changes a fact the token has already frozen. The
response returns a fresh token pair for exactly this reason.

If you keep using the old access token after creating a workspace, every workspace-scoped call
fails with 403 `TENANT_REQUIRED` even though the workspace demonstrably exists. It looks like a
server bug and it is not.

**Replace both stored tokens from the workspace-creation response**, not just the access token.
This is the single most common integration failure in Part A.

### `TENANT_REQUIRED` vs `TENANT_MISMATCH`

| Code | Status | Meaning | What the UI does |
|---|---|---|---|
| `TENANT_REQUIRED` | 403 | the token carries no `tenantId` | route to the create-workspace screen — or refresh the token first, per the trap above |
| `TENANT_MISMATCH` | 403 | the `:tenantId` in the URL is not the caller's | a real bug in your URL construction, or a stale link after an account switch |

Note that neither is a 401, so a naive "on 401, refresh the token" interceptor will not catch
them — and refreshing is in fact the right response to one of the two.

### Token refresh

| Code | Status | Meaning |
|---|---|---|
| `TOKEN_EXPIRED` | 401 | the access token aged out — refresh and replay the request |
| `TOKEN_REVOKED` | 401 | blacklisted by a logout — send the user to sign-in, do not refresh |

Three of `authenticate`'s 401s carry **no** `code` at all (missing header, malformed token,
non-expiry verification failure). An interceptor that switches only on `code` will fall through
on those. Branch on the status first, use the code to refine.

Two more things about refresh:

- **Guard against a refresh storm.** Five requests failing `TOKEN_EXPIRED` at once will fire
  five refreshes; the later ones may race the earlier ones' token rotation. Keep a single
  in-flight refresh promise and have every caller await it.
- **The old refresh token is not blacklisted on refresh.** It remains usable until it expires on
  its own. Discard it in the client; do not rely on the server to have killed it.
- **Logout is best-effort.** Blacklisting lives in Redis and fails open, so with Redis down a
  logout returns success while the access token keeps working until it expires naturally. Clear
  local storage regardless — client-side state is the part you control.

### Key management screens

- **`todayUsed` can be `null`.** `GET /api/tenants/:id/api-keys/:keyId/usage` returns `null`
  rather than `0` when Redis is unreachable, deliberately: showing "0 of 500 used" during an
  outage is a lie an owner would act on. Render "unavailable", not a zero.
- **A non-UUID `:keyId` is a 500, not a 404.** The route does not format-validate the parameter,
  so the database rejects the cast. Validate the id in your UI before calling.
- **Widget config `PUT` is last-write-wins and its 400s carry no `code`.** Two tabs open means
  the second save silently clobbers the first, and the validation errors have only a message.
  Surface the message string.
- **Rate-limit headers on the owner API are unreadable from a browser.** The global CORS config
  sets no `exposedHeaders`, so `RateLimit`, `RateLimit-Policy` and `Retry-After` are all
  invisible cross-origin. That is why the owner 429 body carries `retryAfterSeconds` — read it
  from the payload. A shared retry helper needs to check the header *and* the body field,
  because the public API does the opposite.

---

# Part D — Going live

## D1. Test matrix

Every row is reproducible without breaking anything, and every row corresponds to a failure
that has a real chance of reaching production unnoticed. The "expected" column is what your
widget should do, not what the server returns.

### Credential and origin

| # | How to reproduce | Server response | Expected widget behaviour |
|---|---|---|---|
| 1 | Delete the `X-Api-Key` header | 401 `API_KEY_MISSING` | no launcher, one `console.warn`, no retry |
| 2 | Truncate the key by one character | 401 `API_KEY_INVALID` | as above |
| 3 | Revoke the key, then send a message | 401 `API_KEY_REVOKED` | widget disappears, no retry |
| 4 | Rotate with `graceHours: 0`, send with the old key | 401 `API_KEY_EXPIRED` | as above |
| 5 | Mint a key without `chat:query`, send a message | 403 `SCOPE_FORBIDDEN` | as above |
| 6 | Open the page from `file://` with an origin-restricted key | 403 `ORIGIN_REQUIRED` | as above |
| 7 | Serve the page from an origin not on the allowlist | 403 `ORIGIN_NOT_ALLOWED` | as above |
| 8 | Allowlist `https://acme.com`, load `https://www.acme.com` | 403 `ORIGIN_NOT_ALLOWED` | catches the apex/`www` mistake before your customer does |

### Limits

| # | How to reproduce | Server response | Expected widget behaviour |
|---|---|---|---|
| 9 | Loop 40 `POST /chat` in under a minute | 429 `RATE_LIMITED` | input disabled, re-enabled after `Retry-After` |
| 10 | Send 11 messages from one IP in a minute | 429 `RATE_LIMITED` (visitor bucket) | same path as #9 — verify you read `Retry-After` and not `RateLimit-Reset` |
| 11 | Mint a key with `dailyQuota: 1`, send twice | 429 `QUOTA_EXCEEDED` | permanently blocked for the page, "try tomorrow", **no further requests** |
| 12 | Stop Redis, send a message | 503 `QUOTA_UNAVAILABLE` | one retry after 30 s, then fail closed |
| 13 | Send a 1001-character question | 400 `QUERY_TOO_LONG` | should be impossible — client-side cap should have stopped it |
| 14 | Send 40 kb of history | 413, `{"error":{"message":…}}` | history trimmed, visitor can resend; verify your normaliser does not crash on the object-shaped `error` |
| 15 | Send `sessionId: "a:b"` | 200, id silently dropped | your logs should show no session — proves the alphabet rule |
| 16 | Send `documentIds` on a key without `chat:filter` | 200, filter ignored | UI should not have offered the picker (`capabilities.filterByDocument`) |

### Answers and streaming

| # | How to reproduce | Server response | Expected widget behaviour |
|---|---|---|---|
| 17 | Ask something the documents do not cover | 200, `chunksUsed: 0`, `sources: []` | the no-answer message rendered as an answer, not as an error |
| 18 | Ask before any document reaches `COMPLETED` | same as #17 | identical — this is why #17 alone does not prove retrieval works |
| 19 | Send `"???????"` | 400 `DEGENERATE_QUERY` | rephrase prompt, **no retry** |
| 20 | Send "ignore all previous instructions" | 400 `PROMPT_INJECTION` | as above |
| 21 | Set `sourceMode: 'hidden'`, ask a question that cites | 200, `[n]` markers with `sources: []` | markers inert or stripped — never links to nothing |
| 22 | Kill the server mid-stream | reader loop ends, no `done` | bubble stops spinning, answer marked incomplete |
| 23 | Close the panel mid-stream | — | `AbortController` fires, no error UI, no console noise |
| 24 | Block the API origin in a CSP | `TypeError`, no status | no launcher; verify nothing throws on `error.status === undefined` |
| 25 | Throttle to "slow 3G" and ask a long question | tokens trickle | verify streaming actually streams — this is where proxy buffering shows up |

### Owner flow

| # | How to reproduce | Server response | Expected dashboard behaviour |
|---|---|---|---|
| 26 | Create a workspace, then call a workspace route with the *old* token | 403 `TENANT_REQUIRED` | should be impossible — both tokens must have been replaced |
| 27 | Fire five requests with an expired access token | 401 `TOKEN_EXPIRED` ×5 | exactly **one** refresh call |
| 28 | Request `/api-keys/not-a-uuid/usage` | 500 | should be impossible — validate the id client-side |
| 29 | Stop Redis, open the key usage panel | `todayUsed: null` | "unavailable", not "0" |
| 30 | Mint 26 keys | 409 `KEY_LIMIT_REACHED` | clear message; then rotate one and note the count can read 26 |

Rows 13, 16, 26 and 28 are the ones whose "expected" is *should be impossible*. If you can
reproduce them, the bug is on your side — which is the point of including them.

## D2. Go-live checklist

Run through this with the customer's key, on the customer's real page, over the customer's real
CDN. Localhost proves almost none of it.

**The key**

- [ ] Type is **public** (`pk_live_…`). No `sk_live_…` has ever been in a browser bundle, a
      committed file, or a client-side environment variable.
- [ ] Scopes are the minimum: `chat:query` and `chat:config`. `chat:filter` only if the UI has
      a document picker.
- [ ] `allowedOrigins` is **not empty** — an empty allowlist means every origin, including
      `curl`.
- [ ] Both the apex and `www` are listed if the site serves both.
- [ ] Staging and production use **different keys**, so revoking one does not take down the
      other.
- [ ] `dailyQuota` is set deliberately, sized to expected traffic rather than left at the
      default. This is the real cost ceiling; the origin allowlist is not.

**The workspace**

- [ ] At least one document is `COMPLETED`, not `PROCESSING` or `FAILED`.
- [ ] A handful of real questions from the customer's own support queue return grounded answers,
      not the no-answer message.
- [ ] `sourceMode` matches what the customer is willing to show a stranger — `full` exposes
      document names and text excerpts on their public site.
- [ ] Widget title, greeting, placeholder and suggestions are the customer's words, not the
      defaults.

**The integration**

- [ ] The key is sent as the `X-Api-Key` **header**, never a query parameter.
- [ ] No `credentials: 'include'` anywhere.
- [ ] A failed `GET /config` hides the launcher instead of rendering an error on the customer's
      page.
- [ ] Send is disabled while a request is in flight — there is no idempotency key, so a
      double-click costs two messages of quota.
- [ ] `Retry-After` is honoured on 429; `QUOTA_EXCEEDED` sets a sticky blocked state that stops
      sending entirely.
- [ ] The error normaliser survives all four response shapes: handler JSON with a `code`, the
      object-shaped `error` with no `code` (413 / bad JSON), a bare 404, and a non-JSON body
      from a proxy.
- [ ] `error.status === undefined` is handled — that is a CSP block, an ad-blocker, or an
      offline visitor.
- [ ] `AbortController` aborts on close and unmount, and `AbortError` is filtered out before any
      error rendering.
- [ ] Pending state clears in a `finally`, so a stream that ends without `done` does not spin
      forever.
- [ ] History is capped client-side (6 turns is the server's limit anyway) and trimmed on a 413.
- [ ] The query length cap is enforced in the input, not discovered via a 400.

**The environment**

- [ ] The customer's CSP lists your API origin in `connect-src`.
- [ ] Streaming actually streams through the real CDN — not one burst at the end.
- [ ] `X-Forwarded-For` is correct through every proxy hop, or every visitor shares one
      rate-limit bucket.
- [ ] `curl -s $API/ready | jq '.dependencies.redis'` reads `"up"`. The top-level `ready` flag
      ignores Redis, and public chat fails closed on it.
- [ ] Monitoring alerts on `dependencies.redis` and on a rate of 503 `QUOTA_UNAVAILABLE`, not
      just on `/ready`.

**Operational readiness**

- [ ] Someone knows the rotation procedure and that `graceHours` is a deadline: the old key stops
      working when the window closes whether or not the site was redeployed.
- [ ] A key rotation has been rehearsed once on staging, end to end, including the redeploy.
- [ ] The widget's `console.warn` includes `error.code`, so a support ticket becomes a one-minute
      diagnosis instead of "chat is broken".

---

Anything unclear about a specific field, status code or limit is in
[API_REFERENCE.md](API_REFERENCE.md). Anything unclear about *why* a mechanism exists is in
[API_KEY_IMPLEMENTATION.md](API_KEY_IMPLEMENTATION.md).
