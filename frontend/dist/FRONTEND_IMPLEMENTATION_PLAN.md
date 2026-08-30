# DocMind — Frontend Analysis & React Implementation Plan

> **Status:** Planning only. No React code is written yet.
> **Scope:** Frontend architecture, UI/UX, design system, and migration plan.
> **Prepared from:** full recursive read of the repository at commit `f750300`.
> **Date:** 2026-08-30

---

## 1. Project Overview

**DocMind** is a multi-tenant Retrieval-Augmented Generation (RAG) product. A user signs up,
creates an isolated workspace ("tenant"), uploads PDFs, and asks natural-language questions.
The backend extracts and chunks PDF text, embeds it with Voyage AI (`voyage-4`, 1024-dim),
stores vectors in Pinecone, performs cosine similarity retrieval, and streams a grounded answer
from Groq (`llama-3.3-70b-versatile`) over Server-Sent Events.

### What actually exists today

| Layer | State |
| --- | --- |
| Backend API | Complete and working — auth, tenants, documents, streaming query |
| Data layer | PostgreSQL + Sequelize (`users`, `tenants`, `documents`), Redis for token blacklist |
| Vector layer | Pinecone, namespaced per tenant |
| Frontend | **4 hand-written static HTML files** with inlined `<style>` and `<script>` |
| Build tooling | **None for the frontend.** No bundler, no dev server, no lint, no tests wired |
| Deploy | Docker Compose → EC2, Nginx reverse proxy with SSE-safe buffering off |

The frontend is served by a single line in `src/app.js:24`:

```js
app.use(express.static(path.join(__dirname, 'public')))
```

There is no router, no SPA fallback, and no build step. Every page is a full document load.

### The gap this plan closes

The backend is production-shaped. The frontend is a prototype: ~4,000 lines of duplicated
CSS/JS across four files, emoji as iconography, hardcoded demo credentials pre-filled into the
login form, no landing page, no password recovery, no document management surface, and several
backend capabilities that are fully implemented but have **zero UI** (workspace API key,
retrieval depth `topK`, page counts, skipped-chunk warnings).

This document defines the React application that replaces it — designed as a product, not as a
transliteration of the existing markup.

---

## 2. Existing Folder Structure

```text
RAG/
├── .github/workflows/main.yml        CI/CD → rsync + docker compose up on EC2
├── .env                              secrets (gitignored) — DB, Redis, Voyage, Pinecone, Groq, JWT
├── Dockerfile                        node:22-alpine + pm2-runtime src/app.js
├── docker-compose.yml                postgres:16 + redis + rag-app (port 4500)
├── nginx.conf                        reverse proxy, buffering off for SSE
├── package.json                      backend deps only, no scripts
├── README.md                         current, accurate (Voyage AI)
├── RAG_Application_Documentation.md  STALE — still describes Ollama/nomic-embed-text
└── src/
    ├── app.js                        Express bootstrap, static serving, route mounting
    ├── config.js                     env → config object
    ├── api/
    │   ├── auth.js                   signup, login, refresh, logout, me
    │   ├── tenant.js                 POST /, GET /me
    │   ├── document.js               POST upload (multer 10 MB), GET list
    │   ├── query.js                  POST query, JSON or SSE
    │   └── health.js                 ⚠ NEVER MOUNTED — dead code
    ├── middleware/
    │   ├── authenticate.js           Bearer JWT verify + Redis blacklist check
    │   ├── requireTenant.js          403 TENANT_REQUIRED / TENANT_MISMATCH
    │   ├── guardrails.js             ⚠ empty pass-through, never used
    │   ├── errorHandler.js
    │   └── validator.js
    ├── models/                       User, Tenant, Document, index (associations)
    ├── rag/
    │   ├── ragEngine.js              retrieve → filter score ≥ 0.5 → build sources
    │   └── vectorStore.js            Pinecone init, upsert, query
    ├── services/                     authService, db, documentService, embeddingService,
    │                                 llmService, redisService, tenantService
    ├── tests/                        4 test files, no runner configured
    ├── images/                       ⭐ 4 colour-palette reference images (untracked)
    └── public/                       ⭐ THE ENTIRE FRONTEND — 4 static HTML files
        ├── index.html                1,441 lines — the RAG chat application
        ├── login.html                  573 lines
        ├── signup.html                 608 lines
        └── tenant-setup.html           650 lines
```

Also present: an empty `New folder/` at the repo root (should be deleted).

---

## 3. Existing HTML Pages

### 3.1 Page relationship map

```text
                    ┌──────────────────┐
                    │   login.html     │◀────── all auth failures redirect here
                    └────────┬─────────┘
                             │ POST /api/auth/login → store tokens in localStorage
                  ┌──────────┴──────────┐
       user.tenantId?                   no tenantId
                  │                             │
                  ▼                             ▼
         ┌─────────────────┐         ┌─────────────────────┐
         │   index.html    │◀────────│  tenant-setup.html  │
         │  (the RAG app)  │         │  POST /api/tenants  │
         └─────────────────┘         └──────────▲──────────┘
                  ▲                             │
                  │                  ┌──────────┴──────────┐
                  └──────────────────│    signup.html      │
                    (never direct)   │ POST /api/auth/signup│
                                     └─────────────────────┘
```

Every transition is a `window.location.href` assignment — a full page reload that re-downloads
Google Fonts, re-parses ~600 lines of duplicated CSS, and re-runs an `/api/auth/me` round-trip
before rendering anything.

### 3.2 `login.html` → `/login`

| | |
| --- | --- |
| **Purpose** | Authenticate an existing user |
| **Sections** | Animated orb backdrop · glass card · logo lockup · **demo-credentials panel** · email + password with floating labels · error banner · spinner submit · footer link to signup |
| **API** | `POST /api/auth/login`, plus an on-load `GET /api/auth/me` "already logged in?" probe |
| **Reusable** | `AuthLayout`, `AuthCard`, `Logo`, `FloatingField`, `PasswordField`, `Alert`, `SubmitButton`, `OrbBackdrop` |
| **Future route** | `/login` inside `<AuthLayout>` |
| **Verdict** | **Redesign.** Keep the glass-card + orb aesthetic (it is genuinely good). Remove the demo-credentials block and the pre-filled `value="admin@gmail.com"` / `value="Admin@123"` attributes. Add show/hide password, remember-me, and a forgot-password link (none exist today). |

### 3.3 `signup.html` → `/signup`

| | |
| --- | --- |
| **Purpose** | Register a new account |
| **Sections** | Same shell as login · first/last name in a 2-up row · email · password with **4-segment strength meter** · confirm password with live match feedback · spinner submit · footer link to login |
| **API** | `POST /api/auth/signup` → tokens → hard redirect to `tenant-setup.html` |
| **Reusable** | Everything from login, plus `PasswordStrengthMeter`, `FieldRow` |
| **Verdict** | **Redesign, preserve behaviour.** The strength meter and live confirm-match are good UX and must survive. Replace ~130 lines of imperative `classList` validation with React Hook Form + Zod. Add a terms/privacy checkbox (currently absent, and signup implies acceptance). |

The strength algorithm to preserve (`signup.html:479`): +1 for length ≥ 8, +1 for mixed case,
+1 for a digit, +1 for a symbol → labels `Weak / Fair / Good / Strong`. Note the backend only
enforces `length >= 8` (`src/api/auth.js:20`), so the meter is advisory, not gating.

### 3.4 `tenant-setup.html` → `/onboarding/workspace`

| | |
| --- | --- |
| **Purpose** | One-time workspace creation — the app is unusable without a `tenantId` |
| **Sections** | Full-screen loading overlay during the auth probe · "Getting Started" pulse badge · title + description · personalised welcome note · workspace name · **auto-slugified** URL slug · live `{slug}.docmind.ai` preview · submit |
| **API** | `POST /api/tenants` → returns **new tokens** containing `tenantId` → must overwrite stored tokens |
| **Reusable** | `OnboardingLayout`, `StepBadge`, `SlugField`, `SlugPreview`, `FullPageLoader` |
| **Verdict** | **Keep and expand into a real multi-step onboarding.** The auto-slug + live preview is the best interaction in the current codebase. The token-reissue-on-create detail is critical and easy to lose in a rewrite — it is the reason a fresh signup can reach the app at all. |

The slug preview promises `{slug}.docmind.ai`, but no subdomain routing exists. Either implement
it or soften the copy — shipping a URL that does not resolve is a trust cost. See §22.

### 3.5 `index.html` → `/app/*` (the whole product, in one file)

1,441 lines carrying five distinct surfaces that all deserve their own route.

| | |
| --- | --- |
| **Purpose** | Upload PDFs and chat against them |
| **Sections** | Fixed sidebar (logo · **upload drop zone** · document list · user card · logout) · mobile hamburger + overlay · chat header with connection dot · **welcome/empty state with 4 suggestion cards** · message stream · collapsible per-answer **sources** · streaming cursor · autosizing textarea composer · toast stack |
| **API** | `GET /api/auth/me` (guard + tenant resolve) · `GET /api/tenants/:id/documents` · `POST /api/tenants/:id/documents` (FormData) · `POST /api/tenants/:id/query` with `stream: true` |
| **Reusable** | `AppShell`, `Sidebar`, `SidebarSection`, `Dropzone`, `DocumentCard`, `StatusPill`, `UserCard`, `MessageList`, `MessageBubble`, `SourcesDisclosure`, `SourceCard`, `Composer`, `SuggestionGrid`, `EmptyState`, `Toaster`, `TypingIndicator` |
| **Future routes** | `/app` (chat) · `/app/documents` (library) · `/app/documents/upload` (modal route) · `/app/settings` |
| **Verdict** | **Rebuild.** The information architecture is sound; the implementation is not. Split the five surfaces, replace the regex markdown renderer, replace DOM-id message mutation with React state, and surface the metadata the backend already returns. |

Four things in here are outright defects, not merely dated (full list in §6):

1. **Markdown by regex.** `renderMarkdown()` runs six chained `.replace()` calls over the raw
   token stream and injects the result with `innerHTML`. Because it escapes first and *then*
   introduces tags, any partially streamed token (`**bold` with no closer, an unterminated
   fence) renders as literal asterisks or swallows the rest of the paragraph. Replace with
   `react-markdown` + `remark-gfm` + `rehype-sanitize`.
2. **Inline `onclick` string handlers** built through template concatenation
   (`'src-' + Date.now()` as a DOM id) to toggle the sources panel. This is XSS-adjacent and
   breaks entirely if two answers land in the same millisecond.
3. **The upload limit is stated three different ways.** The drop-zone hint says
   *"PDF files up to 1 MB only"*, the JS check rejects at `10 * 1024 * 1024`, multer's limit is
   also 10 MB — and nginx `client_max_body_size 1M` silently 413s anything over 1 MB before
   Express ever sees it. A user who trusts the JS check gets an opaque failure.
4. **Refresh-on-401 is wired only into the `/me` probe.** Upload and query call `fetch`
   directly, so 15 minutes after login the first question fails and dumps the user to
   `/login` mid-session. The new `apiClient` fixes this once, centrally (§20).

Also unused by the UI although the backend returns it: `pages`, `chunksSkipped`, `chunksUsed`,
`createdAt`, `topK`, `tenant.apiKey`, `role`, and the 2,000-character query ceiling.

---

## 4. Existing Assets

There is no asset pipeline. An honest inventory:

| Asset class | What exists | Action |
| --- | --- | --- |
| **Images** | 4 untracked palette references in `src/images/` (§7). No product imagery, no OG image, no favicon | Use as palette source only; never ship. Author real favicon/OG assets |
| **Icons** | **Emoji in text nodes** — 📄 documents, 🚀 upload, ✨ suggestions, 🔒 password, ⚠️ errors | **Replace wholesale** with `lucide-react`. Emoji render differently per OS, are read aloud verbatim by screen readers, and cannot inherit colour or stroke weight |
| **Fonts** | `Inter` + `JetBrains Mono` from Google Fonts CDN, re-requested on every page load, no `font-display`, no preconnect, no subsetting | Self-host variable fonts via `@fontsource-variable/*`. Removes a third-party round trip from the critical path and the privacy/consent question that comes with it |
| **Logo** | A CSS gradient square with the letter `D` — no SVG anywhere | Author a real SVG mark; inline it as a React component so it inherits `currentColor` |
| **CSS** | ~600 lines of tokens/reset/form styles duplicated across all four files | Delete; replaced by one Tailwind v4 `@theme` block |
| **JS** | ~1,100 lines of imperative DOM code, zero modules, zero reuse | Delete; superseded by the React tree |
| **Illustrations** | None. Empty states are emoji + text | Add lightweight inline SVGs for the three empty states (§12) |
| **Favicon** | Absent — browsers show the default page icon | Ship `favicon.svg` + `apple-touch-icon.png` + `site.webmanifest` |

The absence of an OG image and favicon is worth calling out: the product currently has no visual
identity outside the viewport. Anything shared in Slack or iMessage renders as a bare grey card.

---

## 5. Current UI/UX Analysis

The existing frontend is better than most internal prototypes and worse than any shipped product.
The taste is real — dark glassmorphism, restrained gradients, a genuinely nice slug interaction —
but it is applied inconsistently and rests on markup that cannot support it.

### 5.1 Layout

| Aspect | Today | Assessment |
| --- | --- | --- |
| App shell | Fixed 320 px sidebar + flexible chat column | **Sound.** Keep the pattern, make the sidebar collapsible and resizable |
| Auth pages | Centred card, `max-width: 440px`, 3 absolutely positioned blurred orbs | **Keep the aesthetic.** Sits on `overflow: hidden`, so on a 600 px-tall laptop the signup card is clipped with no way to scroll |
| Vertical rhythm | Ad-hoc `px` margins — `18px`, `22px`, `26px`, `28px`, `34px` | **Replace.** No scale means no rhythm; every screen feels subtly different |
| Grids | One: the 2×2 suggestion grid, hardcoded `repeat(2, 1fr)` | Collapse to 1 column under 480 px |
| Container widths | Chat messages stretch edge-to-edge on wide screens | **Fix.** Cap the reading column at ~72ch; a 2,560 px-wide line of prose is unreadable |
| Header/nav | No global nav. No landing page. No breadcrumbs | Add a marketing header + an in-app command bar |
| Footer | Only a "don't have an account?" line on auth pages | Add a real marketing footer |
| Mobile | Sidebar becomes a `translateX(-100%)` drawer with an overlay | Works, but no focus trap, no `aria-expanded`, no swipe-to-dismiss, no `Escape` |

### 5.2 Typography

Two families (`Inter`, `JetBrains Mono`), but the type scale is invented per-file: observed sizes
include `11px`, `12px`, `13px`, `13.5px`, `14px`, `15px`, `20px`, `24px`, `26px`, `28px`, `32px`,
`34px`. Weights are similarly scattered (`400/500/600/700/800`). There is one nice touch —
`letter-spacing: -0.02em` on headings — and one recurring failure: `13px` body copy at
`color: var(--text-muted)`, which is both too small and too low-contrast for extended reading.

**Direction:** a single 8-step modular scale, `Inter Tight` for display sizes (tighter apertures
read better large), `Inter` for body/UI, `JetBrains Mono` for code and slugs. Fluid `clamp()` for
display sizes only — body text should never scale with viewport, it should scale with user
preference. Full scale in §15.

### 5.3 Visual design

The current palette is a generic "AI product" purple:

```css
--bg-primary: #06060e;   --bg-secondary: #0c0c1d;  --bg-tertiary: #111128;
--accent-1:   #7c6aef;   --accent-2:     #6ee7b7;
--accent-gradient: linear-gradient(135deg, #7c6aef, #38bdf8);
--danger: #f87171; --warning: #fbbf24; --success: #34d399;
--radius: 12px; --radius-sm: 8px; --radius-lg: 16px;
```

What works: near-black backgrounds with a violet cast; `backdrop-filter: blur()` glass cards;
consistent 12 px radii; soft layered shadows. What does not:

- **`#7c6aef` on `#06060e` is ~4.8:1** — passes AA for large text, fails for the 13 px labels it
  is actually used on. Several accent-coloured helper strings are effectively unreadable.
- **Two unrelated accents** (violet `#7c6aef` and mint `#6ee7b7`) with no rule for when to use
  which. Mint also sits close to `--success: #34d399`, so "accent" and "succeeded" look alike.
- **The gradient is applied to everything** — logo, primary button, avatar, active states,
  progress bars, focus rings. When every emphasis affordance is the same gradient, nothing is
  emphasised.
- **No elevation model.** `--bg-secondary` and `--bg-tertiary` are used interchangeably, so depth
  reads as noise rather than hierarchy.
- **No light theme.** Not even a `prefers-color-scheme` acknowledgement.

The new palette (§7–§8) fixes the contrast failures, collapses to **one** accent, and defines a
five-step elevation ramp so surfaces mean something.

### 5.4 UX

| Concern | Today | Verdict |
| --- | --- | --- |
| First run | Lands on `login.html`. No landing page, no product explanation | **Major gap.** Nobody can evaluate the product before authenticating |
| Demo credentials | Printed on the login card **and pre-filled into the inputs** | **Remove.** Real credentials in source control (§6.1) |
| Password recovery | Does not exist — no link, no route, no API | **Major gap.** A forgotten password today means account loss |
| Validation | Fires on submit; `.error` classes toggled imperatively | Move to on-blur + on-submit, with `aria-describedby` wiring |
| Error states | One red banner per form; chat errors go to toasts | Keep both, add field-level messages and retry affordances |
| Empty states | Chat has a good one. Document list shows plain "No documents yet" | Upgrade the document empty state to a real call to action |
| Loading states | Spinners and a full-page overlay. No skeletons anywhere | Add skeletons for the document list and message history |
| Success states | Toast only. Upload gives no post-success detail | Show pages/chunks/skipped counts — the API already returns them |
| Streaming | Token-by-token with a blinking cursor | **Genuinely good.** Preserve exactly, add stop-generation |
| Chat history | Lost on refresh — no persistence, no conversations table | Session-scoped restore now; flag server persistence as backend work (§22) |
| Keyboard | `Enter` sends, `Shift+Enter` newlines. Nothing else | Add `/` focus, `Esc` close, `⌘K` command palette |
| Reduced motion | Infinite orb-drift, float, and pulse animations; **no `prefers-reduced-motion` anywhere** | **Accessibility defect.** Fix globally (§18) |

---

## 6. Existing Problems / Technical Debt

Eighteen items, ordered by consequence. Severity: 🔴 ship-blocker · 🟠 significant · 🟡 cleanup.

### 6.1 Security & correctness

| # | Sev | Issue | Where | Fix |
| --- | --- | --- | --- | --- |
| 1 | 🔴 | Working credentials committed to the repo **and pre-filled into the login inputs** (`value="admin@gmail.com"`, `value="Admin@123"`) | `login.html` | Delete the panel and the `value` attributes. Rotate that account's password — it is in git history |
| 2 | 🔴 | **Refresh-on-401 only wraps `/api/auth/me`.** Upload and query use bare `fetch`, so the first request after the 15-minute access-token expiry fails and ejects the user | `index.html` | One `apiClient` with a single-flight refresh queue (§20) |
| 3 | 🔴 | **Upload limit stated three ways**: hint "1 MB", JS check 10 MB, multer 10 MB, nginx `client_max_body_size 1M` → silent 413 | `index.html`, `document.js`, `nginx.conf` | Pick one number, derive the UI copy from a shared constant, raise nginx to match |
| 4 | 🟠 | Markdown rendered by six chained regex `.replace()` calls into `innerHTML` | `index.html` | `react-markdown` + `remark-gfm` + `rehype-sanitize` |
| 5 | 🟠 | Inline `onclick` strings with `Date.now()`-generated DOM ids for the sources toggle | `index.html` | React state + Radix `Collapsible` |
| 6 | 🟠 | Tokens in `localStorage`, readable by any injected script | all 4 pages | Keep for this phase (backend sets no cookies), isolate behind one `tokenStorage` module so the swap to httpOnly cookies is a one-file change. Recorded in §22 |
| 7 | 🟡 | No SPA fallback — deep links like `/app/documents` will 404 | `src/app.js:24` | Add a catch-all **after** the `/api` mounts (§20) |

### 6.2 Product gaps

| # | Sev | Issue | Fix |
| --- | --- | --- | --- |
| 8 | 🔴 | **No password recovery at all** — no link, no page, no endpoint | Build the full 3-screen UI now against a documented contract; wire when the API lands (§13.3) |
| 9 | 🟠 | **No landing page.** `/` redirects straight to login | Build `/` as a real marketing page (§12.1) |
| 10 | 🟠 | **No document management** — cannot open, rename, delete, or inspect a document | `/app/documents` library route (§12.5) |
| 11 | 🟠 | **Chat history is lost on refresh** | Session restore now; server persistence flagged as backend work |
| 12 | 🟡 | Backend features with zero UI: `tenant.apiKey`, `topK`, `pages`, `chunksSkipped`, `chunksUsed`, `role`, non-streaming mode, the 2,000-char limit | Surface each — see §12.4, §12.5, §12.6 |

### 6.3 Engineering hygiene

| # | Sev | Issue | Fix |
| --- | --- | --- | --- |
| 13 | 🟠 | ~600 lines of CSS and ~200 lines of JS triplicated across four files | One `@theme` block, one component library |
| 14 | 🟡 | No frontend build, dev server, linter, formatter, or test runner. `package.json` has no `scripts` beyond a failing `test` | Vite + ESLint + Prettier + Vitest + Playwright |
| 15 | 🟡 | `src/api/health.js` is written but **never mounted**; `src/middleware/guardrails.js` is an empty pass-through | Mount health or delete it; delete guardrails |
| 16 | 🟡 | `embeddingModel: 'nomic-embed-text'` hardcoded on every `Document` row despite Voyage `voyage-4` being in use; `query.js` still has an `error.message.includes('Ollama')` branch | Correct both — the DB is recording false provenance |
| 17 | 🟡 | `RAG_Application_Documentation.md` still documents Ollama, `rag-ollama`, and `deploy.yml` | Update or delete; `README.md` is already correct |
| 18 | 🟡 | Empty toast icon strings (`{ success: '', error: '', info: '' }`); empty `New folder/` at repo root | Lucide icons; delete the folder |

### 6.4 Accessibility defects

Floating labels rely on `::placeholder { color: transparent }` — screen readers announce a
placeholder that sighted users cannot see, and the visible label is a sibling `<span>` not bound
by `for`. No `aria-describedby` on any errored field. Toasts and streaming answers are not in an
`aria-live` region, so a screen-reader user gets silence. The mobile sidebar has no focus trap, no
`aria-expanded`, and no `Escape` handler. The drop zone is a `<div>` with no `tabindex`, `role`, or
keyboard path — **upload is impossible without a mouse**. Contrast fails in several places (§5.3).
`prefers-reduced-motion` is not honoured anywhere despite three infinite animations. Focus rings
are removed with `outline: none` and only sometimes replaced by a `box-shadow`.

---

## 7. Image & Colour Analysis

`src/images/` holds four palette references, each pairing one light colour with one dark colour.
These are mood boards, not product assets — nothing from them ships. Their only job is to decide
the theme. I evaluated all four on measured contrast rather than preference, because the palette
has to survive 13 px labels on dark glass, not just look good in a swatch.

### 7.1 The four candidates

| Image | Light colour | Dark colour | Pair contrast | Register |
| --- | --- | --- | --- | --- |
| `icy-blue-gunmetal.jpeg` | Icy Blue `#A4D8FF` | Gunmetal `#35393C` | **7.35:1** | Technical, calm, precise |
| `postal-pink-graphite.jpeg` | Pastel Pink `#FEBFCA` | Graphite `#2B2B2B` | **8.80:1** | Consumer, playful, beauty/DTC |
| `levender-blush.jpeg` | Lavender Blush `#FFE6ED` | Blush `#CF7486` | **2.72:1** | Soft, editorial, low-contrast |
| `mist.jpeg` | Champagne Mist `#F7E7CE` | Burgundy `#80011F` | **8.90:1** | Heritage, luxury, print |

### 7.2 How each was judged

Relative luminance (WCAG 2.1) for every colour, then ratios against the surfaces they would
actually have to work on — a near-black app background and a mid-dark card.

**`levender-blush` — rejected on hard accessibility grounds.**
Blush `#CF7486` cannot carry text in either direction: white on it is **3.23:1**, near-black on it
is **3.45:1**. Both fail WCAG AA (4.5:1) for normal text. A primary button in this colour has no
legal label colour. That ends the discussion; nothing else about it matters.

**`mist` — rejected on structural grounds.**
Champagne Mist on Burgundy is a strong **8.90:1**, but the pair only works in that direction.
Burgundy `#80011F` has luminance ≈0.0369, so on a near-black background it is **1.90:1** — it
cannot be an accent, a link, a focus ring, or a border on dark surfaces. That forces a
cream-dominant light-only product, which contradicts the existing dark app. Burgundy also sits
inside error-red's semantic territory, so "primary action" and "destructive action" would read the
same. Beautiful palette, wrong architecture.

**`postal-pink-graphite` — rejected on judgement, not math.**
The math is fine: `#FEBFCA` on `#2B2B2B` is 8.80:1, and near-black on `#FEBFCA` is ~14:1. Two
reasons against it. First, register: pastel pink reads consumer-beauty/DTC, and this product is a
document-intelligence tool where the emotional promise is *precision* — the palette should say
"instrument", not "brand". Second, and more concretely, pink at this lightness lives next door to
error states; a pink primary button and a red error banner compete rather than separate.
Graphite `#2B2B2B` is also fully desaturated (S = 0), so it can only ever be neutral chrome —
it contributes nothing to brand identity.

### 7.3 The deciding observation

Converting the winner's two colours to HSL:

```text
Icy Blue  #A4D8FF  →  hsl(206, 100%, 82%)
Gunmetal  #35393C  →  hsl(206,   6%, 22%)
```

**Identical hue.** The dark colour is not a neutral grey placed next to a blue — it is the *same
blue*, desaturated to 6% and darkened to 22%. That is a monochromatic pair, which means every
neutral in the interface can be a tint of the brand hue instead of a foreign grey. Backgrounds,
borders, disabled states, and dividers all quietly belong to the same family. Compare
`postal-pink-graphite`, where the pink is hue 350° and the graphite is hue-less: any ramp built
between them has to pass through mud.

Practically, this means one hue (206°) generates the entire system: an 11-step ink ramp for
surfaces and text, and a 7-step sky ramp for accent and interaction. No second hue needed, no
"which accent do I use here?" ambiguity — the exact problem the current violet/mint pairing has.

### 7.4 Contrast measurements for the chosen pair

| Foreground | Background | Ratio | Verdict |
| --- | --- | --- | --- |
| `#A4D8FF` | `#0A0D0F` (app bg) | **12.85:1** | AAA — accent text and icons are safe at any size |
| `#A4D8FF` | `#1D242A` (card) | **10.30:1** | AAA on elevated surfaces |
| `#A4D8FF` | `#35393C` (Gunmetal) | **7.35:1** | AAA — the source image's own pairing |
| `#0A0D0F` | `#A4D8FF` (filled CTA) | **12.85:1** | AAA — near-black label on an Icy Blue button |
| `#FFFFFF` | `#A4D8FF` | **1.52:1** | ✗ **Never** white text on Icy Blue |

That last row is the one design constraint the palette imposes, and it is a *useful* constraint:
the primary button must be an **Icy Blue fill with near-black text** — bright, high-contrast,
and unmistakably the primary action. It is also exactly how the source image uses the pair. The
usual "white text on a saturated button" reflex is simply unavailable, which pushes the design
somewhere more distinctive.

Because Icy Blue is a *light* colour, dark mode is the primary experience and gets the real
palette. Light mode cannot use `#A4D8FF` for interactive fills (it would vanish on white), so it
substitutes `sky-600 #0A6EBF` — the same hue, darkened until white text on it reaches **5.26:1**.
Icy Blue survives in light mode as a tint for selected rows, badges, and highlight washes.

---

## 8. Recommended Theme

> ### Selected: `icy-blue-gunmetal.jpeg`
> **Icy Blue `#A4D8FF`** · **Gunmetal `#35393C`**

**Why.** It is the only candidate that satisfies all four requirements simultaneously: AAA
contrast in both directions, a shared hue that generates the neutral ramp, a register that matches
a technical document tool, and no collision with success/warning/error semantics. The other three
each fail at least one — `levender-blush` fails contrast outright, `mist` cannot produce a dark-mode
accent, `postal-pink-graphite` is register-wrong and semantically crowded.

It also inherits what already works. The current UI is dark, glassy, and blue-leaning; swapping
violet `#7c6aef` for the 206° family keeps the mood the codebase already has while fixing its
contrast failures and removing the second, competing accent.

### 8.1 Colour distribution

The single most common failure mode with a bright accent is using it everywhere. The budget:

| Role | Share | Colours | Where |
| --- | --- | --- | --- |
| **Dominant** | ~75% | `ink-950` → `ink-800` | Page backgrounds, cards, sidebar, composer, modal bodies |
| **Structural** | ~15% | `ink-700`, `ink-600`, `ink-500` | Borders, dividers, inactive icons, disabled controls, scroll thumbs |
| **Text** | — | `ink-50`, `ink-200`, `ink-350` | Primary / secondary / muted copy |
| **Accent** | **~7%** | `sky-200` (Icy Blue) | Primary CTA, focus rings, active nav, links, streaming cursor, selected doc |
| **Semantic** | ~3% | success / warning / error | Status pills, alerts, validation, destructive actions |

Rules that keep it premium rather than loud:

1. **One accent element per view.** A screen has exactly one Icy Blue filled button. Everything
   else is ghost, outline, or text — including secondary actions in the same row.
2. **Gradients are decorative only.** Auth-page orbs, the landing hero wash, the logo mark. Never
   on buttons, never on text, never on a focus ring. The current design's gradient-on-everything
   is why nothing in it reads as primary.
3. **Elevation comes from surface steps, not shadow.** `ink-950` → `ink-900` → `ink-850` →
   `ink-800`, each with a `1px` `ink-700` hairline. Shadows only for genuinely floating layers
   (popover, dialog, toast).
4. **Glass sparingly.** `backdrop-filter: blur(20px)` on the auth card, the sticky landing header,
   and the composer bar. Not on every card — blur is expensive and stops reading as special.
5. **Accent tints for state, not accent fills.** Hover and selected rows use
   `color-mix(in oklab, var(--sky-200) 8%, transparent)`, keeping the bright fill exclusive to CTAs.

Concrete ramps, semantic tokens, and the light-mode overrides are in §15.

---

## 9. Proposed React Architecture

### 9.1 Placement

The React app lives in **`web/`** at the repo root — a sibling of `src/`, not nested inside it.
During development Vite serves `web/` on `:5173` and proxies `/api` → `http://localhost:4500`,
so **this phase requires zero backend changes**. At ship time `express.static` is pointed at
`web/dist` and an SPA fallback is added after the `/api` mounts (§20.4).

Rejected alternative: replacing `src/public/` in place. Keeping the old pages reachable until the
React app is at parity means the deployed product never regresses mid-migration, and the diff stays
reviewable.

### 9.2 Stack

| Concern | Choice | Why this one |
| --- | --- | --- |
| Build | **Vite 6** | Instant HMR, first-class TS, trivial `/api` proxy, Rollup output |
| Language | **TypeScript (strict)** | The SSE frames, auth error codes, and document statuses are all discriminated unions — types catch the mismatches this codebase currently ships |
| UI | **React 19** | `useOptimistic` for message send, `useTransition` for route changes, Suspense for lazy routes |
| Routing | **React Router v7** (declarative mode) | Nested layouts map exactly onto the shell/auth/onboarding split; per-route lazy loading |
| Styling | **Tailwind CSS v4** | v4's `@theme` emits real CSS custom properties, so the design tokens are inspectable at runtime and themeable without a JS rebuild |
| Primitives | **Radix UI** (Dialog, DropdownMenu, Tooltip, Tabs, Popover, Collapsible, Switch) | Focus trapping, `aria-*`, and keyboard behaviour that this codebase currently has none of. Unstyled, so the design isn't inherited |
| Server state | **TanStack Query v5** | Documents and profile are cached server state with refetch/invalidate semantics — not something to hand-roll again |
| Client state | **Zustand** | Two small stores (session, UI). Redux would be ceremony for ~40 lines of state |
| Forms | **React Hook Form + Zod** | Replaces ~330 lines of imperative validation. Zod schemas double as API response parsers |
| Animation | **Motion** (`motion/react`) | Layout animations for the message stream, `AnimatePresence` for route/toast transitions, and one global `MotionConfig` that honours `prefers-reduced-motion` |
| Markdown | **react-markdown + remark-gfm + rehype-sanitize** | Streaming-safe, tables/task-lists, sanitised by construction |
| Icons | **lucide-react** | Tree-shaken SVGs that inherit `currentColor` — replaces emoji |
| Toasts | **Sonner** | Accessible, stacked, promise-aware |
| Fonts | **`@fontsource-variable/*`** | Self-hosted, subset, no CDN round trip |
| Tests | **Vitest + Testing Library + Playwright + axe** | Unit for logic, integration for forms/streams, e2e for the two critical journeys, axe in CI |

Deliberately **not** included: a component framework (MUI/Chakra/Ant) — it would fight the palette
and the glass aesthetic; Redux Toolkit; a form library beyond RHF; i18n (structure copy so it can be
extracted later, but do not add a runtime now); an SSR framework — the app is behind auth and gains
nothing from server rendering, while the SSE proxy would get harder.

### 9.3 Layering

```text
┌─────────────────────────────────────────────────────────┐
│  routes/            route modules, lazy-loaded          │
├─────────────────────────────────────────────────────────┤
│  features/          auth · onboarding · chat            │
│                     documents · workspace               │
│    ├── components/  feature-owned UI                    │
│    ├── hooks/       useLogin, useStreamQuery, …          │
│    └── schemas.ts   Zod: forms AND responses            │
├─────────────────────────────────────────────────────────┤
│  components/ui/     Button, Input, Dialog, … (no domain)│
│  components/layout/ AppShell, AuthLayout, MarketingNav  │
├─────────────────────────────────────────────────────────┤
│  lib/api/           apiClient · endpoints · sse         │
│  lib/               tokenStorage · queryClient · utils  │
├─────────────────────────────────────────────────────────┤
│  styles/theme.css   @theme tokens — the design system   │
└─────────────────────────────────────────────────────────┘
```

Two rules keep this from rotting:

1. **Dependencies point downward only.** `components/ui/` never imports from `features/`. If a
   "shared" component needs to know about documents, it belongs to the documents feature.
2. **Components never call `fetch`.** All network access goes through a feature hook, which calls
   `lib/api/endpoints`. That single boundary is what makes the httpOnly-cookie migration (§22) a
   one-file change instead of a rewrite.

### 9.4 State strategy

| Kind of state | Owner | Examples |
| --- | --- | --- |
| Server data | TanStack Query | profile, tenant, document list, upload mutation |
| Session | Zustand (`useSessionStore`, persisted) | user, tenantId, tokens, `status: 'loading' \| 'authed' \| 'anon'` |
| UI shell | Zustand (`useUIStore`, partially persisted) | sidebar open/collapsed, theme, command-palette open |
| Streaming chat | `useReducer` inside `useChat` | messages, streaming flag, current sources, abort controller |
| Form state | React Hook Form | every form |
| URL state | React Router | route params, `?tab=`, modal routes |

Chat is a reducer rather than Query because a streaming answer is a sequence of appends to one
mutable message, not a cacheable resource. Actions: `SEND`, `SOURCES`, `TOKEN`, `DONE`, `ERROR`,
`ABORT`, `RETRY`, `CLEAR`.

---

## 10. Proposed Folder Structure

```text
RAG/
├── src/                              ← backend, untouched this phase
├── web/                              ← the React application
│   ├── index.html                    Vite entry, <html lang="en"> + theme bootstrap
│   ├── vite.config.ts                /api proxy → :4500, manualChunks, alias @/*
│   ├── tsconfig.json                 strict, paths
│   ├── package.json                  frontend deps + scripts
│   ├── eslint.config.js              flat config + jsx-a11y + react-hooks
│   ├── .prettierrc
│   ├── playwright.config.ts
│   ├── public/
│   │   ├── favicon.svg
│   │   ├── apple-touch-icon.png
│   │   ├── og-image.png
│   │   └── site.webmanifest
│   └── src/
│       ├── main.tsx                  createRoot + providers
│       ├── App.tsx                   <RouterProvider>
│       ├── routes.tsx                route table, all leaves React.lazy
│       │
│       ├── styles/
│       │   ├── theme.css             @theme — ALL design tokens (§15)
│       │   ├── base.css              reset, focus-visible, scrollbars, selection
│       │   └── index.css             @import "tailwindcss" + the above
│       │
│       ├── lib/
│       │   ├── api/
│       │   │   ├── client.ts         fetch wrapper: auth header, refresh queue, ApiError
│       │   │   ├── endpoints.ts      auth / tenants / documents / query — typed
│       │   │   ├── sse.ts            POST + ReadableStream SSE parser
│       │   │   └── types.ts          DTOs mirroring the Express responses
│       │   ├── tokenStorage.ts       the ONLY module that touches localStorage
│       │   ├── queryClient.ts        TanStack defaults + retry policy
│       │   ├── constants.ts          MAX_UPLOAD_BYTES, MAX_QUERY_CHARS, TOP_K_*
│       │   └── utils/                cn, formatBytes, formatRelativeTime, slugify
│       │
│       ├── hooks/                    useMediaQuery, useReducedMotion, useAutosizeTextarea,
│       │                             useCopyToClipboard, useHotkey, useIsomorphicLayoutEffect
│       │
│       ├── stores/
│       │   ├── sessionStore.ts       user, tenant, tokens, status
│       │   └── uiStore.ts            sidebar, theme, command palette
```

```text
│       ├── components/
│       │   ├── ui/                   design-system primitives, zero domain knowledge
│       │   │   ├── Button.tsx        variants: primary|secondary|ghost|danger|link
│       │   │   ├── IconButton.tsx    Input.tsx  Textarea.tsx  Select.tsx
│       │   │   ├── Checkbox.tsx      Switch.tsx  Label.tsx    FieldError.tsx
│       │   │   ├── Card.tsx          Badge.tsx   Pill.tsx     Avatar.tsx
│       │   │   ├── Alert.tsx         Tooltip.tsx Dialog.tsx   Drawer.tsx
│       │   │   ├── DropdownMenu.tsx  Tabs.tsx    Collapsible.tsx
│       │   │   ├── Progress.tsx      Spinner.tsx Skeleton.tsx
│       │   │   ├── EmptyState.tsx    ErrorState.tsx
│       │   │   └── Container.tsx     Section.tsx  Kbd.tsx  VisuallyHidden.tsx
│       │   │
│       │   ├── layout/
│       │   │   ├── RootLayout.tsx        providers, MotionConfig, Toaster, skip-link
│       │   │   ├── MarketingLayout.tsx   sticky nav + footer
│       │   │   ├── AuthLayout.tsx        orb backdrop + centred glass card
│       │   │   ├── OnboardingLayout.tsx  step rail + centred panel
│       │   │   ├── AppLayout.tsx         sidebar + topbar + <Outlet/>
│       │   │   ├── Sidebar.tsx           collapsible; Drawer under lg
│       │   │   └── Topbar.tsx            breadcrumb, ⌘K, theme, user menu
│       │   │
│       │   ├── feedback/             Toaster.tsx, RouteError.tsx, RouteFallback.tsx
│       │   ├── motion/               FadeIn, Reveal, Stagger, PageTransition, OrbBackdrop
│       │   └── brand/                Logo.tsx, LogoMark.tsx, Wordmark.tsx
│       │
│       ├── features/
│       │   ├── auth/
│       │   │   ├── components/       LoginForm, SignupForm, ForgotPasswordForm,
│       │   │   │                     ResetPasswordForm, PasswordField,
│       │   │   │                     PasswordStrengthMeter, AuthCard, AuthFooterLink,
│       │   │   │                     ProtectedRoute, PublicOnlyRoute, SessionExpiredDialog
│       │   │   ├── hooks/            useSession, useLogin, useSignup, useLogout,
│       │   │   │                     useForgotPassword, useResetPassword
│       │   │   └── schemas.ts        loginSchema, signupSchema, resetSchema
│       │   ├── onboarding/           WorkspaceForm, SlugField, SlugPreview, StepRail
│       │   ├── chat/                 ChatPanel, MessageList, MessageBubble, Markdown,
│       │   │                         SourcesDisclosure, SourceCard, Composer,
│       │   │                         SuggestionGrid, StreamingCursor, RetrievalSettings,
│       │   │                         useChat, useStreamQuery
│       │   ├── documents/            DocumentList, DocumentCard, DocumentTable,
│       │   │                         UploadDropzone, UploadProgressList, DocumentDetail,
│       │   │                         StatusPill, useDocuments, useUploadDocument
│       │   └── workspace/            WorkspaceSettings, ApiKeyPanel, MemberList
│       │
│       ├── pages/                    one file per route; composes features only
│       └── test/                     setup.ts, msw handlers, fixtures
└── e2e/                              Playwright specs
```

Convention: `pages/` files contain **layout and composition only** — no fetch, no business logic.
That keeps route files readable and makes features independently testable.

---

## 11. Route Structure

```text
/                                    MarketingLayout          public
├── /                                Landing
├── /pricing                         Pricing                  (stub, honest placeholder)
├── /legal/terms                     Terms
└── /legal/privacy                   Privacy

/                                    AuthLayout               public-only (redirects if authed)
├── /login                           Login
├── /signup                          Signup
├── /forgot-password                 Request reset link       ⚠ no API yet
├── /reset-password?token=…          Set new password         ⚠ no API yet
└── /verify-email?token=…            Email confirmation       ⚠ no API yet

/onboarding                          OnboardingLayout         auth required, NO tenant
└── /onboarding/workspace            Create workspace

/app                                 AppLayout                auth + tenant required
├── /app                             Chat  (index)
├── /app/documents                   Document library
│   └── /app/documents/:documentId   Document detail (drawer on desktop, page on mobile)
├── /app/settings                    → redirect to /app/settings/workspace
│   ├── /app/settings/workspace      Name, slug, region
│   ├── /app/settings/api-keys       Reveal/copy tenant.apiKey  ← zero UI today
│   ├── /app/settings/members        Members + roles (read-only until an API exists)
│   └── /app/settings/account        Profile, password, theme
└── /app/*                           NotFound (in-shell)

/403                                 Unauthorized / tenant mismatch
/*                                   NotFound (marketing chrome)
```

### 11.1 Guard behaviour

Guards read `useSessionStore().status`, which starts at `'loading'` while `/api/auth/me` resolves.

| Situation | Result |
| --- | --- |
| `status === 'loading'` | Route-level skeleton, **not** a full-page spinner — the shell renders immediately |
| Anonymous → `/app/*` | Redirect to `/login?next=<pathname+search>` |
| Authed, no `tenantId` → `/app/*` | Redirect to `/onboarding/workspace` |
| Authed **with** `tenantId` → `/onboarding/*` | Redirect to `/app` |
| Authed → `/login` or `/signup` | Redirect to `next` if present, else `/app` |
| `401 TOKEN_EXPIRED` mid-session | Silent refresh; the failed request is replayed. User sees nothing |
| `401 TOKEN_REVOKED` or refresh fails | `SessionExpiredDialog` — re-authenticate in place, keeping the typed message. Only falls back to `/login` if dismissed |
| `403 TENANT_REQUIRED` | Redirect to `/onboarding/workspace` |
| `403 TENANT_MISMATCH` | `/403` with a "switch workspace" action |

The session-expired dialog matters more than it sounds: today an expired token during a long chat
discards whatever the user typed. Preserving the composer's contents across re-auth is the single
highest-value UX fix in this document.

---

## 12. Page-by-Page UI Plan

Auth pages are specified in depth in §13; this section covers everything else, plus a one-line
entry for each auth route so the map is complete.

### 12.1 `/` — Landing

| | |
| --- | --- |
| **Target user** | Someone who has never heard of DocMind |
| **Primary CTA** | "Start free" → `/signup` |
| **Secondary** | "Sign in" · "See how it works" (scrolls to the pipeline section) |
| **Auth** | Public. Authed visitors get a "Go to workspace" button instead of "Start free" |

Sections, top to bottom:

1. **Sticky header** — logo, `Product` / `Pricing` / `Docs`, theme toggle, `Sign in`,
   `Start free`. Transparent over the hero; at `scrollY > 24` it gains
   `backdrop-blur(20px)` + `bg-surface/70` + a hairline bottom border. Under `lg` it becomes a
   hamburger opening a full-height Radix `Dialog` drawer.
2. **Hero** — eyebrow pill ("Multi-tenant RAG, production-ready"), an `h1` at
   `clamp(2.5rem, 6vw, 4.5rem)` where one clause is `text-sky-200`, a two-line subhead capped at
   `60ch`, the CTA pair, and a trust strip ("PDF · 1024-dim vectors · cosine retrieval ·
   streamed answers"). Behind it: two blurred Icy Blue orbs at 12% opacity drifting on a 20 s
   loop, plus a subtle radial grid. Both stop under `prefers-reduced-motion`.
3. **Product visual** — a real, non-animated screenshot-style mock of the chat UI in a browser
   chrome frame, tilted `rotateX(6deg)` with a soft Icy Blue glow. Shows a streamed answer with
   two source cards open, because that is the product's actual value.
4. **How it works** — 4 steps (Upload → Chunk & embed → Retrieve → Answer with sources) as a
   horizontal connector on `lg`, a vertical timeline below. Each step reveals on scroll with a
   60 ms stagger, `once: true`.
5. **Capabilities** — 6 cards: workspace isolation, streamed answers, cited sources, batch
   embedding, tunable retrieval depth, API access. Icons from lucide, `1px ink-700` borders,
   hover lifts `translateY(-2px)` and warms the border to `sky-200/30`.
6. **Grounding section** — the differentiator, told plainly: answers cite the chunk they came
   from, and low-similarity matches (`< 0.5`) are discarded rather than guessed around. Paired
   with a small annotated source-card visual.
7. **Final CTA band** — Icy Blue-tinted panel, single button, one line of copy.
8. **Footer** — 4 columns (Product, Resources, Legal, Company), logo, copyright.

**States.** No loading state (static). If the authed probe is in flight, the header CTA renders as
a `Skeleton` of the same width — no layout shift. Error state: none; the page must never depend on
an API call.

**Responsive.** Single column under `md`; hero text centres and the CTA pair becomes two
full-width stacked buttons with 48 px min height. The product visual loses its tilt under `md`
(perspective on a small screen reads as a rendering bug) and clips to a 16:10 crop.

### 12.2 Auth routes (summary — full spec in §13)

| Route | Purpose | Primary CTA | Notes |
| --- | --- | --- | --- |
| `/login` | Authenticate | "Sign in" | Show/hide password, remember-me, forgot link, `?next=` return |
| `/signup` | Register | "Create account" | Strength meter preserved, confirm-match, terms checkbox |
| `/forgot-password` | Request a reset link | "Send reset link" | **No API yet** — ships behind a flag |
| `/reset-password` | Set a new password | "Reset password" | Token from query string |
| `/verify-email` | Confirm an address | "Continue" | Optional; only if verification is added |

### 12.3 `/onboarding/workspace` — Create workspace

| | |
| --- | --- |
| **Target user** | A user who just signed up and has no `tenantId` |
| **Primary CTA** | "Create workspace" |
| **Secondary** | "Sign out" (top-right, quiet) |
| **Auth** | Authed, **no** tenant. Authed-with-tenant is redirected to `/app` |

A 2-step rail, not the current single screen — the second step costs nothing and makes the first
feel less like a wall:

**Step 1 — Name your workspace.** Step badge ("Step 1 of 2"), `h1` "Let's set up your workspace",
a personalised line ("Welcome, {firstName}"), the **name** field (2–100 chars, mirroring
`Tenant.name`), an auto-derived **slug** field, and the live preview.

The slug interaction is the best thing in the existing codebase and is preserved exactly:
typing the name derives the slug (lowercase, non-alphanumerics → `-`, collapse repeats, trim
edges) until the user edits the slug directly, after which it stops tracking. The preview renders
in `JetBrains Mono` with the slug segment in `sky-200`. Slug must match
`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, 2–60 chars — the same regex the Sequelize model enforces, so the
client and server cannot disagree.

**Step 2 — Upload your first document.** Reuses `UploadDropzone` with a "Skip for now" escape.
This exists because a workspace with no documents produces a chat that can only say "no relevant
context found", which reads as a broken product on first contact.

**States.** Loading: auth probe renders the step rail with skeleton fields — no full-page overlay
(the current overlay makes a 200 ms probe feel like a cold start). Submitting: button spinner,
fields disabled, `aria-busy`. Success: `POST /api/tenants` returns **new tokens containing
`tenantId`** — these must overwrite the stored pair before navigating, or every `/app` request
will 403 `TENANT_REQUIRED`. Then a 400 ms success check animation, then `/app`. Error: `409` maps
to a field-level "That URL is taken" on the slug input, not a banner; anything else is a banner
with a retry button.

**Responsive.** The step rail is horizontal above `md`, and collapses to a "Step 1 of 2" pill plus
a 2-segment progress bar below it. Inputs are `text-base` (16 px) to stop iOS Safari zooming on
focus — a real defect in the current build.

### 12.4 `/app` — Chat

The product. Everything else exists to get a user here.

| | |
| --- | --- |
| **Target user** | An authenticated member of a workspace with at least one document |
| **Primary CTA** | The composer — "Ask anything about your documents" |
| **Secondary** | Upload · retrieval settings · copy answer · view sources · stop generating · clear thread |
| **Auth** | Auth + tenant required |

**Layout.** Three regions inside `AppLayout`:

```text
┌────────────┬──────────────────────────────────────────┐
│  Sidebar   │  Topbar: breadcrumb · ⌘K · theme · user  │
│  280px     ├──────────────────────────────────────────┤
│            │                                          │
│  Upload    │   Message stream (max-w-3xl, centred)    │
│  Documents │                                          │
│  ────────  │                                          │
│  Settings  ├──────────────────────────────────────────┤
│  User card │  Composer (sticky, glass, autosizing)    │
└────────────┴──────────────────────────────────────────┘
```

Sidebar drops from 320 px to 280 px (the current width crowds the reading column on a 1366 px
laptop), gains a collapse toggle to a 64 px icon rail, and persists that choice in `uiStore`.

**Empty state.** `h2` "Ask your documents anything", one line of guidance, then a 2×2
`SuggestionGrid` whose prompts are **derived from the actual document list** ("Summarise
{filename}", "What are the key points in {filename}?") rather than the current hardcoded strings.
With zero documents the grid is replaced by an upload-first `EmptyState` — asking questions with no
corpus is the fastest way to make the product look broken.

**Message stream.** User messages: right-aligned, `ink-800` fill, 85% max width. Assistant
messages: full-width, no bubble, `prose` typography — long grounded answers read better as
documents than as chat bubbles. Each assistant message carries a hover toolbar (copy, regenerate,
good/bad feedback stub) and, when sources exist, a `SourcesDisclosure`.

**Sources.** Collapsed by default as `Cited from N sources`. Expanded: one `SourceCard` per source
showing the filename, `Chunk {chunkIndex}`, a relevance bar (`relevanceScore` × 100 as a
`sky-200` fill), and the snippet. Clicking a card deep-links to
`/app/documents/:documentId?chunk=N`. The backend already returns all of this
(`{documentId, chunkIndex, relevanceScore, snippet}`); today the UI shows only a raw list.

**Composer.** Autosizing textarea (1 → 8 rows, then internal scroll), glass background, sticky to
the viewport bottom with a gradient mask above it so text fades rather than hard-clips. Left
slot: attach (opens the upload dialog). Right slot: a live `1,847 / 2,000` counter that turns
`warning` at 90% and `error` at 100% — the backend rejects at `MAX_QUERY_LENGTH = 2000` and the
current UI gives no warning at all. Send button is Icy Blue, disabled while empty or streaming;
during a stream it becomes a **Stop** button wired to `AbortController.abort()`.

**Retrieval settings.** A small popover on the composer exposing `topK` (slider, 1–20, default 5)
and a "stream responses" switch. Both are already supported by `POST /api/tenants/:id/query` and
have no UI. `topK` is the single most useful knob for a power user: raising it trades latency for
recall, and today that is invisible.

**States.**

| State | Treatment |
| --- | --- |
| Initial load | Sidebar renders instantly; document list is 5 `Skeleton` rows; stream area shows the empty state once `/me` resolves |
| Sending | User message appended optimistically via `useOptimistic`; assistant bubble appears with a 3-dot `TypingIndicator` |
| `sources` frame | Sources attach to the pending message **before** any token arrives — the current build waits, which wastes ~1 s of perceived latency |
| `chunk` frames | Tokens append; a 2 px `sky-200` block cursor blinks at the tail; the view auto-scrolls **only if** the user is within 80 px of the bottom |
| `done` | Cursor removed, toolbar fades in, composer refocused |
| `error` frame | The partial answer is **kept**, with an inline error strip and a Retry button beneath it. Today the message is replaced and the partial answer is destroyed |
| Aborted | Partial answer kept, labelled "Stopped" |
| No relevant context | A distinct `EmptyState` inside the answer slot: "Nothing in your documents matched this question", plus the similarity threshold explained and an upload CTA. This is a normal outcome (`score < 0.5` filtering), not an error, and must not look like one |
| Offline | Composer disables, a persistent `Alert` explains, queued text is preserved |

**Responsive.** Under `lg` the sidebar becomes a left `Drawer` (Radix `Dialog` → focus trap,
`Escape`, `aria-expanded` — all missing today) with a hamburger in the topbar. The message column
loses its horizontal padding down to 16 px, the composer becomes fixed with
`padding-bottom: env(safe-area-inset-bottom)`, and the suggestion grid collapses to one column.
Long code blocks inside answers get their own horizontal scroll container so they never widen the
page.

### 12.5 `/app/documents` — Document library

New surface. Today documents are a non-interactive list in the sidebar.

| | |
| --- | --- |
| **Purpose** | See, search, and manage what the workspace knows |
| **Primary CTA** | "Upload document" (opens a dialog route) |
| **Secondary** | Search · filter by status · sort · grid/table toggle · per-row menu |
| **Auth** | Auth + tenant |

Header: title, document count, total size, and the upload button. Toolbar: a debounced search
input (client-side over `filename` — the list endpoint has no query parameter, so server-side
search is backend work), a status filter (`PENDING`/`PROCESSING`/`COMPLETED`/`FAILED` — the exact
model enum), and a sort control (newest, name, size).

Each row/card shows the filename, a `StatusPill`, `formatBytes(fileSize)`, `totalChunks`,
`formatRelativeTime(createdAt)`, and a `⋯` menu (Ask about this · View details · Copy ID ·
Delete). **Delete has no endpoint** — it renders disabled with a tooltip explaining why rather
than being hidden, so the gap is visible to whoever picks up the backend work.

**Upload flow** (`/app/documents/upload`, a modal route so it is linkable and `Escape`-closable):
a real `Dropzone` — a `<button>`, not a `<div>`, so it is keyboard-reachable, with `aria-label`,
drag-over state, and a visible file picker fallback. Client-side validation before any request:
mimetype must be `application/pdf`, size must be under a **single shared constant**
(`MAX_UPLOAD_BYTES`) whose value is also printed in the hint text — killing the three-way
contradiction in §6.1 #3. Multiple files upload sequentially with a per-file progress row
(`XMLHttpRequest` for real progress events; `fetch` cannot report upload progress).

On success, show what the API actually returned instead of discarding it: pages,
`chunksProcessed`, and — when `chunksSkipped > 0` — a warning strip
("3 of 214 chunks could not be embedded and were skipped"). That warning currently exists only in
a server-side `console.warn`, so users silently get partially indexed documents.

`/app/documents/:documentId` opens a detail panel (right `Drawer` on desktop, full page on mobile):
metadata, processing timeline from `processingStartedAt`/`processingCompletedAt`, chunk count, and
an "Ask about this document" CTA that returns to `/app` with the composer pre-seeded.

**States.** Loading: 6 skeleton rows. Empty: illustrated `EmptyState` — "No documents yet" + an
inline dropzone + a line explaining that answers are only as good as the corpus. Filtered-empty is
a *different* state: "No documents match 'invoice'" + Clear filters. Error: `ErrorState` with
Retry. Per-row `FAILED`: red pill + a "Re-upload" action, since no reprocess endpoint exists.

**Responsive.** Table above `lg`; cards below. The `⋯` menu becomes a bottom sheet under `sm`.
Touch targets stay ≥ 44 px.

### 12.6 `/app/settings/*` — Settings

A tabbed section (`Tabs` on desktop, a select on mobile) with four panes.

| Pane | Contents | Backend today |
| --- | --- | --- |
| **Workspace** | Name, slug (with the same live preview as onboarding), created date, document/chunk counts | Read-only — no `PATCH /api/tenants/:id`. Fields render disabled with an explanatory note |
| **API keys** | `tenant.apiKey` masked as `dm_live_••••••••3f2a`, a reveal toggle, a copy button with a "Copied" confirmation, and a warning panel about treating it as a secret | **Already returned by `/api/auth/me` and has zero UI today.** This pane is pure value with no backend work |
| **Members** | The current user with their `role` badge (`owner`/`member`), plus a disabled "Invite" button | Read-only — no members endpoint |
| **Account** | First/last name, email (read-only), change password (disabled — no endpoint), theme selector (system/dark/light), reduced-motion preference, sign out |

The reveal-only-on-demand pattern for the API key matters: rendering a live credential in plain
text by default is how keys end up in screenshots and screen-share recordings.

**States.** Loading: skeleton rows. Error: inline `Alert` per pane, so one failing pane does not
blank the page. Every disabled control has a tooltip naming the missing endpoint — the UI documents
its own gaps rather than pretending they do not exist.

### 12.7 Error routes

| Route | Treatment |
| --- | --- |
| `/403` | "You don't have access to this workspace" + workspace switcher + sign-out. Reached on `TENANT_MISMATCH` |
| `/*` (public) | Marketing chrome, large `404`, search-free, links back to `/` and `/app` |
| `/app/*` | In-shell 404 so the user keeps their sidebar and does not feel ejected |
| Route-level crash | `RouteError` from React Router's `errorElement`: apology, `Try again` (revalidate), `Reload`, and a collapsed stack trace **only** in dev |

### 12.8 Global overlays

- **Command palette (`⌘K` / `Ctrl+K`)** — jump to a document, start a new thread, open settings,
  toggle theme, sign out. Cheap to build on Radix `Dialog` + a filtered list, and it is the fastest
  way for a returning user to reach a specific document.
- **Toaster** — bottom-right on desktop, top-centre on mobile, `role="status"`, auto-dismiss 5 s,
  max 3 stacked. Replaces the current toast implementation whose icon map is three empty strings.
- **Session-expired dialog** — see §11.1; preserves composer contents across re-auth.

---

## 13. Authentication UI/UX Plan

### 13.0 The shared shell

`AuthLayout` is a two-column split above `lg` and a single centred column below.

- **Left (60%)** — brand panel: logo lockup, a one-sentence value line, three tick-marked proof
  points, and a soft Icy Blue orb field. Static content, `aria-hidden` where decorative. This
  replaces dead space with a reason to continue signing up, and it is where the palette gets to
  breathe without touching form legibility.
- **Right (40%)** — the form card: `max-width: 420px`, `ink-850` at 70% opacity,
  `backdrop-blur(24px)`, `1px ink-700` border, 24 px radius, and one soft shadow. On mobile the
  brand panel collapses to just the logo above the card.

Two structural fixes over the current pages: the container uses `min-height: 100dvh` with
`overflow-y: auto` (the existing `overflow: hidden` clips the signup card on short viewports), and
`100dvh` rather than `100vh` so mobile browser chrome does not cause a jump.

**Field pattern.** Real `<label>` above the input — not the current
`::placeholder { color: transparent }` floating-label trick, which announces a placeholder to
screen readers that sighted users cannot see and leaves the visible label unassociated. Inputs:
44 px min height, 16 px font (prevents iOS zoom), `ink-900` fill, `1px ink-700` border → `sky-200`
on focus with a 3 px `sky-200/20` ring via `:focus-visible`. Errors: border → `error`, message
below in `error` colour with an icon, wired through `aria-describedby` + `aria-invalid`.

### 13.1 `/login`

**Fields.** Email (`type="email"`, `autoComplete="email"`, `inputMode="email"`), password
(`autoComplete="current-password"`) with a show/hide `IconButton` (`aria-label` toggles between
"Show password" / "Hide password", `aria-pressed` reflects state), a "Remember me" checkbox, and a
"Forgot password?" link on the same row.

**What "remember me" actually does.** Checked (default) → tokens in `localStorage`; unchecked →
`sessionStorage`, so the session dies with the tab. Real behaviour, not decoration.

**Validation** (`loginSchema`): email must parse; password non-empty. On-blur for touched fields,
on-submit for all. The client does **not** enforce a password minimum here — a wrong-length
password is a credentials failure, and pre-validating it leaks the policy.

**Zod → the backend's real rules.** `email: z.string().trim().toLowerCase().email()`,
`password: z.string().min(1)`. Email lowercasing matters: `User.email` is unique, and the
current form sends whatever case the user typed.

| State | Treatment |
| --- | --- |
| Idle | Submit is enabled — disabling it until valid hides *why* it cannot be pressed |
| Submitting | Button shows a spinner + "Signing in…", inputs `readOnly`, `aria-busy="true"` |
| Invalid credentials (`401`) | One `Alert` above the fields: "That email or password is incorrect." Both fields get `aria-invalid`; the password field is cleared and refocused. **Never** distinguish "no such user" from "wrong password" — that is an account-enumeration oracle |
| Validation failure | Field-level messages; focus moves to the first invalid field |
| Rate limited (`429`) | Alert with the retry window if the response provides one |
| Network / `5xx` | "We couldn't reach the server." + a Retry button that re-submits |
| Success | Tokens stored → session store populated → `navigate(next ?? (tenantId ? '/app' : '/onboarding/workspace'))`. No success toast; arriving is the confirmation |

**Removals.** The demo-credentials panel and the `value="admin@gmail.com"` /
`value="Admin@123"` attributes are deleted. Those are live credentials in a public repository; the
account's password should also be rotated, since git history retains them regardless of this
change.

### 13.2 `/signup`

**Fields.** First name + last name (2-up above `sm`, stacked below; `autoComplete="given-name"` /
`family-name`), email, password (`autoComplete="new-password"`), confirm password, and a required
terms checkbox with real links to `/legal/terms` and `/legal/privacy`.

**Password strength meter — preserved, improved.** Keep the existing 4-point algorithm exactly
(+1 each for length ≥ 8, mixed case, a digit, a symbol → `Weak / Fair / Good / Strong`) so the
signal users already see does not change meaning. Three improvements:

1. Four segments coloured `error → warning → sky-300 → success`, animating width on change.
2. A checklist beneath it showing which criteria are met (`Check` / `Circle` icons), so "Fair" is
   actionable rather than a verdict.
3. The whole meter lives in an `aria-live="polite"` region announcing only the label change, not
   every keystroke.

**It stays advisory.** The backend enforces only `length >= 8` (`src/api/auth.js:20`), and
`User.password` validates `len: [8, 128]`. Blocking submission on "Strong" would invent a policy
the server does not have and would diverge the moment either side changes. Zod therefore enforces
`min(8).max(128)` — matching the model — plus `refine` for the confirm match.

**Confirm password.** Live match feedback after the field is touched: a green check when equal, an
inline "Passwords don't match" when not. Preserved from the current implementation, which does this
well.

| State | Treatment |
| --- | --- |
| Submitting | Spinner + "Creating account…" |
| Email taken (`409`) | Field-level error on email: "An account with this email already exists." + an inline "Sign in instead" link carrying the typed email through as `?email=` |
| Weak/short password (`400`) | Field-level, mirroring the server message |
| Validation | Per-field; focus to first invalid |
| Network / `5xx` | Banner + Retry |
| Success | Tokens stored → **`/onboarding/workspace`**, never `/app` — a fresh user has no `tenantId` and would immediately 403 |

### 13.3 Password recovery — new, and currently unbacked

**There is no recovery path in the product at all**: no link, no page, no endpoint. A forgotten
password today means a lost account. The UI is built now against a documented contract so that
wiring it later is a two-line change in `endpoints.ts`.

Required backend (recorded in §22, not built here):

```text
POST /api/auth/forgot-password   { email }            → 200 always (no enumeration)
POST /api/auth/reset-password    { token, password }  → 200 | 400 INVALID_TOKEN | 410 EXPIRED
```

Until those exist, the routes are gated behind `VITE_FEATURE_PASSWORD_RESET`. With the flag off,
the login page's "Forgot password?" opens a small dialog explaining how to reach support instead of
linking to a form that cannot work — a dead form is worse than an honest message.

**Screen 1 — `/forgot-password`.** One email field, "Send reset link", and a "Back to sign in"
link. On submit it **always** shows the same confirmation regardless of whether the address exists:
a mail icon, "Check your inbox", the address echoed back, a "Resend" button on a 60-second cooldown
with a visible countdown, and a "Wrong address?" link that returns to the form. Uniform responses
are the whole point — a different message for unknown addresses turns the form into an account
enumeration tool.

**Screen 2 — `/reset-password?token=…`.** Reads the token from the query string. If absent or
malformed, render an `ErrorState` immediately instead of a form that will certainly fail. New
password + confirm, with the same strength meter and rules as signup. Success: a check animation,
"Password updated", then `/login` after ~1.5 s with a toast. Expired token (`410`): a dedicated
state offering "Request a new link", not a generic error.

**Screen 3 — `/verify-email?token=…`** (only if verification is added): three states —
verifying (spinner), verified (check + "Continue to workspace"), failed (resend).

### 13.4 Session and route behaviour

**Initialisation.** On boot, `sessionStore.status = 'loading'`; a `useSession` hook calls
`GET /api/auth/me` once. Success populates `user` + `tenant` and sets `'authed'`; a `401` attempts
one refresh, and on failure clears tokens and sets `'anon'`. Guards render skeletons during
`'loading'` — never a blank screen, and never a full-page spinner for what is usually a sub-200 ms
call.

**The refresh queue.** This is the fix for §6.1 #2. `apiClient` intercepts `401` with code
`TOKEN_EXPIRED`, and:

1. If no refresh is in flight, it starts one and stores the promise.
2. Concurrent `401`s **await that same promise** rather than each firing their own refresh — five
   parallel requests must not produce five refresh calls, four of which race and revoke each other.
3. On success, every queued request is replayed once with the new access token.
4. On failure, tokens are cleared, `status` becomes `'anon'`, and `SessionExpiredDialog` opens.

Refresh is attempted exactly once per request; `TOKEN_REVOKED` (a blacklisted `jti` after logout)
skips refresh entirely and goes straight to sign-out, because retrying is guaranteed to fail.

**Logout.** Optimistic: clear local state and navigate immediately, then fire
`POST /api/auth/logout` in the background. If it fails the user is still signed out locally, which
is the behaviour they asked for; the server-side blacklist entry is best-effort. Query cache is
cleared (`queryClient.clear()`) so a subsequent login cannot see the previous user's documents —
a real leak risk on shared machines.

**Token storage.** All access is confined to `lib/tokenStorage.ts` with a five-method interface
(`get`, `set`, `clear`, `subscribe`, `setPersistent`). `localStorage` is XSS-readable and is a
known compromise (§22); confining it to one module means swapping to httpOnly cookies later touches
one file plus `apiClient`'s credentials mode. A `storage` event listener keeps tabs in sync, so
signing out in one tab signs out the others.

---

## 14. Component Architecture

Three tiers, each with a rule about what it may know.

### 14.1 Tier 1 — `components/ui/` (knows nothing about DocMind)

| Component | Notes |
| --- | --- |
| `Button` | `variant`: primary (Icy Blue fill, near-black label) · secondary (`ink-800` fill) · ghost · danger · link. `size`: sm/md/lg. Props `loading`, `leftIcon`, `rightIcon`, `fullWidth`. `loading` sets `aria-busy`, keeps the label mounted, and locks the width so the button never resizes mid-request |
| `IconButton` | Requires `aria-label` at the type level — `label: string` is not optional |
| `Input` / `Textarea` | Own their label, hint, error, and `aria-describedby` wiring so no caller can forget it |
| `Select` `Checkbox` `Switch` `RadioGroup` | Radix-based; visible `:focus-visible` rings |
| `Card` | `elevation` 0–3 mapping to the surface ramp, not to shadows |
| `Badge` / `Pill` | `tone`: neutral/accent/success/warning/error. `StatusPill` (documents) is a domain wrapper, not a variant |
| `Alert` | `role="alert"` for errors, `role="status"` for info; optional action slot |
| `Dialog` / `Drawer` / `Sheet` | Radix `Dialog` with three presentations; focus trap, `Escape`, scroll lock, and restore-focus for free |
| `DropdownMenu` `Tooltip` `Popover` `Tabs` `Collapsible` | Radix wrappers, styled once |
| `Progress` | Determinate (upload) and indeterminate (processing) |
| `Spinner` / `Skeleton` | Skeleton shimmer disabled under `prefers-reduced-motion` |
| `EmptyState` / `ErrorState` | Slots for illustration, title, description, primary + secondary action |
| `Container` / `Section` / `Kbd` / `VisuallyHidden` / `Separator` | Layout and a11y utilities |

Every one of these takes `className` merged through `cn()` (`clsx` + `tailwind-merge`) and forwards
refs. No component reads global state.

### 14.2 Tier 2 — `components/layout/`

`RootLayout` mounts providers (QueryClient, MotionConfig, Toaster, theme, error boundary) and the
skip-to-content link. `MarketingLayout`, `AuthLayout`, `OnboardingLayout`, and `AppLayout` are the
four shells; `Sidebar` and `Topbar` belong to the last. Shells may read `uiStore` and `sessionStore`
but contain no feature logic.

### 14.3 Tier 3 — `features/*/components/`

Feature components may use Tier 1 and 2, read stores, and call their own feature hooks. They may
**not** import from another feature — cross-feature needs get promoted to Tier 1 or expressed
through routing. Concretely: `SourceCard` lives in `chat/` and takes plain props; it does not import
`documents/DocumentCard`, even though both render a filename.

### 14.4 Components deliberately not built

`DataTable` (one table, and it needs no virtualisation at realistic document counts),
`FormBuilder` (five forms, each better written explicitly), a theme-provider abstraction (a
`data-theme` attribute on `<html>` plus CSS variables is enough), and any generic `Layout` with a
dozen boolean props. Each of these is the kind of abstraction that looks scalable and then has to be
fought.

---

## 15. Design System

One file, `web/src/styles/theme.css`, is the source of truth. Tailwind v4's `@theme` emits every
entry as a real CSS custom property, so tokens are inspectable in DevTools and themeable at runtime
without a rebuild.

### 15.1 Primitive ramps

Both ramps are hue 206 — the shared hue of Icy Blue and Gunmetal (§7.3). Ratios are measured against
`--ink-950`.

```css
@theme {
  /* Ink — surfaces and text. Gunmetal #35393C is ink-600, the source colour. */
  --color-ink-950: #0A0D0F;   /* app background                              */
  --color-ink-900: #0F1418;   /* sidebar, marketing sections                 */
  --color-ink-850: #141A1F;   /* cards, auth card base                       */
  --color-ink-800: #1D242A;   /* elevated cards, inputs, user bubble         */
  --color-ink-700: #252E35;   /* borders, dividers                           */
  --color-ink-600: #35393C;   /* GUNMETAL — strong borders, disabled fills   */
  --color-ink-500: #4A545C;   /* inactive icons                              */
  --color-ink-400: #6B757E;   /*  4.15:1 — decorative + disabled text ONLY   */
  --color-ink-350: #7C8792;   /*  5.33:1 — muted text (AA)                   */
  --color-ink-200: #B4BEC7;   /* 10.30:1 — secondary text                    */
  --color-ink-50:  #EDF1F5;   /* 17.20:1 — primary text                      */

  /* Sky — the accent. Icy Blue #A4D8FF is sky-200, the source colour. */
  --color-sky-100: #D6ECFF;   /* hover-lighten on the CTA                    */
  --color-sky-200: #A4D8FF;   /* ICY BLUE — 12.85:1 — the brand colour       */
  --color-sky-300: #7CC2F5;   /* pressed CTA, secondary accent               */
  --color-sky-400: #4FA8E8;   /* charts, progress fills                      */
  --color-sky-500: #2489D4;   /* mid — gradients                             */
  --color-sky-600: #0A6EBF;   /* LIGHT-MODE primary (white text = 5.26:1)    */
  --color-sky-700: #0A578F;   /* light-mode pressed                          */

  /* Semantic — chosen to be distinguishable from sky at a glance */
  --color-success: #3FBF7F;   /* 8.33:1 */
  --color-warning: #E0A33E;   /* 8.80:1 */
  --color-error:   #E5484D;   /* 4.98:1 */
  --color-info:    #A4D8FF;   /* = sky-200 */
}
```

`--color-ink-400` is annotated deliberately: at 4.15:1 it fails AA for body text. It exists for
placeholder glyphs, disabled labels, and decorative strokes, and the lint-adjacent rule is that it
never carries information. The current design uses a colour in this range for real body copy, which
is one of its concrete contrast failures (§5.3).

### 15.2 Semantic tokens

Components consume only these. Nothing in `features/` or `components/` references a primitive ramp
directly — that indirection is what makes light mode a 20-line override instead of an audit.

```css
:root, [data-theme="dark"] {
  --bg-base:        var(--color-ink-950);
  --bg-subtle:      var(--color-ink-900);
  --surface:        var(--color-ink-850);
  --surface-raised: var(--color-ink-800);
  --surface-glass:  color-mix(in oklab, var(--color-ink-850) 70%, transparent);

  --text-primary:   var(--color-ink-50);
  --text-secondary: var(--color-ink-200);
  --text-muted:     var(--color-ink-350);
  --text-disabled:  var(--color-ink-400);
  --text-on-accent: var(--color-ink-950);   /* near-black on Icy Blue — 12.85:1 */

  --border-subtle:  var(--color-ink-700);
  --border-strong:  var(--color-ink-600);
  --border-focus:   var(--color-sky-200);

  --accent:         var(--color-sky-200);
  --accent-hover:   var(--color-sky-100);
  --accent-active:  var(--color-sky-300);
  --accent-wash:    color-mix(in oklab, var(--color-sky-200) 8%, transparent);
  --accent-ring:    color-mix(in oklab, var(--color-sky-200) 20%, transparent);
}

[data-theme="light"] {
  --bg-base: #F7F9FB;  --bg-subtle: #EFF3F7;
  --surface: #FFFFFF;  --surface-raised: #FFFFFF;
  --surface-glass: color-mix(in oklab, #FFFFFF 75%, transparent);

  --text-primary: #101418;  --text-secondary: #3E4A54;
  --text-muted: #5C6873;    --text-disabled: #9AA5AF;
  --text-on-accent: #FFFFFF;               /* white on sky-600 — 5.26:1 */

  --border-subtle: #DDE4EA;  --border-strong: #C3CDD6;
  --accent: var(--color-sky-600);
  --accent-hover: var(--color-sky-700);
  --accent-active: var(--color-sky-700);
  --accent-wash: color-mix(in oklab, var(--color-sky-200) 22%, transparent);
}
```

Note the one asymmetry: `--text-on-accent` flips from near-black (dark mode, on Icy Blue) to white
(light mode, on `sky-600`). That is the direct consequence of §7.4 — white on `#A4D8FF` is 1.52:1
and can never be used. Encoding it as a token means no component has to remember the rule.

Theme resolution: `<html data-theme>` is set by a tiny blocking inline script in `index.html` that
reads `localStorage.theme ?? matchMedia('(prefers-color-scheme: dark)')`, so there is no
flash-of-wrong-theme before React hydrates. Default is dark.

### 15.3 Typography

```css
@theme {
  --font-sans:    "Inter Variable", ui-sans-serif, system-ui, sans-serif;
  --font-display: "Inter Tight Variable", var(--font-sans);
  --font-mono:    "JetBrains Mono Variable", ui-monospace, monospace;

  --text-xs:   0.75rem;   /* 12px — captions, chunk labels          lh 1.5  */
  --text-sm:   0.875rem;  /* 14px — secondary, table cells          lh 1.5  */
  --text-base: 1rem;      /* 16px — body, inputs (no iOS zoom)      lh 1.6  */
  --text-lg:   1.125rem;  /* 18px — lead paragraphs                 lh 1.6  */
  --text-xl:   1.375rem;  /* 22px — card titles / h4                lh 1.4  */
  --text-2xl:  1.75rem;   /* 28px — section h3                      lh 1.3  */
  --text-3xl:  2.25rem;   /* 36px — page h2                         lh 1.2  */
  --text-4xl:  3rem;      /* 48px — h1                              lh 1.1  */
  --text-hero: clamp(2.5rem, 6vw, 4.5rem);  /* landing h1 only      lh 1.05 */
}
```

Eleven ad-hoc sizes collapse to nine deliberate ones. Rules: display sizes (`3xl`+) use
`Inter Tight` with `letter-spacing: -0.02em`; body sizes use `Inter` at default tracking; only
`--text-hero` is fluid, because body text that scales with the viewport fights the user's own font
setting. Body copy never drops below `--text-sm`, and `--text-xs` is reserved for genuine
metadata. Weights are limited to 400 / 500 / 600 / 700 — the current five-weight spread produces
distinctions nobody can perceive. The prose column caps at `72ch`.

### 15.4 Spacing, radius, shadow, motion

```css
@theme {
  /* 4px base; the only legal gaps and paddings */
  --spacing-1: 0.25rem;  --spacing-2: 0.5rem;   --spacing-3: 0.75rem;
  --spacing-4: 1rem;     --spacing-5: 1.25rem;  --spacing-6: 1.5rem;
  --spacing-8: 2rem;     --spacing-10: 2.5rem;  --spacing-12: 3rem;
  --spacing-16: 4rem;    --spacing-20: 5rem;    --spacing-24: 6rem;

  --radius-sm: 6px;   --radius-md: 10px;  --radius-lg: 14px;
  --radius-xl: 20px;  --radius-2xl: 28px; --radius-full: 9999px;

  /* Elevation is surface-first; shadows only for floating layers */
  --shadow-sm: 0 1px 2px rgb(0 0 0 / 0.30);
  --shadow-md: 0 4px 12px rgb(0 0 0 / 0.35);
  --shadow-lg: 0 12px 32px rgb(0 0 0 / 0.45);
  --shadow-glow: 0 0 40px color-mix(in oklab, var(--color-sky-200) 14%, transparent);

  --ease-out:   cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in-out:cubic-bezier(0.65, 0, 0.35, 1);
  --dur-fast: 120ms;  --dur-base: 200ms;  --dur-slow: 320ms;  --dur-slower: 480ms;

  --sidebar-w: 280px;  --sidebar-collapsed-w: 64px;
  --topbar-h: 56px;    --prose-max: 72ch;
}
```

---

## 16. Responsive Design Strategy

Mobile-first, five breakpoints, Tailwind defaults kept so nothing has to be memorised.

| Token | Min width | Target | Layout behaviour |
| --- | --- | --- | --- |
| *(base)* | 0 | Phone | Single column. Sidebar is a drawer. Composer fixed to the bottom |
| `sm` | 640 px | Large phone | 2-up name fields, side-by-side dialog actions |
| `md` | 768 px | Tablet | Landing sections go 2-up; document cards 2-up; drawer still |
| `lg` | 1024 px | Laptop | **Persistent sidebar appears.** Landing 3-up. Document table replaces cards |
| `xl` | 1280 px | Desktop | Wider prose, sources can sit beside the answer |
| `2xl` | 1536 px | Large display | Content caps and centres; no further growth |

`lg` is the meaningful line — it is where the sidebar stops being an overlay. Above `2xl` nothing
gets wider; a 2,560 px monitor gets more margin, not longer lines.

**Per-surface behaviour**

- **Marketing** — hero centres and stacks under `md`; CTA pair becomes two 48 px-tall full-width
  buttons; the product mock drops its 3D tilt (perspective on a phone reads as a bug); nav collapses
  to a hamburger drawer; footer columns go 4 → 2 → 1.
- **Auth** — the brand panel is hidden under `lg` (replaced by the logo alone). The card goes
  full-bleed with 16 px gutters under `sm`. Container is `min-h-100dvh` + `overflow-y-auto` — the
  fix for the clipped-signup-card bug.
- **Onboarding** — the step rail turns into a pill plus a 2-segment progress bar. The slug preview
  truncates the middle rather than wrapping.
- **Chat** — the drawer sidebar gets a focus trap, `Escape`, and swipe-to-dismiss. The composer uses
  `padding-bottom: env(safe-area-inset-bottom)` for iPhone home-bar clearance, and the layout uses
  `100dvh` so the mobile URL bar collapsing does not shove the composer offscreen. Suggestions go
  1-up. Sources stack. Code blocks scroll horizontally inside their own container.
- **Documents** — table above `lg`, cards below; the row menu becomes a bottom sheet under `sm`;
  the detail drawer becomes a full page.
- **Settings** — horizontal `Tabs` above `md`, a native `Select` below (a mobile tab strip that
  scrolls horizontally hides options).

**Non-negotiables.** Every interactive target is ≥ 44 × 44 px on touch. Inputs are 16 px to prevent
iOS zoom-on-focus. No fixed pixel widths outside the sidebar and card maxima. Any horizontal
overflow is opt-in and scoped (tables, code blocks) — never on `body`. All of this is verified at
320 px, 375 px, 768 px, 1024 px, 1440 px, and 2560 px before a surface is considered done.

---

## 17. Animation & Interaction Strategy

The test each animation must pass: **does removing it make the interface harder to understand?** If
not, it does not ship. That excludes most decorative motion and keeps the pieces that carry meaning
— state change, spatial relationship, and progress.

### 17.1 The motion budget

| Purpose | Duration | Easing | Where |
| --- | --- | --- | --- |
| Micro-feedback | 120 ms | `ease-out` | Hover, press, focus ring, checkbox, switch |
| State change | 200 ms | `ease-out` | Alerts, disclosure, tab indicator, tooltip |
| Layer entry/exit | 240–320 ms | `ease-out` | Dialog, drawer, popover, toast |
| Page transition | 200 ms | `ease-out` | Route change: 8 px rise + fade |
| Reveal on scroll | 480 ms | `ease-out` | Landing sections, `once: true`, 60 ms stagger |
| Ambient | 20 s | linear | Auth/hero orb drift only |

Nothing exceeds 480 ms except ambient loops. A 600 ms page transition feels broken by the third
navigation.

### 17.2 What animates, and why

- **Route transitions** — `AnimatePresence` with an 8 px vertical rise. Gives the app continuity
  instead of the current hard `window.location` reloads. Deliberately short.
- **Streaming answer** — tokens append with no per-token animation (animating each token is both
  distracting and a performance trap). The only motion is a 2 px `sky-200` block cursor blinking at
  1 s intervals, and the sources panel sliding in when the `sources` frame arrives.
- **Message entry** — `layout` animation so an appended message pushes the stream up smoothly
  rather than jumping. Auto-scroll only when the user is within 80 px of the bottom, so reading
  history is never hijacked.
- **Upload progress** — a determinate bar plus a per-file row that slides in; on success the row
  morphs into a result summary (pages, chunks). Motion here communicates real progress.
- **Sources disclosure** — height + opacity, 200 ms. Grid-based (`grid-template-rows: 0fr → 1fr`)
  so it animates to content height without measuring.
- **Suggestion cards** — 60 ms stagger on mount; hover lifts 2 px and warms the border.
- **Password strength meter** — segment widths and colours transition on change; makes the rating
  feel responsive rather than jumpy.
- **Skeletons** — a single shimmer sweep, 1.6 s, low contrast.
- **Orbs** — two blurred Icy Blue radials at 12% opacity, `translate` + `scale` over 20 s. Kept from
  the current design because it is the one ambient effect that earns its place, but reduced from
  three orbs to two and dropped in opacity.

### 17.3 Reduced motion and performance

One global `<MotionConfig reducedMotion="user">` at the root makes every Motion component respect
the OS setting, and a `@media (prefers-reduced-motion: reduce)` block sets
`animation: none; transition-duration: 0.01ms` for CSS-driven effects, kills the orbs and the
skeleton shimmer, and turns route transitions into instant swaps. **Nothing is lost** — every
animated state also has a static representation. The current build has three infinite animations and
zero reduced-motion handling, which is an accessibility defect, not a stylistic choice.

Performance rules: animate `transform` and `opacity` only; no `width`, `height`, `top`, or
`box-shadow` transitions in hot paths. `will-change` is applied on hover intent and removed after.
`backdrop-filter` is limited to three simultaneous surfaces. The message list is not virtualised
initially — at ~200 messages it does not need to be, and `content-visibility: auto` on off-screen
messages is the cheaper first move if it ever does.

---

## 18. Accessibility Strategy

Target: **WCAG 2.1 AA**, verified rather than asserted. Every defect in §6.4 has a specific fix here.

### 18.1 Structure and semantics

One `<h1>` per page, no skipped heading levels. Landmarks on every shell: `<header>`, `<nav>`,
`<main id="main">`, `<aside>`, `<footer>`. A skip-to-content link is the first focusable element on
every page — visually hidden until focused, then a solid Icy Blue chip. Buttons are `<button>`,
links are `<a>`; the current drop zone is a `<div>` with a click handler, which is why upload is
impossible by keyboard today.

### 18.2 Keyboard

Everything interactive is reachable in DOM order, and DOM order matches visual order. No positive
`tabindex` anywhere.

| Key | Behaviour |
| --- | --- |
| `Tab` / `Shift+Tab` | Move focus; trapped inside dialogs and the mobile drawer, restored to the trigger on close |
| `Enter` / `Space` | Activate buttons; `Enter` submits forms and sends messages |
| `Shift+Enter` | Newline in the composer (preserved from today) |
| `Escape` | Close dialog, drawer, popover, command palette; also cancels a stream |
| `⌘K` / `Ctrl+K` | Command palette |
| `/` | Focus the composer (ignored while typing in a field) |
| `↑` / `↓` | Navigate menus, palette results, document rows |
| `⌘Enter` | Send from anywhere in the composer |

`:focus-visible` gets a 2 px `sky-200` outline with a 2 px offset — never `outline: none` without a
replacement, which the current CSS does in several places.

### 18.3 Forms

Every input has a real `<label for>` — the `::placeholder { color: transparent }` floating-label
trick is removed entirely, since it announces a placeholder to screen readers that sighted users
cannot see. Errors are wired with `aria-invalid` + `aria-describedby`, announced through
`role="alert"`, and always textual as well as coloured. Required fields are marked in the label, not
by colour. Submission failures move focus to the first invalid field. Correct `autocomplete` values
throughout (`email`, `current-password`, `new-password`, `given-name`, `family-name`) so password
managers work — they currently do not on the signup form.

### 18.4 Live regions

Three, and no more (over-announcing is as bad as silence):

1. **Streaming answer** — `aria-live="polite"` `aria-atomic="false"` on the assistant message, so
   the answer is read as it arrives rather than in silence.
2. **Toasts** — `role="status"`, `aria-live="polite"`.
3. **Async status** — upload progress and the password-strength label, `aria-live="polite"`,
   throttled to announce state changes only, not every keystroke or percent.

### 18.5 Colour, motion, and verification

All text pairings in §15 are measured, not estimated (§7.4, §15.1). `--color-ink-400` is fenced off
for non-informational use. Colour is never the sole signal: status pills carry an icon and a word,
the strength meter carries a label and a checklist, validation errors carry text. `prefers-reduced-motion`
is honoured globally (§17.3). Screen readers get no emoji, because every emoji is replaced by an SVG
with either an `aria-label` or `aria-hidden`.

Verification: `eslint-plugin-jsx-a11y` in CI; `@axe-core/playwright` asserting zero violations on
`/`, `/login`, `/signup`, `/onboarding/workspace`, `/app`, `/app/documents`, and `/app/settings/*`;
plus one manual keyboard-only pass and one screen-reader pass (NVDA or VoiceOver) per surface before
it is called done. Automated tooling catches roughly half of real issues — the manual passes are not
optional.

---

## 19. Performance Strategy

Where optimisation actually matters here, in order: **time to first meaningful paint on the landing
page**, **time to interactive on `/app`**, and **smoothness of the streaming answer**. Everything
else is speculative.

### 19.1 Bundle and loading

Route-level code splitting via `React.lazy` on every leaf. The natural chunks:

| Chunk | Contents | Why separate |
| --- | --- | --- |
| `vendor-react` | react, react-dom, react-router | Changes rarely — long cache life |
| `vendor-ui` | radix, motion, lucide | Shared across app routes |
| `marketing` | Landing, Pricing, Legal | An anonymous visitor must never download the chat app |
| `auth` | Login, Signup, recovery | Small, needed early |
| `app` | Chat, Documents, Settings | Behind auth; loads while `/me` resolves |
| `markdown` | react-markdown + remark + rehype | The heaviest dependency; only the chat route needs it |

The markdown split is the one that matters most — it is a large tree, and it should not be in the
critical path of a login page. Prefetch on hover/focus of the primary nav links so a click feels
instant, and prefetch the `app` chunk during the auth request rather than after it.

Budgets, enforced in CI: initial JS for `/` ≤ 120 KB gzipped, `/app` ≤ 220 KB gzipped, CSS ≤ 25 KB,
LCP < 2.0 s on a simulated 4G/mid-tier device, CLS < 0.05, INP < 200 ms.

### 19.2 Fonts and images

Self-hosted variable fonts with `font-display: swap`, subset to `latin`, and exactly two preloaded
files (Inter 400–700 variable, Inter Tight for display). JetBrains Mono loads lazily since it only
appears in code blocks and slug previews. This removes the two Google Fonts round trips the current
pages make on **every** navigation.

Images: SVG for logo, icons, and illustrations (inline, so they inherit `currentColor`); AVIF with a
WebP fallback for the landing product mock, served at 1×/2× via `srcset`; explicit `width`/`height`
on everything to keep CLS at zero; `loading="lazy"` + `decoding="async"` below the fold. The four
palette references in `src/images/` are **not** shipped.

### 19.3 Runtime

- **Streaming** is the hot path. Tokens arrive faster than paint is useful, so appends are batched
  through a ~50 ms `requestAnimationFrame` flush rather than one `setState` per token. Only the tail
  message re-renders; earlier messages are memoised on a stable id.
- **Markdown** re-parses the growing string on each flush. `Markdown` is memoised on content, and
  during streaming the answer renders as pre-wrapped plain text with a single markdown parse on
  `done` if profiling shows parsing dominating. Correctness first, then measure.
- **Query cache** — `staleTime: 30_000` for documents and profile, `refetchOnWindowFocus: false`
  (a chat app refetching on every tab switch is noise), `retry: 1` with no retry on `4xx`.
- **Re-renders** — Zustand selectors are narrow (`useUIStore(s => s.sidebarOpen)`), context is split
  so theme changes do not re-render the message list, and `useCallback` is used only where a memoised
  child actually depends on it.
- **Long lists** — no virtualisation initially. `content-visibility: auto` on off-screen messages and
  document rows is the first lever; `@tanstack/react-virtual` is only justified past ~500 rows.

### 19.4 Caching and delivery

Vite emits content-hashed filenames, so `index.html` is `no-cache` while `/assets/*` is
`immutable, max-age=31536000`. Nginx needs `gzip`/`brotli` enabled for JS, CSS, SVG, and JSON —
worth confirming, since the current config addresses SSE buffering but not static compression.

---

## 20. Future Backend Integration Strategy

The backend already exists and works, so "future integration" here means two things: a boundary
clean enough that the API can change without touching components, and a short list of backend edits
needed at ship time.

```text
Components          →  never call fetch, never read a token
Feature hooks       →  useDocuments, useUploadDocument, useStreamQuery, useLogin
lib/api/endpoints   →  one typed function per HTTP route
lib/api/client      →  auth header, refresh queue, error normalisation
Express API         →  unchanged this phase
```

### 20.1 `apiClient`

A single `fetch` wrapper responsible for four things, so nothing else has to be:

1. **Base URL** — `import.meta.env.VITE_API_BASE_URL ?? '/api'`. In dev, Vite proxies `/api` to
   `http://localhost:4500`; in production it is same-origin. No `localhost` ever reaches a component.
2. **Auth header** — reads `tokenStorage.get()` and sets `Authorization: Bearer …`.
3. **Refresh queue** — the single-flight logic in §13.4. This one implementation fixes the defect
   where only `/api/auth/me` currently refreshes.
4. **Error normalisation** — every failure becomes an `ApiError { status, code, message, details }`,
   where `code` is the backend's own string (`TOKEN_EXPIRED`, `TENANT_REQUIRED`, `TENANT_MISMATCH`,
   `TOKEN_REVOKED`). Components branch on `code`, never on a message string — the current pages
   substring-match error text, which breaks the moment copy changes.

### 20.2 Typed endpoints

`lib/api/endpoints.ts` mirrors the mounted Express routes exactly, one function each:

```text
auth.signup(body)                      POST   /auth/signup
auth.login(body)                       POST   /auth/login
auth.refresh(refreshToken)             POST   /auth/refresh
auth.logout()                          POST   /auth/logout
auth.me()                              GET    /auth/me
tenants.create(body)                   POST   /tenants
tenants.me()                           GET    /tenants/me
documents.list(tenantId)               GET    /tenants/:tenantId/documents
documents.upload(tenantId, file, onProgress)
                                       POST   /tenants/:tenantId/documents
query.ask(tenantId, body)              POST   /tenants/:tenantId/query
query.stream(tenantId, body, handlers) POST   /tenants/:tenantId/query  (stream: true)
```

Response types live in `lib/api/types.ts` and are derived from what the handlers actually return —
including the fields the current UI ignores (`chunksSkipped`, `pages`, `chunksUsed`, `apiKey`,
`role`). Zod schemas parse responses in development and are stripped in production builds, so a
backend shape change surfaces as a clear parse error during development rather than
`undefined is not a function` in front of a user.

### 20.3 SSE

`EventSource` cannot be used — it supports neither `POST` bodies nor an `Authorization` header, and
the query endpoint needs both. So `lib/api/sse.ts` stays a hand-rolled `fetch` +
`response.body.getReader()` loop, but as one tested module instead of inline page script.

It must handle the parts the current implementation gets wrong or omits:

- **Frame buffering.** Split on `\n\n` and keep the trailing partial in a buffer — a chunk boundary
  can land mid-frame, and a naive split silently drops tokens.
- **Frame parsing.** The backend writes `event: <name>\ndata: <json>\n\n`, so both lines must be
  read; the four event names are `sources`, `chunk`, `done`, `error`.
- **Typed handlers.** `onSources({sources, query, chunksUsed})`, `onChunk(text)`, `onDone()`,
  `onError(err)`.
- **Abort.** An `AbortController` wired to the Stop button and to unmount, so navigating away does
  not leave a stream running.
- **Mid-stream errors.** A `500` that arrives *after* headers cannot change the status code, so the
  backend emits an `error` frame instead. The partial answer must be kept and labelled, not
  discarded.
- **Silence detection.** If no frame arrives for 30 s, surface a "still working" hint rather than
  appearing frozen.
- **Non-streaming fallback.** `query.ask()` for `stream: false`, used by the retrieval-settings
  toggle and as an automatic fallback if a proxy strips the stream.

### 20.4 Backend changes needed at ship time (not this phase)

None of these are required to develop the frontend — the Vite proxy covers development entirely.
They are required to *deploy* it:

| # | Change | Why |
| --- | --- | --- |
| 1 | Point `express.static` at `web/dist` (`src/app.js:24`) | Serve the built app |
| 2 | Add an SPA fallback **after** the `/api` mounts: unmatched non-`/api` GETs → `web/dist/index.html` | Without it, `/app/documents` 404s on refresh or deep link |
| 3 | Raise nginx `client_max_body_size` from `1M` to match the intended upload ceiling | Today a 5 MB PDF is rejected by nginx before Express sees it, with an opaque 413 |
| 4 | Fix `embeddingModel: 'nomic-embed-text'` → the real Voyage model | The DB is recording false provenance on every document |
| 5 | Remove the `error.message.includes('Ollama')` branch in `query.js` | Dead path that can surface a misleading message |
| 6 | Mount or delete `src/api/health.js`; delete `src/middleware/guardrails.js` | Dead code |
| 7 | Add `DELETE /tenants/:id/documents/:docId` | The library's delete action is designed and disabled without it |
| 8 | Add `POST /auth/forgot-password` + `POST /auth/reset-password` | Password recovery UI is built and flagged off without them |
| 9 | Add `PATCH /tenants/:id` | Workspace settings are read-only without it |
| 10 | Add conversation persistence (a `conversations` + `messages` table) | Chat history is lost on refresh |
| 11 | Consider httpOnly refresh cookies | Removes the `localStorage` XSS exposure (§22) |

Items 1–3 are ship-blockers. 4–6 are correctness cleanups worth doing regardless. 7–11 unlock UI
that is already designed and will render in a disabled state until they land.

---

## 21. Implementation Roadmap

Ten phases. Each ends in something runnable — no phase leaves the app in a broken state, and the old
`src/public/` pages stay reachable until Phase 9 so the deployed product never regresses.

### Phase 1 — Foundation

**Build:** `web/` scaffolded with Vite + React 19 + TS (strict). `vite.config.ts` with the `/api`
proxy to `:4500`, `@/*` alias, and `manualChunks`. Tailwind v4 wired. ESLint (flat config +
`jsx-a11y` + `react-hooks`) + Prettier. Vitest + Testing Library + MSW. Playwright. `.env.example`
with `VITE_API_BASE_URL` and the feature flags. Root `package.json` gains `dev:web`, `build:web`,
`lint`, `test` scripts (it currently has none).
**Depends on:** nothing.
**Outcome:** `npm run dev:web` serves a blank themed page and can reach the live API.
**Watch for:** the proxy must forward SSE without buffering — verify with a real streamed query
before moving on, because discovering it later invalidates Phase 6.

### Phase 2 — Design system

**Build:** `theme.css` with every token from §15. `base.css` reset, `:focus-visible` rules, custom
scrollbars, selection colour. Self-hosted fonts. The blocking theme-bootstrap script. Theme toggle in
`uiStore`. A `/dev/tokens` route rendering every ramp with its computed contrast ratio.
**Depends on:** Phase 1.
**Outcome:** both themes render, tokens are inspectable, contrast is provable.
**Watch for:** build the token page for real — it is how contrast regressions get caught in one
glance instead of in an audit.

### Phase 3 — UI primitives

**Build:** all of §14.1. Each with variants, loading/disabled states, focus rings, forwarded refs,
and a unit test asserting its a11y contract (`IconButton` requires a label, `Input` wires
`aria-describedby`, `Dialog` traps focus). A `/dev/components` gallery.
**Depends on:** Phase 2.
**Outcome:** a complete primitive library, testable in isolation.
**Watch for:** resist adding props speculatively. `Button` needs five variants and three sizes, not
a `rounded` prop nobody asked for.

### Phase 4 — API layer and session

**Build:** `apiClient` with the single-flight refresh queue, `endpoints.ts`, `types.ts`, Zod response
schemas, `tokenStorage`, `sessionStore`, `queryClient`, `useSession`, `ProtectedRoute`,
`PublicOnlyRoute`, `SessionExpiredDialog`, and the route table with lazy leaves.
**Depends on:** Phase 1 (Phase 3 not required).
**Outcome:** guards work against the real backend; expiry, revocation, and tenant redirects behave.
**Watch for:** test the refresh queue with five concurrent expired requests. Getting single-flight
wrong produces racing refreshes that revoke each other — an intermittent bug that is miserable to
find later. Also verify the `POST /api/tenants` token-reissue path explicitly.

### Phase 5 — Authentication UI

**Build:** `AuthLayout` with the brand panel and orb backdrop. Login, Signup, Forgot, Reset
(flagged), all forms on RHF + Zod. `PasswordField`, `PasswordStrengthMeter` (preserving the exact
4-point algorithm), confirm-match, terms checkbox, remember-me, `?next=` handling, and every state in
§13.
**Depends on:** Phases 3, 4.
**Outcome:** a user can sign up and sign in through the React app end to end.
**Watch for:** delete the demo credentials and the `value=` attributes here, and flag the account for
password rotation. Keep the strength meter advisory — do not invent a policy the backend lacks.

### Phase 6 — Chat

**Build:** `AppLayout`, `Sidebar` (collapsible; drawer under `lg`), `Topbar`, `sse.ts`, `useChat`
reducer, `MessageList`, `MessageBubble`, `Markdown` (react-markdown + gfm + sanitize),
`SourcesDisclosure`, `SourceCard`, `Composer` with the character counter, `RetrievalSettings` popover
(`topK`, stream toggle), `SuggestionGrid` derived from real documents, stop-generation, and the
error/abort/no-context states.
**Depends on:** Phase 5.
**Outcome:** parity with `index.html`'s chat, plus stop, retry, `topK`, the counter, real sources, and
partial-answer preservation.
**Watch for:** the frame-buffering bug in §20.3. Test with slow, chunked, and mid-stream-error
responses, not just the happy path. Verify auto-scroll does not fight a user reading history.

### Phase 7 — Documents and onboarding

**Build:** `/onboarding/workspace` (2-step, slug auto-derivation + live preview, token overwrite),
`/app/documents` (search, filter, sort, table/cards), the upload modal route with a keyboard-accessible
dropzone, `XMLHttpRequest` progress, post-upload result summary including `chunksSkipped`, and the
document detail drawer.
**Depends on:** Phase 6.
**Outcome:** the full document lifecycle a user can see, and a first-run path that ends with a usable
workspace.
**Watch for:** derive the size limit and its hint text from one constant, and confirm the real nginx
ceiling before writing any number into the copy.

### Phase 8 — Marketing, settings, and the shell extras

**Build:** the landing page (all eight sections), Pricing/Legal stubs, `MarketingLayout` with the
scroll-aware sticky nav, `/app/settings/*` including the API-key pane, the command palette, `/403`,
both 404s, `RouteError`, and the real favicon/OG/manifest assets.
**Depends on:** Phase 3 (independent of 6–7; can run in parallel).
**Outcome:** the product is presentable to someone who has never seen it.
**Watch for:** the API-key pane must mask by default. Pricing must not invent numbers — an honest
"contact us" beats fictional tiers.

### Phase 9 — Cutover

**Build:** point `express.static` at `web/dist`, add the SPA fallback after the `/api` mounts, raise
nginx `client_max_body_size`, update the Dockerfile to run the frontend build, add a `build:web` step
to the GitHub Actions workflow, then **delete `src/public/`**.
**Depends on:** Phases 5–8 at parity.
**Outcome:** one frontend, served from the build output, deep links working.
**Watch for:** the fallback must come after `/api` or every API 404 returns HTML. Verify a hard
refresh on `/app/documents` and a direct-paste of `/reset-password?token=…` before deleting anything.

### Phase 10 — Hardening

**Build:** responsive verification at all six widths, the axe suite across every route, keyboard-only
and screen-reader passes, Lighthouse against the §19.1 budgets, bundle analysis, `prefers-reduced-motion`
verification, Playwright e2e for the two journeys that matter (signup → workspace → upload → ask; and
login → expired token → silent refresh → answer), plus a short frontend README.
**Depends on:** Phase 9.
**Outcome:** measured, not asserted, quality.
**Watch for:** treat budget and axe failures as build failures. A performance budget nobody enforces
is a comment.

### Phase sequencing

```text
1 ──▶ 2 ──▶ 3 ──┬──▶ 5 ──▶ 6 ──▶ 7 ──┬──▶ 9 ──▶ 10
      1 ──▶ 4 ──┘        8 ───────────┘
```

Phase 4 only needs Phase 1, so the API layer can be built while the design system is in progress.
Phase 8 only needs Phase 3, so marketing and settings can proceed in parallel with chat.

---

## 22. Risks / Open Questions

Ordered by how much rework the wrong answer causes.

| # | Question | Assumption taken | Impact if wrong |
| --- | --- | --- | --- |
| 1 | **What is the real upload limit?** UI says 1 MB, JS says 10 MB, multer says 10 MB, nginx caps at 1 MB | 10 MB is intended; nginx is misconfigured. The UI reads one constant, and nginx is raised in Phase 9 | Low — one constant and one nginx line |
| 2 | **Tokens in `localStorage`, or httpOnly cookies?** | Keep `localStorage` this phase (the backend returns tokens in the body and sets no cookies), confined to `tokenStorage.ts` | Low-to-medium — one module plus `credentials: 'include'`. Worth doing eventually: `localStorage` is readable by any injected script |
| 3 | **Is chat history expected to persist?** No `conversations` table exists | Session-scoped only; history clears on sign-out. A "History" nav item is designed but hidden behind a flag | Medium — the sidebar gains a thread list and the chat reducer gains hydration |
| 4 | **Will `{slug}.docmind.ai` actually resolve?** The onboarding preview promises it; no subdomain routing exists | The preview is illustrative. Copy softened to "Your workspace URL" with a note that it activates with custom domains | Low if soft; a trust cost if shipped as a promise that 404s |
| 5 | **Is `/api/tenants/:id/documents` paginated later?** It returns everything today | Client-side search and sort over the full list; the query hook is written so a `?page=` parameter is additive | Low — the hook signature already allows it |
| 6 | **Does password recovery get built?** | UI built, flagged off, contract documented in §13.3 | None to the frontend; the flag flips on |
| 7 | **Does `role` (`owner`/`member`) ever gate anything?** No authorisation uses it today | Displayed as a badge; no permission logic | Low — a `can()` helper slots into the session store |
| 8 | **Is there a design or brand source I have not seen?** Only the four palette images exist | The palette is derived from `icy-blue-gunmetal` per §7–§8 | High if an existing brand exists — but the tokens are semantic, so a palette swap is one file |
| 9 | **Multi-workspace per user?** `User.tenantId` is singular | One workspace per user. The user menu has a workspace row built as a list of one | Medium — a switcher and tenant-scoped cache keys |
| 10 | **Email verification?** Not implemented | `/verify-email` designed, not routed | Low |

Two risks with no open question attached, just work: the **demo credentials are in git history**, so
deleting them from `login.html` is necessary but not sufficient — that password must be rotated. And
the `embeddingModel: 'nomic-embed-text'` value being written on every `Document` row means the
database currently misrecords which model produced its vectors, which will matter the next time the
embedding model changes.

---

## 23. Recommended Next Steps

### Do these before writing any React code

1. **Rotate the `admin@gmail.com` password.** It is in `login.html` and in git history. Deleting the
   markup does not un-publish it. This is the only item here that is urgent independent of the
   migration.
2. **Confirm the intended upload limit** (§22 #1). One number unblocks the constant, the hint copy,
   the validation, and the nginx line.
3. **Answer questions 3, 4, 8, and 9 in §22** — chat persistence, the subdomain promise, whether a
   brand source exists, and whether one user may have multiple workspaces. Each changes structure
   rather than styling, so they are cheap now and expensive in Phase 7.
4. **Approve or amend the theme.** §7–§8 recommend `icy-blue-gunmetal` (Icy Blue `#A4D8FF` +
   Gunmetal `#35393C`) on measured contrast and the shared 206° hue. If a different image is
   preferred, say so now: the tokens are semantic, so the swap is one file, but the light-mode
   strategy and the near-black-on-accent button rule are specific to this pair.

### Then start Phase 1

Once the theme is confirmed, Phases 1 → 2 → 3 are unblocked and independent of every open question
above, since they produce tooling, tokens, and primitives. The first genuinely visible milestone is
end of Phase 5: a user signing up and signing in through the React app while `src/public/` still
serves the live product.

### What this plan deliberately does not do

- **No backend implementation.** The Vite proxy makes the entire frontend developable against the
  running API without touching `src/`. The backend edits in §20.4 are listed, scoped, and deferred.
- **No deletion of `src/public/` until Phase 9.** The old pages remain the served product until React
  reaches parity, so there is no window where the deployment is worse than it is today.
- **No new abstractions without a second caller.** The components in §14.4 are named specifically so
  that "we might need it" does not become a reason to build them.

### How to judge the result

The migration has succeeded when: a stranger can understand the product from `/` without signing in;
signup → workspace → upload → answer works on a phone with one hand; the whole app is navigable by
keyboard alone, including upload; every route survives a hard refresh; an expired access token is
invisible to the user; a partially streamed answer is never destroyed by an error; and the seven
backend capabilities that currently have no UI — `apiKey`, `topK`, `pages`, `chunksSkipped`,
`chunksUsed`, `role`, non-streaming mode — are all reachable.

---

**End of plan.** Sections 1–23 correspond to the deliverable specified in
`Frontend Analysis & React Migration — Implementation Planning Prompt.md` §14. No React code has been
written; implementation begins at Phase 1 on approval.
