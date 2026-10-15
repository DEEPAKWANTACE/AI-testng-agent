# AI QA Testing Agent

A dashboard for managing QA work from start to finish: register applications, discover their surface area, write test plans, get them approved, run them, and review reports.

> **Status:** the full workflow is implemented: discovery, AI/heuristic test generation, hash-bound review and approval, isolated Playwright execution on a Redis/BullMQ queue, reports and regression suites. Generation uses a built-in rule-based generator until an LLM provider is configured (see *Test generation*).

## Stack

- **Next.js 16** (App Router, Cache Components / Partial Prerendering, Server Actions)
- **TypeScript** (strict)
- **Tailwind CSS v4**
- **PostgreSQL** + **Prisma 7** (with the `@prisma/adapter-pg` driver adapter)
- **Zod 4** for env, form, Server Action and LLM-output validation
- **Playwright** (Chromium) for discovery and test execution
- **Redis** + **BullMQ** for asynchronous jobs

## Workflow

```
Project → Application → Discovery run → Features
                                          ↓
              Generation (LLM or heuristic) → Draft cases → Review → Plan version (hashed) → Approval
                                                                                                ↓
                              Report ← Results & evidence ← Execution worker (re-verifies) ← Queued run
```

| Area | What it does today |
| --- | --- |
| **Projects** | Group applications. Create, edit, archive and delete. |
| **Applications** | Systems under test: name, **authorized URL** (the only origin the agent may test), environment, optional Git repository and branch, and **secret references**. Names are unique within a project. |
| **Discovery** | Queue a run with depth and page limits. The isolated Playwright worker crawls the application's authorized URL, optionally signing in first. It records pages, links, forms, buttons, inputs and navigation, groups them into features, and saves screenshots and a crawl log as evidence. |
| **Test generation** | From the application page: pick discovered features, add requirements, and generate end-to-end, positive, negative, boundary, permission and regression cases with prerequisites, executable steps, expected results, priority and coverage. Results land as **proposed drafts**. |
| **Test Plans** | Review generated cases: inspect, edit (steps as validated JSON), select, accept or reject (individually or in bulk). Submitting freezes the accepted cases into an immutable, numbered **plan version** whose content hash is computed by Postgres. Any later material change needs a new version and a new approval. |
| **Approvals** | Reviewers see the full hash, the diff from the previous approved version and every case and step. The decision is bound to the exact hash shown and records the reviewer's roles. Nobody can review their own submission. |
| **Test Runs** | Only the current approved version can be queued. The worker re-verifies everything before execution; runs move through *queued → running → passed/failed/blocked/error/cancelled*, with live progress, cancellation and bounded retries. |
| **Reports** | Pass/fail/blocked counts, feature coverage, failed steps with expected vs actual, suggested severity, priority, reproduction steps, screenshots and Playwright traces, regression flags, filters, and HTML/JSON downloads. |
| **Regression** | Build reusable regression suites from approved cases (they must be approved too), rerun approved versions, and compare every result with the same case's previous result: *regressed*, *fixed*, *still failing*, *unchanged* or *new*. |
| **Audit log** | Append-only, hash-chained record of generation, review, approval, execution and downloads. |

## Getting started

Prerequisites: Node.js 20.9+, PostgreSQL 14+, Docker (for Redis) and Chromium for Playwright (`npx playwright install chromium`).

```bash
npm install                      # also runs `prisma generate`
cp .env.example .env             # then set DATABASE_URL (and optionally SEED_USER_PASSWORD)
createdb ai_qa_agent             # or create the database another way
npm run db:migrate               # apply migrations
npm run db:seed                  # demo users and data across every model
npm run db:verify                # optional: check database access and integrity rules
docker compose up -d redis       # job queue
npm run dev                      # http://localhost:3000 — sign in as a demo user
npm run worker:discovery         # in another terminal: processes discovery runs
npm run worker:jobs              # in another terminal: generation + test execution

createdb ai_qa_agent_test        # for the integration tests
npm test
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` / `npm start` | Production build / serve |
| `npm run lint` | ESLint |
| `npm run typecheck` | Generate route types, then `tsc --noEmit` |
| `npm test` | Unit + integration tests (Vitest). `test:unit` needs no database; `test:integration` uses `TEST_DATABASE_URL` |
| `npm run db:migrate` | Create/apply migrations in development (`prisma migrate dev`) |
| `npm run db:deploy` | Apply migrations in production (`prisma migrate deploy`) |
| `npm run db:seed` | Seed demo data (idempotent) |
| `npm run db:verify` | Check access to every table and every integrity rule against the live database. Uses an isolated fixture and cleans it up. |
| `npm run db:studio` | Open Prisma Studio |
| `npm run worker:discovery` | Discovery worker; `-- --once` processes a single run and exits |
| `npm run worker:jobs` | Job worker (BullMQ): test generation and test execution, with recovery of crashed runs |
| `npm run demo:target` | Local Demo Shop on :4100 (canary on :4101) for trying discovery and test runs |
| `npm run db:generate` | Regenerate the Prisma client |

`npm run build` does not need a database. Every page reads live data at request time, so pages are prerendered as static shells and the data is streamed in.

## Environment

See [`.env.example`](.env.example). `DATABASE_URL` is the only required variable. It is validated with Zod (`src/lib/env.ts`) the first time the database is used. The AI and runner variables in that file are commented-out placeholders.

## Authentication and authorization

**Sign-in** is email + password (`/login`). Every page and Server Action requires a session.

- **Passwords** are hashed with scrypt (N=2¹⁵, r=8, p=1, 16-byte salt) in `src/modules/auth/password.ts`. A database CHECK constraint rejects anything that isn't an scrypt hash, so plaintext can't be stored even by mistake. Hashes made with older parameters are upgraded on the next sign-in.
- **Sessions** are random 256-bit tokens in an `httpOnly`, `SameSite=Lax` cookie (`Secure` in production) that expires after 7 days. The database stores only the token's SHA-256 hash. Signing out deletes the session server-side; changing a password or disabling a user revokes all of that user's sessions.
- **Sign-in protection:** the same error for unknown users, wrong passwords and inactive accounts, with equalised timing. Failures are rate-limited (5 per 15 minutes per account and per IP). The limiter is in-memory, so it applies per server instance. Post-login redirects only go to same-site paths.
- **Layers:** `src/proxy.ts` does an *optimistic* redirect when the cookie is missing. The real check is `requireActor()`, which looks the session up in the database. Every page and action calls it, then checks project permissions in the service layer.

There are no self-service sign-ups. Users come from `npm run db:seed` or are added to the database directly.

**Project roles** (`ProjectMember`), enforced by `src/modules/access/policy.ts`:

| | Viewer | Editor | Owner |
| --- | :-: | :-: | :-: |
| View the project, applications, plans, runs, reports | ✓ | ✓ | ✓ |
| Create and edit applications; manage secret references | | ✓ | ✓ |
| Discovery, test suites, queue and cancel runs | | ✓ | ✓ |
| Review plans (also needs the *QA Lead* global role) | | ✓ | ✓ |
| Delete applications or suites; edit or delete the project; manage members | | | ✓ |

Global roles: **Admin** has full access to every project. **Viewer** is read-only everywhere, whatever their project role. People who aren't members get *not found* rather than *forbidden*, so IDs don't reveal what exists. A project always keeps at least one owner.

**Secret references.** Applications store pointers to secrets, never values: `env://QA_…`, `vault://path#key`, `aws-sm://…`, `gcp-sm://projects/…/secrets/…` or `azure-kv://vault/name`. The format is validated in Zod and again by a database CHECK constraint, so pasting a raw password is rejected. `env://` is restricted to `QA_`-prefixed variables, so a reference can't read the server's own configuration such as `DATABASE_URL`. Values are resolved only at use time (`src/modules/secrets/resolver.ts`; only `env://` is wired up so far). The UI shows whether a reference resolves without revealing its value, and hides the reference itself from project viewers. Repository and authorized URLs that contain credentials are rejected for the same reason.

## Discovery worker

A separate process (`src/worker/discovery/`) that shares only the database with the web app. Runs are claimed with `FOR UPDATE SKIP LOCKED`, so several workers can run side by side without taking the same run. Workers send heartbeats; a run whose worker dies is marked *Failed* when the next worker starts. Cancelling in the UI stops a run after the current page. On SIGINT/SIGTERM the worker finishes the current page and stops.

**What it records.** For each reachable page: URL, title, depth, HTTP status, load time, links, navigation menus, forms (method, action, fields with label, type and required flag, submit labels), buttons and standalone inputs. It records structure only: **field values are never stored**. Pages are grouped into features by top-level section and named from the site's own navigation labels (`Feature`, source *Discovered*; hand-written features are never overwritten). Evidence is a PNG screenshot per page and a JSON crawl log per run (`Artifact`). Files go to `ARTIFACT_STORAGE_DIR` and are served by `/api/artifacts/[id]` only to people who can view the project.

**Safety model:**

- **Explicit scope.** It only crawls the application's authorized URL (origin plus path prefix) and follows GET links only. It **never submits forms**, apart from the configured login form. Links that look like they change state (`logout`, `delete`, `remove`, `reset`…) and file downloads are skipped.
- **Egress proxy (SSRF protection).** All browser traffic, including redirect hops, subresources, `fetch()`/XHR and IP literals, goes through a local filtering proxy (`egress-proxy.ts`). The proxy checks DNS **at connect time** and connects to the exact IP it validated, which defeats DNS rebinding. It blocks:
  - loopback, RFC 1918, CGNAT, link-local, multicast, reserved and documentation ranges (IPv4 and IPv6);
  - IPv4 embedded in IPv6 (mapped, NAT64, 6to4);
  - cloud metadata endpoints (169.254.169.254, `fd00:ec2::254`, `metadata.google.internal`…);
  - `.local`/`.internal`/single-label hostnames.

  A hostname is blocked if **any** of its DNS answers is blocked. By default only the authorized host is reachable; `DISCOVERY_ALLOW_EXTERNAL_ASSETS=true` also allows public third-party hosts on ports 80/443. WebSocket upgrades are refused.
- **Unsafe redirects.** Main-frame redirects are inspected *before* they are followed (CDP `Fetch` at the response stage). A redirect that leaves the authorized URL, including to another path on the same host, is answered locally and recorded; its target is never requested.
- **Isolated browser.** Headless Chromium with a fresh context per run: no stored state, downloads/service workers/permissions blocked, popups closed, dialogs dismissed, HTTPS errors not ignored, and an identifying `QA-Agent-Discovery` user agent.
- **Authentication.** Optional form login per application (*Discovery login* card). The username and password are **secret references**, resolved by the worker at run time and never stored, logged or shown. The login URL must be inside the authorized URL; selectors are CSS only. A failed login fails the run with a message that never includes the credentials.
- **Limits.** Max depth (1–5) and max pages (1–200) per run, a per-page timeout and a hard whole-run timeout (env vars above). Partial results are kept.
- **Applications.** Saving an application whose authorized URL is obviously local, private or a metadata host is refused. The worker re-checks with DNS before launching the browser.

**Trying it locally.** The Demo Shop (`npm run demo:target`) is a small store with navigation, forms and a login-protected account area. It also contains traps the worker must refuse: logout and destructive links, redirects to a local canary port and to the metadata IP, and a page that tries to load internal URLs from the browser. Because it runs on localhost, add `DISCOVERY_PRIVATE_ALLOWLIST="127.0.0.1:4100"` to `.env` (development only; ignored in production). Then:

1. Create an application with authorized URL `http://127.0.0.1:4100`.
2. Add secret references `env://QA_DEMO_EMAIL` and `env://QA_DEMO_PASSWORD`.
3. Configure *Discovery login* with `http://127.0.0.1:4100/login`, then queue a run.

The canary on :4101 must stay at 0 requests.

## Test generation

Generation runs as a background job (`src/modules/generation/`). The provider is selected with `LLM_PROVIDER`:

- **`heuristic`** (default) is a built-in rule-based generator with no external calls. It derives executable cases from discovered pages, forms and navigation. It never submits forms with data (to avoid side effects); it clears pre-filled required fields before checking that empty submission is refused; and it keeps protected sections out of signed-out navigation checks.
- **`openai-compatible`** works with any OpenAI-style chat API (OpenAI, Azure OpenAI, OpenRouter, Ollama, vLLM…), configured with `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY`. The key is only read from the environment and never logged or echoed in errors. Rate limits, timeouts and 5xx responses are retried, up to 3 attempts.

**Website content is untrusted.** Discovered titles, labels and link text go into the prompt as JSON data inside a delimited block. The model is told never to follow instructions in it, and the content is length-limited. Input values and secrets are never captured, so they can't reach a prompt. The output is untrusted too:

- It is parsed with strict Zod schemas, and each case is validated on its own (invalid cases are dropped and counted, never repaired).
- Every step must be a valid executable step.
- Navigation must stay inside the authorized URL.
- Features and secret names must exist.
- Unknown fields are rejected, so there's nowhere to smuggle code. **Generated content is never executed as code.**

Results are saved as *proposed* drafts. The prompt's SHA-256 is recorded with each job; the prompt itself is not stored.

## Review, approval and versioning

- **Review.** Every proposed case must be accepted or rejected before a suite can be submitted. Only accepted cases are frozen into a plan version.
- **Immutable versions.** `PlanVersion.contentHash` is a Postgres *generated column*: `sha256` of the snapshot's canonical `jsonb` text, via `qa_snapshot_hash()`. It is always consistent with the content and can't be written by the application. A trigger rejects any change to a submitted snapshot.
- **Hash-bound approval.** The approval page shows the full hash, the diff from the last approved version and every case. The decision carries the hash the reviewer saw and is refused if the version's content differs. It records `decidedHash`, the reviewer and the reviewer's global and project roles; a trigger makes a decided approval immutable.
- **Reapproval.** Editing a case changes the working copy's hash, and the UI shows what changed since the approved version. Runs keep using the approved version until a new one is submitted and approved; submitting identical content is refused.
- **Audit log.** `AuditLog` is append-only (a trigger rejects UPDATE/DELETE) and hash-chained (`verifyAuditChain()`; admins see the verification result on the Audit log page).

## Test execution

`npm run worker:jobs` consumes BullMQ jobs from Redis. **Before each run** the worker re-verifies, and blocks the run with a reason if any check fails:

- **Plan state:** the version is still *approved* (not superseded since queueing), has executable steps, and its suite is active.
- **Content integrity:** the stored snapshot re-hashes to its `contentHash`, which equals the hash the run was queued with and the hash the reviewer approved.
- **Approval:** the reviewer's recorded roles authorize review, and the reviewer isn't the submitter.
- **Target:** the authorized URL and environment are unchanged since queueing; the target passes the egress policy (no localhost, private or metadata targets) after a fresh DNS check.
- **Environment:** it's listed in `EXECUTION_ALLOWED_ENVIRONMENTS` (PRODUCTION is blocked by default).
- **Steps:** every step is valid, every navigation stays in scope, and every referenced secret exists.

**Execution** runs in the same sandbox as discovery (egress proxy, CDP navigation-scope enforcement, storage-less contexts), with a fresh context per case. Steps use a fixed vocabulary: **navigate, click, fill, select, wait, assert**. Locators are structured (role, label, text, placeholder, testId or plain CSS; Playwright engine selectors are refused), and each maps to a fixed Playwright call. There is no `evaluate` path, so no generated JavaScript ever runs. Secrets are filled from secret references at run time and scrubbed from anything recorded. Each step records its result, actual value and a screenshot; each case records a Playwright trace; failures open a defect with a suggested severity.

**Jobs:**

- **States:** queued, running, passed, failed, blocked, error and cancelled, with live progress.
- **Duplicate prevention:** the job ID is the run ID, so enqueueing twice is a no-op. The worker also claims runs with an atomic conditional update; a redelivered job is skipped unless the previous worker's heartbeat is stale.
- **Retries and timeouts:** only infrastructure failures are retried (`maxAttempts`, exponential backoff); test failures are results. Per-step and per-run timeouts apply.
- **Cancellation:** a queued run is removed from the queue; a running run stops after the current step.
- **Recovery:** runs whose worker died are re-queued (or marked *error* once attempts are exhausted), and queued runs missing from Redis are re-enqueued.
- **Queue outages:** if Redis is unavailable, queueing fails immediately with a clear message instead of hanging.

## Reports and regression

Each run produces a report:

- **Counts and coverage:** pass/fail/blocked/skipped counts, plus feature coverage (pass rate per feature, and discovered features with no tests).
- **Failures:** failed steps with expected vs actual, suggested severity (from priority), priority and reproduction steps.
- **Evidence:** links to step screenshots and traces, served only to project members.
- **Download:** filter by status, feature, priority or regressions only, and download as **HTML** (self-contained, escaped, no scripts, restrictive CSP) or **JSON**.

Heuristic hints about why something failed are always labelled *"Suspected cause (AI/heuristic, unconfirmed)"* (`confirmed: false` in JSON) and are never presented as findings.

Cases keep a stable `caseKey` across versions and regression suites. Every result is compared with the most recent earlier result for the same case in the application and flagged *regressed*, *fixed*, *still failing*, *unchanged* or *new*. History is preserved: versions are immutable, suites with runs can only be archived, and results keep a snapshot of the case title, priority and feature.

## Data model

Defined in [`prisma/schema.prisma`](prisma/schema.prisma) as 23 models and 28 status/type enums.

| Group | Models |
| --- | --- |
| Identity | `User` (role: Admin / QA Lead / QA Engineer / Viewer), `Session` |
| Inventory | `Project` → `ProjectMember`, `Project` → `Application` → `ApplicationSecret`, `Feature` |
| Discovery | `DiscoveryRun` → `DiscoveredPage` (elements JSON, screenshot `Artifact`), finds `Feature`s; `DiscoveryAuthConfig` per application |
| Test design | `TestSuite` → `TestCase` → `TestStep` |
| Generation | `GenerationJob` → proposed `TestCase`s |
| Review | `PlanVersion` (immutable JSON snapshot + DB-generated content hash) → `Approval` (bound to the hash) |
| Audit | `AuditLog` (append-only, hash-chained) |
| Execution | `TestRun` (of one plan version) → `TestResult` → `StepResult` |
| Outcomes | `Defect`, `Artifact`, `Report` |

Design rules:

- **Versioned, immutable plans.** `PlanVersion.snapshot` freezes the cases and steps at submission. Its shape is defined by a Zod schema in `src/modules/test-suites/snapshot.ts`. Runs execute a version, so editing a suite never changes what was approved.
- **History survives deletion.** Actor columns (`createdById`, `reviewerId`, `assigneeId`…) use `ON DELETE SET NULL`. Results snapshot the case title and priority and keep them if the case or step is later deleted. Removing a test case from a suite archives it.
- **Ownership cascades.** Deleting a project removes its applications and everything beneath them.
- **Database-enforced invariants.** These live in the migration SQL because the Prisma schema can't express them. Prisma ignores them when diffing, so future migrations won't drop them.
  - At most one plan version awaiting approval per suite, and one pending approval per version (partial unique indexes).
  - Every artifact has exactly one owner: a discovery run, test run, result, step result or defect.
  - Passwords are scrypt hashes and sessions store token hashes.
  - URLs contain no credentials, a branch requires a repository, and secret references match their provider's format.
  - Emails are stored lower-cased.
  - A decided approval must have `decidedAt`.
  - Sizes, counters, depths and positions are within range.

## Project structure

```
prisma/
  schema.prisma            Data model and workflow enums
  migrations/              SQL migrations (incl. hand-written invariants)
  seed.ts                  Demo data covering every model (users get SEED_USER_PASSWORD)
  verify.ts                Database access + integrity checks (npm run db:verify)
demo/                      Local Demo Shop + canary for exercising discovery
prisma.config.ts           Prisma CLI config (schema, migrations, datasource)
src/
  proxy.ts                 Optimistic sign-in redirect
  worker/browser/          Sandboxed Chromium shared by both workers (egress proxy, navigation scope)
  worker/discovery/        Discovery worker: crawler, egress proxy, extractor, run loop
  worker/execution/        Test executor (fixed step vocabulary) and run lifecycle
  worker/jobs/             BullMQ job worker and crash recovery
  app/
    login/                 Sign-in page
    (dashboard)/           Routes sharing the sidebar layout (all require a session)
      page.tsx             Overview
      projects/  applications/  discovery/  test-plans/
      approvals/ test-runs/  reports/
  components/
    ui/                    Presentational primitives (Card, Table, StatusBadge…)
    forms/                 ActionForm, ActionButton, fields (client)
    layout/                Sidebar and navigation
  lib/
    db.ts                  Prisma client, created lazily on first use
    env.ts                 Zod-validated server env
    validation.ts          Shared Zod helpers and FormData parsing
    action-state.ts        Server Action result type and error mapping
  modules/
    auth/                  Password hashing, sessions, sign-in/out
    access/                Authorization policy + project-scoped checks
    secrets/               Secret reference formats and resolver
    <feature>/             One folder per domain area:
      schemas.ts           Zod input schemas
      service.ts|queries.ts  Server-only reads/writes, taking the signed-in actor
      actions.ts           Server Actions: authenticate → validate → call the service
      components/          Feature-specific UI
tests/
  unit/                    Pure logic (no database)
  integration/             Server Actions against a real Postgres test database
  generated/prisma/        Generated Prisma client (git-ignored)
```

### Conventions

- **Reads** take the signed-in `actor` and are scoped to that actor's projects (`projectScope`). Data components call `requireActor()` inside `<Suspense>`; reading the session cookie is what makes them run at request time under Cache Components.
- **Writes** are Server Actions in `modules/*/actions.ts`. They authenticate, parse input with Zod, check project permissions and return an `ActionState`. Expected failures are thrown as `DomainError` and shown to the user; anything else is logged and reported generically. Submitted values are echoed back so forms keep their input after a validation error.
- **Workflow transitions** (submit, decide, cancel) use conditional updates inside transactions, so a double submit can't create duplicate state.

## Not implemented yet

These are deliberately out of scope for this foundation:

- A configured LLM: until `LLM_PROVIDER=openai-compatible` is set, generation uses the built-in heuristic generator
- UI for managing users, features and defects (the models and seed data exist)
- User administration UI (creating users, resetting passwords) and SSO
- A shared rate-limit store for multi-instance deployments
- Clients for Vault, AWS, GCP and Azure secret managers (references can be stored now; only `env://` resolves)
- Object storage for artifacts (files are stored on local disk), and container-level sandboxing for the worker (run it in its own container or VM in production)
- Discovery of SPA routes reachable only by clicking non-link elements (the crawler follows links)
