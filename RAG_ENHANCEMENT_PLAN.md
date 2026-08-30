# RAG System Enhancement Plan

**Prepared** 2026-08-31 — backend audit of the DocMind RAG service.

Every number in this document was measured against the live system on
2026-08-31: Pinecone index `rag-index`, the Voyage API, and the NVIDIA NIM
`/v1/chat/completions` endpoint, using the credentials already in `.env`.

## Agreed constraints

| Decision | Value |
| --- | --- |
| Scope | Phases 0 through 4 |
| Reindex of existing vectors | Not permitted |
| `.env` repair | Owner handles line 3 |

Because a reindex is off the table, the Phase 2 parser and chunker changes
apply to new uploads only, behind a `chunkingVersion` marker, and retrieval
must serve the old and new chunk formats side by side. The Phase 1 Postgres
chunk table is populated by copying text out of existing Pinecone metadata,
which re-embeds nothing and modifies no vector.

---

## 1. Findings

### 1.1 The server cannot boot

`.env:3` reads `DATABASE_URL=DATABASE_URL=postgresql://…`, so
`process.env.DATABASE_URL` carries the key name inside its own value.
Sequelize's URL parser returns `null` for the protocol and
`src/services/db.js:6` throws at module load, before `app.js` reaches
`sequelize.authenticate()`. It is the only malformed line of the twelve.

### 1.2 The similarity threshold rejects every chunk

`MIN_SIMILARITY_SCORE = 0.5` in `src/rag/ragEngine.js:6`. Measured against
the live index:

| probe | top-15 cosine range | chunks passing 0.5 |
| --- | --- | --- |
| "what is the main conclusion" | 0.208 → 0.179 | 0 / 15 |
| "summarize the key requirements" | 0.312 → 0.239 | 0 / 15 |
| query built from verbatim stored chunk text | 0.705 → 0.576 | 10 / 15 |

Natural questions top out near 0.31; only pasting document text back at the
index clears 0.5. `retrieveContext` therefore returns an empty array and
users see "I could not find any relevant information in the uploaded
documents" for essentially every real question.

The absolute cosine gate is the wrong instrument at any value. Ranks 1
through 8 span 0.312 to 0.244 — a 0.07 band — so cosine ordering within the
candidate set carries little signal.

### 1.3 A fresh deployment would fail on first upload

`src/rag/vectorStore.js:28` creates the index with `dimension: 768`.
`src/services/embeddingService.js:5` emits 1024. The live index is already
1024, so this is latent rather than active, but any new environment or
renamed index creates a 768 index and every upsert fails.

Live index state, for reference:

| property | value |
| --- | --- |
| name | `rag-index` |
| dimension | 1024 |
| metric | cosine |
| type | dense |
| vectors | 1838 across 5 tenant namespaces |

### 1.4 Reranking recovers chunks the current pipeline cannot see

`rerank-2.5` run against the live corpus with the existing
`VOYAGE_API_KEY`, retrieving 30 and reranking to 6:

| rerank rank | relevance | original ANN rank | ANN cosine |
| --- | --- | --- | --- |
| 1 | 0.5430 | 9 | 0.2399 |
| 2 | 0.5156 | 2 | 0.2804 |
| 3 | 0.4688 | 7 | 0.2469 |
| 4 | 0.4531 | 3 | 0.2725 |
| 5 | 0.4531 | 13 | 0.2388 |
| 6 | 0.4297 | 29 | 0.2221 |

Four of the six best chunks sit outside the current top-6 window, and the
single most relevant chunk was at ANN rank 9 — unreachable at `topK = 5`.
Cost: 774 ms and 20281 rerank tokens. Relevance scores also spread usefully
across 0.54 to 0.43, which yields a threshold with real meaning.

### 1.5 Latency budget

| stage | measured |
| --- | --- |
| Voyage query embedding | 372–496 ms |
| Pinecone ANN, `topK=5`, metadata on | 283–681 ms |
| Pinecone ANN, `topK=30`, metadata on | 1622–2772 ms |
| `rerank-2.5`, 30 candidates | 774 ms |
| LLM, current model | 304–4828 ms |

Wide retrieval is expensive only because roughly 100 KB of chunk text
travels back from Pinecone. Chunk text has to live locally for a two-stage
pipeline to pay off, which is what motivates the Postgres chunk table in
Phase 1.

### 1.6 Chunk quality

Measured over a 200-vector sample: minimum 2630 chars, median 3299, p95
3899, maximum 4217. A separate probe surfaced one chunk of 15864 chars.

`createChunks` in `src/services/documentService.js:17` splits on whitespace
into fixed 500-word windows with 70-word overlap. Consequences:

- Every boundary falls mid-sentence. No paragraph or heading awareness.
- Every document ends with a runt chunk. A 505-word document yields chunks
  of 500 and 75 words, and the 75-word chunk still competes in retrieval.
- Page boundaries are destroyed by `src/services/documentService.js:49-60`,
  which flattens every page through `items.map(i => i.str).join(' ')`.
  Citations consequently cannot reference a page.
- `MAX_CHUNK_CHARS = 8000` in `src/services/embeddingService.js:14`
  truncates the embedding input while the full text is still stored as
  metadata. For the 15864-char chunk, 7864 characters were never seen by
  the embedder, so the retrieved text is not the text that was matched.

### 1.7 Generation model comparison

Every plausible text model on the account's NVIDIA key, tested against a
three-source grounding, citation, conflict and refusal contract:

| model | status | latency | behaviour |
| --- | --- | --- | --- |
| `meta/llama-3.2-11b-vision-instruct` (current) | works | 0.3–4.8 s | cites and refuses correctly; drifts from `[1]` to `[Source 3]`; misses the conflict |
| `nvidia/nemotron-3-super-120b-a12b` | works | 5.3–6.2 s | only model that flagged the conflict and preferred the newer source |
| `meta/llama-3.2-90b-vision-instruct` | works | 5.0–12.4 s | correct, no conflict flag |
| `openai/gpt-oss-120b` | works | 25–39 s | too slow to use; emits `【1】` full-width brackets that break citation parsing |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | works | ~5 s | leaks chain-of-thought into the answer |
| `nvidia/llama-3.1-nemotron-70b-instruct` | 404 | — | listed by `/v1/models`, not deployed |
| `nvidia/llama3-chatqa-1.5-70b` | 404 | — | listed, not deployed |
| `nvidia/nemotron-nano-3-30b-a3b` | 404 | — | listed, not deployed |
| `mistralai/mistral-large-2-instruct` | 404 | — | listed, not deployed |
| `mistralai/mistral-nemotron` | 504 | 302 s | times out |

Keep the current model as the default, since it is by a wide margin the
fastest that honours the contract. Add `nemotron-3-super-120b-a12b` as an
opt-in accuracy mode. Pin the citation format with a worked example,
because the 11B model drifts away from it.

### 1.8 Smaller findings

- `src/api/query.js:25-37` still maps errors by matching on `Ollama` and
  `Groq`. Both providers are gone, so Voyage and NVIDIA failures fall
  through to a generic 500.
- `embeddingModel: 'nomic-embed-text'` is hardcoded at
  `src/api/document.js:79` and as the column default at
  `src/models/Document.js:53`. Every row is mislabelled.
- `src/api/health.js`, `src/middleware/errorHandler.js`,
  `src/middleware/guardrails.js` and `src/middleware/validator.js` exist
  but are wired into nothing. The last two are no-op stubs.
- `initPinecone()` is fire-and-forget at `src/app.js:53`, so early
  requests race it and receive a 503.
- `p-limit` is a declared dependency that is never imported.
- Redis is connected but used only for the JWT blacklist.
- Uploading the same PDF twice duplicates its vectors. The
  `(tenantId, contentHash)` index exists but is not unique.
- There is no delete path for a document, so vectors only accumulate.
- `Tenant.findByPk` runs on every query and upload
  (`src/api/query.js:58`, `src/api/document.js:60`) even though
  `requireTenant` has already proved the tenant from the JWT.
- Uploads embed synchronously. An 825-chunk document is 42 sequential
  batches, each followed by an unconditional 500 ms cooldown, on a single
  held-open HTTP request.
- `sequelize.sync({ alter: true })` runs on every boot (`src/app.js:48`).
- No rate limit on `/query`, no `express.json` size limit, no `helmet`.
- `voyageApiKey` is absent from `src/config.js` while every other key is
  present, and `embeddingService` throws at import when the key is missing,
  which takes down the whole process rather than one request.

---

## 2. Phase 0 — Unblock and correct

- Replace the cosine gate in `src/rag/ragEngine.js:6` with a rerank
  relevance gate, using an interim absolute floor of 0.15 until Phase 1
  lands.
- Derive the created index dimension from `EMBEDDING_DIMENSION` in
  `src/rag/vectorStore.js`, and assert at boot against
  `describeIndex().dimension`, failing loudly on mismatch.
- Rewrite the error mapping in `src/api/query.js:25-37` for Voyage,
  NVIDIA and Pinecone.
- Record the real embedding model and dimension on upload
  (`src/api/document.js:79`, `src/models/Document.js:53`).
- Add `voyageApiKey` to `src/config.js` and move the missing-key check off
  module scope in `src/services/embeddingService.js`.
- Wire `health.js` and `errorHandler.js` into `src/app.js`, and gate
  readiness on `initPinecone()` instead of letting it float.

## 3. Phase 1 — Retrieval

- Two-stage retrieval: ANN `topK=40` with `includeMetadata: false`,
  hydrate text locally, `rerank-2.5`, keep the top 6.
- New `document_chunks` table: `id` matching the vector id, `tenantId`,
  `documentId`, `chunkIndex`, `page`, `text`, `tsv`. Backfilled by copying
  text out of existing Pinecone metadata. Nothing is re-embedded and no
  vector is modified, so this respects the no-reindex constraint.
- Hybrid retrieval: a Postgres `tsvector` lane fused with the dense lane by
  Reciprocal Rank Fusion, then reranked. This is what recovers exact
  identifiers, acronyms and figures that dense embeddings smear.
- Near-duplicate suppression, since the 70-word chunk overlap currently
  spends context window on repeated text.
- `documentIds` filter passthrough so the UI can scope a question to a
  chosen subset of files.

## 4. Phase 2 — Parsing and chunking

New uploads only, behind a `chunkingVersion` column, so retrieval can serve
both formats while the existing vectors remain valid.

- Rebuild PDF extraction in `src/services/documentService.js`: use
  `item.hasEOL` to restore line structure, retain per-page text so
  citations can name a page, de-hyphenate line-end breaks, and drop headers
  and footers that repeat across pages.
- Replace the fixed 500-word splitter with a recursive splitter over
  paragraph, line, sentence and then word boundaries. Target roughly 1400
  chars with 200-char overlap, and merge any tail below 40% of target into
  its predecessor.
- Prepend a `filename › page N › heading` breadcrumb to each chunk before
  embedding.
- Remove the silent truncation at `src/services/embeddingService.js:14`.
  Enforce size at chunk creation and split oversized chunks rather than
  truncating them, so stored text always equals embedded text.

Deferred: `voyage-context-4` contextualized chunk embeddings would be the
largest single quality gain available, but it requires non-overlapping
chunks and a full reindex. Parked until a reindex is acceptable.

## 5. Phase 3 — Prompting

- Rewrite the system prompt at `src/services/llmService.js:13-22`: an
  explicit `[1]` citation contract with a worked example and a counter
  example, permission to answer partially, a source-conflict rule, and an
  explicit instruction not to draw on prior knowledge. Context is currently
  labelled `[Source n]` but the model is never asked to cite, so the answer
  text and the source panel in the UI are unlinked.
- Collapse the two divergent "not found" strings at
  `src/rag/ragEngine.js:44` and `src/services/llmService.js:18` into one
  shared constant.
- Add conversation history plus history-aware query rewriting. Every turn
  is currently independent, so a follow-up such as "what about the second
  one?" retrieves nothing.
- Validate citations after generation: parse `[n]` from the answer and drop
  sources that were never cited from the response payload.
- Move model id, temperature, `max_tokens`, `topK` and every threshold out
  of module constants into `src/config.js`.

## 6. Phase 4 — Latency, cost, robustness

- Redis caches: query embeddings keyed by model, input type and text hash;
  answers keyed by tenant, document-set version and normalised query;
  rerank results keyed by query and candidate id set.
- Parallelise embedding batches with the already-installed `p-limit` at
  concurrency 4, and drop the unconditional cooldown, retaining it only
  after a 429.
- Make upload asynchronous: return 202 with a `documentId`, process in the
  background, expose a status endpoint. The `status`,
  `processingStartedAt` and `processingCompletedAt` columns already exist
  for exactly this.
- Unique index on `(tenantId, contentHash)`, returning the existing
  document instead of re-embedding a duplicate.
- `DELETE /documents/:id`, removing Postgres rows and Pinecone vectors
  together.
- Drop the redundant `Tenant.findByPk` lookups.
- Rate-limit `/query`, add an `express.json` size limit, add `helmet`.
- Replace `sequelize.sync({ alter: true })` with migrations.
- Implement or delete the `guardrails.js` and `validator.js` stubs. If
  guardrails are wanted, `nvidia/llama-3.1-nemoguard-8b-content-safety` and
  `meta/llama-guard-4-12b` are live on the current key.

---

## 7. References

- Voyage reranker API —
  https://docs.voyageai.com/reference/reranker-api
- Voyage contextualized chunk embeddings —
  https://docs.voyageai.com/reference/contextualized-embeddings-api
- Voyage flexible dimensions and quantization —
  https://docs.voyageai.com/docs/flexible-dimensions-and-quantization
- voyage-context-4 release notes —
  https://www.mongodb.com/company/blog/product-release-announcements/voyage-context-4-stop-worrying-about-chunking-with-our-best-performing-model
- Voyage text embedding models —
  https://www.mongodb.com/docs/voyageai/models/text-embeddings/

---

## 8. Progress

| Phase | Status |
| --- | --- |
| 0 — Unblock and correct | done |
| 1 — Retrieval | done |
| 2 — Parsing and chunking | done, new uploads only |
| 3 — Prompting | done |
| 4 — Latency, cost, robustness | done |

### What landed

**Phase 0.** Shared `NO_ANSWER_MESSAGE` / `NO_ANSWER_SENTINEL`; every model
id, temperature, token budget and threshold moved into `src/config.js`;
Pinecone option-object call signatures corrected. `src/services/db.js` now
validates `DATABASE_URL` before handing it to Sequelize and names the fault —
missing, duplicated key prefix, or wrong scheme — because Sequelize's own
"Dialect needs to be explicitly supplied" points at the code rather than at the
line of `.env` responsible. Finding 1.1 would have been a one-glance diagnosis
with this in place.

**Phase 1.** Two-stage retrieval in `src/rag/retriever.js` — wide ANN recall,
text hydrated from Postgres, `rerank-2.5` cross-encoder, dual absolute and
relative score gates. A Postgres full-text lane over a GIN expression index
(`src/rag/chunkStore.js`) fused with the dense lane by Reciprocal Rank Fusion,
plus trigram near-duplicate suppression (`src/rag/ranking.js`). The index is
created at boot, non-fatally, so a failure degrades to dense-only.

**Phase 2.** `src/rag/chunker.js` reconstructs lines from pdf.js item
geometry, de-hyphenates, normalises invisible characters, removes running
headers and footers, then splits recursively at ~1400 chars with a 200-char
overlap snapped to a sentence or word boundary. Headings become breadcrumbs
(`report.pdf › page 4 › Revenue`) that reach the citation label. Applies to
new uploads only; chunks carry `chunkingVersion` so the mixed corpus stays
readable. `npm run backfill:chunks` copies existing Pinecone metadata into
`document_chunks` with no re-embedding.

**Phase 3.** Citation contract with a worked example and counter-example;
post-generation citation validation on both the buffered and streaming paths;
sentinel-based refusal handling; conversation history; and history-aware query
rewriting (`src/rag/queryRewriter.js`) behind a heuristic gate, so retrieval
runs against a standalone question while generation still sees what the user
typed.

**Caching.** Embedding, rerank, answer and rewrite caches in
`src/services/cacheService.js`, keyed against a per-tenant corpus-version
counter so an upload or delete invalidates stale answers without a key scan.
Every cache operation is best-effort.

**Phase 4.** Upload is now asynchronous. `POST /documents` hashes the file,
short-circuits a duplicate, writes a `PENDING` row and answers **202** in
milliseconds; `src/services/ingestionService.js` runs parse → embed → upsert →
chunk rows behind a `p-limit(2)` queue with a bounded backlog, and records
`COMPLETED` or `FAILED` on the row the client polls at
`GET /documents/:id`. The queue never throws — the caller is fire-and-forget,
so an unhandled rejection would take the process down — and its failure path
cleans Pinecone and Postgres independently before marking the row.

Deduplication is a **partial** unique index on `(tenantId, contentHash)`
restricted to `status = 'COMPLETED'`, so a retry of a FAILED document is still
allowed. A race between two identical uploads is resolved by catching the
unique violation and returning the winner rather than 500-ing.

`DELETE /documents/:id` removes vectors, then chunk rows, then the document,
then bumps the corpus version. That order is deliberate: a vector outliving its
chunk row is merely unreachable, whereas a chunk row outliving its vector is a
lexical hit that can never be reranked. Vector ids are collected from both the
recorded `totalChunks` and a Pinecone prefix listing, so a document whose
`totalChunks` is stale still deletes fully. The route refuses with **409** while
a document is still processing, because the queued job writes by
`(id, tenantId)` and would otherwise resurrect orphaned vectors.

Four rate-limit tiers in `src/middleware/rateLimit.js`, keyed by user id with an
IPv6-normalised IP fallback; `helmet` with the HTML-oriented defaults off; a
1 MB `express.json` ceiling. Health checks are deliberately exempt from every
limiter — a load balancer polling `/ready` must never be throttled into
reporting the service down.

`guardrails.js` became a real deterministic injection pre-filter: phrase-level
override patterns, forged `system:`/`assistant:` scaffolding, a planted
`NOT_IN_CONTEXT` sentinel, control characters, bidi overrides and degenerate
repetition. It is not a content-safety classifier and does not judge whether a
question is appropriate. Rule 8 of the system prompt now states that source text
is data and never instruction. `validator.js` was deleted as an unreferenced
no-op.

`sequelize.sync({ alter: true })` is no longer the schema mechanism. Umzug
migrations are, serialized by `pg_advisory_xact_lock` inside a transaction so
concurrent instances cannot race, with an idempotent baseline that is correct
both on a fresh database and on the existing sync-created one, and a second
migration owning the two indexes `sync` cannot express. `sync({ alter: true })`
survives behind `DB_SYNC_ALTER`, off by default, because it silently drops the
partial and expression indexes retrieval depends on.

### Frontend contract change

The upload response changed shape and the sibling `RAG-Frontend` app needs to
follow: **202** with `documentId` / `statusUrl` / `queuePosition` and polling
instead of a synchronous **201**, plus **200** with `duplicate: true`, **413**
oversize, **415** non-PDF, **503** `INGESTION_BUSY`, and **409**
`DOCUMENT_BUSY` on a delete during processing. The `/query` SSE `sources` event
now also carries `searchQuery` and `rewritten`.

### Not verified

Nothing has been exercised against live Postgres, Redis or Pinecone: `.env:3`
carries a duplicated `DATABASE_URL=DATABASE_URL=` prefix, which the owner
reserved for themselves, so the server cannot boot. Unit coverage stands at 117
tests, 114 passing, 0 failing, 3 honest todos that need an HTTP and database
fixture. Every module in `src/` imports cleanly under a dummy connection
string, so the graph has no missing exports or cycles.

Still open, by choice rather than oversight: the Redis token blacklist fails
open, so during a Redis outage an already-revoked access token keeps working
until it expires. Closing that means failing closed on a cache outage, which
trades an availability incident for a security one — worth a decision, not a
silent fix.
