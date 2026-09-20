# ADR 0005: A same-origin responsive web application with a direct api-client data layer

- Status: Accepted
- Date: 2026-08-02
- Amended by:
  [addendum 1 — a city-first selection flow](0005-addendum-1-city-first-selection.md) (2026-09-16),
  [addendum 2 — the confirmed selection is remembered locally](0005-addendum-2-confirmed-selection-persistence.md)
  (2026-09-18),
  [addendum 3 — one audited favicon in the shell](0005-addendum-3-audited-favicon.md) (2026-09-19)

## Context

[ADR 0002](0002-shared-http-api.md) established the documented HTTP contract,
[ADR 0003](0003-official-schedule-ingestion.md) established how official municipal schedules are
ingested, and [ADR 0004](0004-extension-api-integration.md) made the browser extension a pure client
of that contract through `@abfall-radar/api-client`. The product sequence in
[the shared rules](../ai/shared-rules.md) puts the responsive web application next.

`apps/web` is currently a reserved boundary: a `package.json` with a name, a private flag, and a
module type, plus a README stating that framework dependencies wait for the first approved web task.
This is that task. Activating the workspace is therefore a decision about how a *second* client
consumes the contract, not only about which build tool to use.

Seven constraints shape this decision.

**The web application is not a browser extension, and copying its boundary would be cargo cult.**
ADR 0004 put every request in the Manifest V3 background service worker for reasons that are
specific to that host: a popup is a short-lived window that can be destroyed mid-request, the worker
owns storage and alarms, and `runtime.sendMessage` offers the sender no cancellation. A web document
has none of those properties. It owns its own lifetime, it can cancel a request with an
`AbortSignal`, and there is no second process to message.

**There is still no deployed API, no production domain, and no CORS configuration.** `apps/api`
binds `127.0.0.1:3000` by default and registers no CORS plugin at all — `grep -rn "cors" apps/api/src`
returns nothing. Any decision that requires a cross-origin browser request would require adding CORS
to the API, which is a production security decision this milestone must not make on the strength of
local convenience.

**The design system is already delivered through Tailwind v4.** `packages/ui/src/styles.css` declares
its semantic tokens in `:root` and then re-exposes them through an `@theme inline` block, and both
shared primitives — `BrandMark` and `WasteIcon` — are styled entirely with the utilities that block
generates (`bg-ar-brand`, `text-ar-waste-bio-text`, `shadow-ar-brand`). Without a Tailwind pipeline
those class names resolve to nothing and the shared primitives render unstyled. Tailwind is therefore
not an open framework choice here; it is the existing transport of the design tokens.

**Provenance and honesty rules carry over unchanged.** ADR 0003 makes every response state its
source, retrieval time, validity window, freshness, and declared waste-type coverage precisely so a
surface can label what it shows. A second surface must not weaken any of that, and must not present
an absence of data as a statement the source did not make.

**A schedule is a municipal calendar, not a device calendar.** ADR 0004 already decided that today is
today in the zone the source publishes in. A second client deriving it differently would show a
different window — and a different "Heute" — for the same area, which is worse than either client
being wrong alone.

**`@abfall-radar/api-client` must not depend on `@abfall-radar/domain`.** ADR 0004 decided this, and
[the architecture](../architecture/repository-structure.md) restates it: the client owns the wire
shape, the domain owns the business model, and mapping between them belongs to a consumer. ADR 0004
added one qualifier — the extension's adapter stays in the extension until a second consumer exists.
The web application is that second consumer, so the qualifier has to be resolved rather than
restated. It resolves into
[the canonical extraction rule](../architecture/repository-structure.md#when-a-mapping-becomes-shared):
another consumer triggers an explicit comparison, and never automatically justifies a shared package.

**This is a first vertical slice, and its value is in being complete rather than broad.** A person
must be able to reach a real official schedule with its provenance intact. Everything that does not
serve that is deferred, including the persistence, offline behavior, waste-type preferences, and
reminder surfaces the extension already has.

## Decision

Activate `apps/web` as a React 19 and TypeScript Vite application that consumes
`@abfall-radar/api-client` directly, over same-origin requests, with session-only selection state.

### `apps/web` is a Vite application built from the existing dependency catalogue

- React 19 and TypeScript, built and served by Vite, tested by Vitest with jsdom and Testing Library.
- `dev`, `build`, `test`, `test:watch`, and `typecheck` scripts. Turborepo's generic `build`, `test`,
  `test:watch`, and `typecheck` tasks and the root `dev:web` script already exist, so declaring the
  scripts is what integrates the workspace into `pnpm check`. One narrow `turbo.json` addition is
  required — the emitted-artifact verifier's dependency on the web build — and nothing else. That
  verifier is invoked **through Turbo**, because a direct `pnpm --filter` workspace-script call does
  not read `turbo.json` and would inspect whatever output already existed. That task is declared
  **`cache: false`**: the build it depends on may be replayed from cache, but the **inspection** must
  execute every time, or a cached pass would report on artifacts nobody looked at.

  **Verification is two layers, because a task cannot verify its own cache behaviour.** The inner
  task inspects artifacts and claims nothing about how Turbo scheduled it. A separate **root-level
  outer meta-verifier**, outside the Turbo graph, asserts the resolved `cache: false` and the build
  dependency from a structured dry run, then invokes the authoritative command twice as child
  processes and proves from each run summary that the inner task executed with caching bypassed.
  Asking the inner task to observe that would mean invoking Turbo from inside a Turbo task to watch
  itself — recursive, and self-reported. **Replayed stdout is not evidence**: a cache hit reprints the
  original logs verbatim, so only structured summary fields distinguish execution from replay.
- **Every dependency is already pinned in `pnpm-workspace.yaml`'s catalogue, with two approved
  exceptions.** That is a deliberate constraint, not a coincidence: a version this repository has not
  already agreed on is a dependency decision. The two exceptions are `postcss` **8.5.28** and
  `postcss-value-parser` **4.2.0**, as two new catalogue entries declared only as `apps/web`
  devDependencies, needed by the production dependency guard's CSS traversal because no CSS parser is
  resolvable from a workspace under pnpm isolation. The constraint was honoured by asking rather than
  by quietly widening the rule: **the repository owner approved both packages at both versions on
  2026-09-15**, which removed AR-005's dependency blocker. The approval covers exactly those versions
  and that declaration; they are **approved, not verified installations**, and any other version or
  scope needs a new decision.
  [AR-005](../tasks/AR-005-responsive-web-schedule.md#dependency-approval-record) records the exact
  entries and the approval.
- **No browser test runner is added.** Vitest with jsdom is the whole automated surface, and
  [Verification scope](#verification-scope-what-jsdom-proves-and-what-it-cannot) states plainly what
  that can and cannot establish. Playwright, another browser runner, and screenshot or
  visual-regression tooling are all out of scope for this milestone.
- `@abfall-radar/api-client`, `@abfall-radar/domain`, and `@abfall-radar/ui` are workspace
  dependencies. `@abfall-radar/data-providers` is not, and no module may import it: the API is the
  web application's only data boundary, exactly as it is the extension's.
- **Nothing from `apps/extension` is imported, and no browser-extension API is referenced.** Shared
  packages never import an application, and one application importing another is the direction the
  architecture forbids outright.

### Tailwind is adopted as the token transport, not as a styling framework choice

`@tailwindcss/vite` and `tailwindcss` are added because `packages/ui` already requires them. The web
stylesheet does **not** copy the popup's `@import "tailwindcss";`, because that form leaves Tailwind's
**automatic source discovery** on — and discovery reads files without any import edge, so a unique
utility written only in an unimported test fixture would generate production CSS while the import
guard stays green. The web stylesheet therefore **disables discovery and registers sources
explicitly**, every path relative to its own directory, `apps/web/src/app/`:

```css
@import "tailwindcss" source(none);
@import "@abfall-radar/ui/styles.css";

@source "../../index.html";
@source "..";
@source "../../../../packages/ui/src";

@source not "../test";
@source not "../**/*.test.ts";
@source not "../**/*.test.tsx";
@source not "../**/*.spec.ts";
@source not "../**/*.spec.tsx";
@source not "../../../../packages/ui/src/**/*.test.ts";
@source not "../../../../packages/ui/src/**/*.test.tsx";
@source not "../../../../packages/ui/src/**/*.spec.ts";
@source not "../../../../packages/ui/src/**/*.spec.tsx";
```

The `packages/ui/src` registration is still what makes `BrandMark` and `WasteIcon` utilities reach the
web build. `@source ".."` is a broad positive directory, acceptable **only** because the exclusions
remove every protected descendant; that is why the check evaluates the **effective scanned file set**
rather than a glob's base directory. `@source not` is an exclusion, not a forbidden load, and **content
discovery is a separate check from CSS import traversal** — the two answer different questions and
neither substitutes for the other. The shared UI stylesheet was read and contains no `@source` or
`source(…)` of its own, and the check keeps it that way.
[AR-005](../tasks/AR-005-responsive-web-schedule.md#tailwind-content-discovery) holds the resolved
paths, the assertions, and the post-build proof.

No component framework and no second CSS framework is added. Semantic tokens plus utilities are
already how every reviewed surface in this repository is built.

### No router, no state-management library, and no query library

- **No router.** This slice has one document and two composed surfaces — needs-selection and the
  schedule — and which one is shown is application state rather than an address. Adding a router now
  would also imply that the selection belongs in the URL, which would make it shareable and
  bookmarkable state that this milestone deliberately does not persist. A router becomes a real
  decision when there is a second addressable surface or when a selection should be linkable.
- **No state-management library.** There is one selection and one request lifecycle. The shared
  rules already say not to introduce global state until multiple independent features need
  coordinated state.
- **No query library.** The request lifecycle this slice needs is one in-flight attempt at a time with
  newest-selection-wins — superseded by a new selection **or by the source-local date changing** — and
  `@abfall-radar/api-client` already owns deadlines, cancellation, and failure translation. A query
  library would add caching and retry policy that this milestone has explicitly decided not to have,
  and both would then be product behavior owned by a dependency rather than by the application. Its
  refetch-on-focus would also be the wrong mechanism for the midnight refresh, which must be driven by
  the source zone's calendar rather than by window focus.
- **No PWA plugin, service worker, or manifest.** Offline behavior is an honesty problem before it is
  a caching problem, and ADR 0004 needed a whole intersection rule to make a cached schedule
  truthful. That work is deferred as a decision, not merely as an implementation.

### The web application calls `api-client` directly, from a named data layer

`apps/web/src/adapters/` is the web data layer, and it is the only place a request exists:

- `api-client.ts` resolves the base URL, wraps the browser `FetchLike`, and constructs the single
  `ApiClient`;
- `schedule-gateway.ts` exposes the three reads the product needs, each accepting an `AbortSignal`;
- `collection-event.ts` maps a validated transport event onto the domain model.

**No worker message round trip is introduced.** The reason ADR 0004 needed one does not exist here:
a web document is not destroyed by the user glancing away, it can cancel its own requests, and there
is no second process that owns storage or alarms. Adding a message hop would buy nothing and would
place the timeout and failure policy behind a boundary that has no owner on the other side.

The rules that made that boundary valuable are kept without it:

- **All HTTP goes through `@abfall-radar/api-client`.** No component, hook, or feature module calls
  `fetch`. An import-graph test asserts it rather than a convention.
- **API responses stay untrusted** and are accepted only after the client's runtime validation. The
  client already rejects a response that does not answer the request that was made, that is not
  official data, or that carries an event outside the requested range.
- **`packages/ui` performs no data fetching and no transport mapping**, per its ownership row.
- **The data layer is injectable**, so every product state — including ones that depend on a race
  between two responses — is reachable from a test without a network, a real server, or a debug
  control in the product.

#### The web boundary bypasses the browser HTTP cache

The web application owns one transport policy in `apps/web/src/adapters/api-client.ts`: it constructs
`@abfall-radar/api-client` with a browser `FetchLike` wrapper. For every AbfallRadar request, the
wrapper preserves the API client's method, headers, abort signal, body, credentials, mode, redirect,
referrer, integrity, and every other supplied `RequestInit` member, then overrides `cache` **last** to
exactly `'no-store'`. A caller-supplied `cache` value therefore cannot weaken the policy.

The same client and wrapper serve all three reads — `listProviders`, `listServiceAreas`, and
`listCollectionEvents` — and remain in use for Retry, reconfirmation, source-midnight refresh,
focus/visibility revalidation, bounded 422 reconciliation, and range recovery. Those paths must not
call raw `fetch`, construct another client, or replace the wrapper with a different gateway method.

`cache: 'no-store'` prevents the **browser HTTP cache** from answering or storing these web requests.
It does not bypass the API's deliberate server-side official-source cache, and it is separate from the
web product rule that no schedule is persisted in `localStorage`, `IndexedDB`, cookies, a service
worker, or an offline schedule cache — a rule
[addendum 2](0005-addendum-2-confirmed-selection-persistence.md) leaves intact: it stores the confirmed
selection's identifiers, never a schedule. The web does not change `packages/api-client` globally and does
not alter the extension's worker-owned transport or caching behavior.

Deterministic adapter tests use a recording fake `FetchLike` and no real network. They exercise all
three reads and assert, for every captured request, exact `cache: 'no-store'`, preservation of method,
headers, abort signal, and other `RequestInit` members, and rejection of a conflicting supplied cache
mode. Gateway-boundary assertions prove Retry, reconciliation, and recovery reuse this same client
and wrapper rather than raw `fetch`.

### Requests are same-origin, and local development proxies rather than relaxing CORS

- The client's base URL is the document's **own origin**, resolved through the named browser-origin
  resolver below rather than read from a single global.
- **No production API domain is invented or committed**, real or placeholder. There is nothing to
  name yet, and a placeholder host in a build artifact is indistinguishable from a real one to
  everything that reads it.
- **Local development proxies the API path to `http://127.0.0.1:3000`** through Vite's dev server.
  The loopback literal is used rather than `localhost`, matching the API's default `HOST`, so no name
  resolution can send the request to an address the API is not bound to.
- **No CORS configuration is added to `apps/api`.** A cross-origin development setup would mean
  shipping a permissive origin policy on the API for the convenience of one dev server, and a policy
  added for development is the one that survives to production unnoticed. The proxy keeps the browser
  seeing one origin, which is also what production will look like.

Production hosting, reverse-proxy configuration, DNS, TLS, CORS policy, and deployment remain a
separate later decision. This ADR deliberately stops at the point where the web application consumes
the contract correctly against a locally running API.

#### An opaque origin is detected from the serialized global origin, not from `location`

`window.location.origin` is the wrong sole signal, and the failure it misses is the one that matters.
A **sandboxed iframe** without `allow-same-origin` has an **opaque** security origin — `window.origin`
serializes to `"null"` — while `window.location.origin` still reports the perfectly ordinary
`https://sandbox.example.test` of the document that was loaded. Reading only `location` would
conclude the context has a usable tuple origin, build request URLs from it, and issue requests that
the browser
then treats as cross-origin from an opaque origin. That is a security-relevant misread, not a
cosmetic one.

The decision is therefore **one named browser-origin resolver** with two primitive string inputs, so
the rule is testable without constructing a real sandboxed frame:

| Input | Source |
| --- | --- |
| serialized global origin | `window.origin` / `globalThis.origin` |
| location origin | `window.location.origin` |

- **The serialized global origin is authoritative** for whether this browsing context has a usable
  tuple origin. It is what the HTML standard serializes an opaque origin to, and it is the only one of
  the two that reflects the *security* origin rather than the URL.
- **It is rejected as a configuration failure — before any request is issued — when it is `"null"`,
  empty, malformed, not HTTP(S), or otherwise opaque.**
- **The usable global origin and the location origin must agree after normalization.** Disagreement
  means the two answers describe different things, and nothing in this application knows which to
  believe, so it refuses rather than picking one.
- **A usable security origin is never inferred merely because `Location` still exposes an HTTP(S)
  URL.** That is precisely the sandboxed-frame case.
- **`document.domain` is not consulted.** It is deprecated, it mutates the origin check in ways
  nothing here wants, and setting or reading it would make the origin a moving target.
- **There is no fallback.** Not to loopback, not to a configured host, not to anything.
- Production runtime stays **same-origin only**.

**Rejection ends in a rendered state, not merely in the absence of a request.** "Issue no request" is
only half an answer: on its own it produces a blank page or a spinner that never resolves, which is
the worst outcome of the three because the person cannot tell whether it is broken or slow. The
resolver's rejection therefore has its own product state, described next.

#### `configuration_error` is a rendered state, not a silent refusal

`configuration_error` is a distinct member of the exhaustive view-state union. It applies when the
browser-origin resolver rejects the environment **before the client is constructed**:

- the serialized global origin is opaque or `"null"`;
- the origin is empty or malformed;
- the scheme is not HTTP or HTTPS;
- the global origin and the location origin disagree after normalization;
- any other browser-origin validation fails before client construction.

What it must do:

- **render a complete, accessible German surface inside the normal application shell** — the same
  header and layout as every other state, not a bare error string;
- **explain in product language** that AbfallRadar cannot securely reach the service from this page
  context;
- carry a **stable heading** and appropriate **status or alert semantics**, so a screen-reader user is
  told rather than left on an unchanged page;
- **leave no loading spinner active**, and preserve the usual visible-focus behaviour;
- **issue no api-client call.**

What it must not do:

- **display the rejected origin, the URL, the scheme, a raw exception, a stack trace, or any internal
  validator message.** None of those is product copy, and the rejected origin in particular is the one
  value most likely to be pasted somewhere it does not belong;
- **fabricate an operation, an HTTP status, or a `requestId`.** No request was made, so none of the
  three exists;
- **be classified as `network`, `invalid_response`, `timeout`, or Problem Details.** Those describe
  something that happened to a request. This describes a request that was never permissible.

**Recovery is stated honestly rather than offered falsely.** A retry button cannot repair a browsing
context: a sandboxed frame stays sandboxed and a `file:` document stays opaque however many times it
is pressed. Where recovery means opening the application in an ordinary HTTP(S) page, the copy says
so, and no control pretends otherwise.

The resolver is a pure function over those two strings, so every case — including the sandboxed frame
— is reachable from a unit test by passing the pair, with no iframe and nothing jsdom has to emulate.

#### Where an absolute API origin may and may not appear

"Same-origin" and "the dev server needs a proxy target" are only in tension if the prohibition is
stated as *no absolute host anywhere*. It is not. The rule is about **what ships and what the runtime
constructs**, and it is precise per location:

| Location | Absolute API origin |
| --- | --- |
| `apps/web/vite.config.ts`, the dev `server.proxy` target | **Required, exactly one value:** `http://127.0.0.1:3000` |
| Tests and documentation **that verify or describe that proxy** | **Permitted**, the same literal |
| Test fixtures | **Scoped by fixture category** — API-origin fixtures keep the reserved-origin rule; artifact-verifier fixtures may carry the real sanctioned literals and their near-match variants |
| `apps/web/src/**` — production runtime application source | **Forbidden.** No hard-coded absolute API origin of any kind |
| Production JavaScript, CSS, and HTML output | **Forbidden:** every absolute HTTP(S) URL occurrence is rejected unless it matches one of the four categories in [AR-005's canonical emitted-URL policy](../tasks/AR-005-responsive-web-schedule.md#the-four-sanctioned-categories), which is the single enumeration this ADR defers to |

- **`vite.config.ts` is build tooling, not production runtime application source.** Vite consumes
  `server.proxy` in the dev-server process; it never enters the module graph the production build
  emits. That is exactly why the literal belongs there and must not appear in the output, and why a
  scan must treat the two locations as different things rather than as one rule.
- **Runtime product code issues same-origin requests.** It reads the document's own origin rather
  than naming one, which makes the property structural instead of a convention someone maintains.
- **The proxy forwards only the documented API path, and its context is segment-aware.** Vite's
  string proxy keys are **prefix** matches, so a plain `/api` key also captures `/apiary`, `/api-old`,
  `/apis`, and `/application`. The context is therefore the regular expression `^/api(?:/|$)`, which
  matches `/api`, `/api/`, and `/api/v1/providers` and none of the near misses. A broader rule would
  silently route application routes into the API and make a same-origin assumption production cannot
  honour.
- **No production API origin is invented**, real or placeholder, and none is derived from an
  environment variable either — an env-dependent host is still an invented host, just one whose value
  is decided somewhere the reviewer cannot see.
- **Reserved fixture origins are `*.example.test`** for fixtures that represent an **API origin or
  API-base configuration**, matching the convention already established in `packages/api-client` and
  `apps/extension`. RFC 6761 reserves `.test`, so such a value can never resolve to a real service and
  can never be mistaken for a production host someone forgot to change.
- **That rule does not govern every fixture.** Permission to place text in a fixture and the
  verifier's expected verdict are different questions: an artifact-verifier **negative** fixture is
  allowed to contain a real URL **precisely because** production output containing it must be
  rejected, and a blanket reserved-origin rule would make those rejection tests unwritable. A
  source-attribution URL inside **payload data** is likewise not an API destination.
  [AR-005](../tasks/AR-005-responsive-web-schedule.md#fixture-url-policy) states the four scopes,
  their locations, and the guarantee that these fixtures stay inert data on deterministic local
  transports.

**The emitted-artifact verifier is an all-origin scan, not a denylist.** After a fresh production
build, it recursively reads every emitted HTML, JavaScript, and CSS asset under `apps/web/dist` and
detects absolute `http://` or `https://` occurrences in raw text and contextually decoded values.
[AR-005's contextual-decoding contract](../tasks/AR-005-responsive-web-schedule.md#contextual-decoding-before-url-matching)
covers complete JavaScript literal escapes, CSS escapes, and HTML character references, including
encoded scheme letters and punctuation. Failures report the asset, source locator, and
decoded value. **Every detected occurrence fails unless it matches one of the
[four sanctioned categories](../tasks/AR-005-responsive-web-schedule.md#the-four-sanctioned-categories)**,
which that section enumerates once. The **namespace** allowlist is only one of the four and starts
empty for the application; implementation
may add an entry only when a fresh build proves that exact literal is emitted and documents why it is an identifier rather than a fetchable
application/API origin. **No exception is a host exemption**: none covers another path, query, port,
or near-match.

The production application currently has no legitimate hard-coded network destination. Runtime source
attribution links are validated API data and do not justify an emitted hard-coded origin. Test
fixtures may contain reserved origins specifically to prove rejection; they are never copied into
production output.

The verifier's allowlist fixture uses `http://www.w3.org/2000/svg` as a representative platform
namespace identifier to prove exact-literal handling; that fixture does **not** assert that the web
build needs the literal. A production allowlist entry may be added only after a fresh build emits that
exact value and the handoff records why it is a namespace identifier rather than a network origin.

**One retained license banner needs a third treatment, and it is deliberately not an allowlist
entry.** Tailwind emits `/*! tailwindcss v4.3.3 | MIT License | https://tailwindcss.com */` as the
first bytes of every compiled stylesheet — verified against the pinned 4.3.3 generator in
`tailwindcss/dist/lib.mjs` and against real emitted CSS, not assumed from upstream. The all-origin
scan rejects it, and the namespace allowlist cannot admit it: it is a genuine website, not a
non-network identifier. Both mechanisms are right; the banner is a third case.

The decision is to **keep the banner and give the verifier a comment-context exemption** scoped to a
genuine CSS block-comment token whose complete content matches that exact documented banner. Three
alternatives were rejected. **Stripping the notice** to satisfy our own scan is a licensing problem,
and makes the check configure the artifact instead of inspecting it. **Adding the host to the
allowlist** would admit `https://tailwindcss.com` in a JavaScript string or an `@import` — places it
has no business being — because a host exemption cannot see context. **A blanket comment-stripping
regex** would blind the scan to prohibited URLs in every other comment in every asset type, trading
one true positive for an unbounded class of false negatives.

The exact-match requirement is what keeps this narrow and self-policing: a Tailwind upgrade changes
`v4.3.3`, the match fails loudly, and a person re-reads the banner rather than a pattern quietly
absorbing whatever the new version emits.
[AR-005](../tasks/AR-005-responsive-web-schedule.md#the-tailwind-license-comment-exemption) states the
full rule, its fixtures, and its evidence.

**A pinned dependency's diagnostic link needs a third form, for the same reason and by the same
method.** React DOM 19.2.8's production error decoder builds its documentation link from a hard-coded
prefix — `var url = "https://react.dev/errors/" + code;` in
`react-dom/cjs/react-dom-client.production.js`, verified in the installed package and in a real
emitted bundle rather than inferred from upstream documentation. It ships in any production bundle
importing `react-dom/client`. It is a JavaScript string value, so the CSS-comment exemption cannot reach
it, and it is a genuine fetchable website, so it is not a namespace identifier.

The decision is to **sanction the exact prefix value and keep React's production diagnostics
intact**, matched only as the complete decoded value of an **ordinary string literal or a
no-substitution template literal** in an emitted JavaScript asset. Both forms are sanctioned because
the pinned source writes a double-quoted literal while the bundler emits
`` var t=`https://react.dev/errors/`+e ``; a substituted template, an individual segment of one, and
any evaluated or constant-folded expression stay outside the exemption. The alternatives were worse
in kind, not merely in degree: **patching React** or
**removing production diagnostics** degrades a person's ability to diagnose a real failure so that our
audit stays quiet; **a development React build** is not shippable; and **relying on tree-shaking** to
drop code the required import retains is a hope, not a mechanism.

Exact equality is sufficient precisely because React concatenates the error code at runtime, so no
complete `…/errors/123` literal is ever emitted. A prefix or hostname rule would therefore admit
strictly more than the artifact actually contains, for no benefit.

**The exemption grants the application nothing.** It is an artifact-audit accommodation for a pinned
dependency, and it does not authorize first-party code to use that address as an API base URL or any
network destination. An exact-literal output allowlist cannot tell dependency provenance from
first-party use of an identical string — which is why the first-party source scan and the gateway's
same-origin contract keep their own independent enforcement, and why no requirement is introduced to
reconstruct package ownership from minified JavaScript.
[AR-005](../tasks/AR-005-responsive-web-schedule.md#the-react-diagnostic-literal-exemption) states the
rule, the guard ownership, the fixtures, and the dependency baseline inventory.

The enforcement is therefore five checks, with the second being the authoritative all-origin output
scan. **This count is about checks and is unrelated to the four emitted-URL categories.**

1. **`apps/web/src/**`, test files and `src/test/` fixture data excluded, contains no absolute API
   origin.** This is the production runtime source; the fixture exclusion is what lets the sanctioned
   verifier fixtures exist at all.
1b. **No production entry reaches an excluded test or fixture module.** The exclusion in check 1 is a
   hole on its own: production code could import a fixture's exported value, check 1 would never see
   the literal, and check 2 would *exempt* the emitted result because a sanctioned category covers
   it — a prohibited production use shipping with every check green. An **emitted-URL exemption is an
   artifact-audit statement and establishes no source provenance**, so the answer is a source-graph
   rule, not a wider exemption. The guard walks from the production entries to a resolved target,
   judges by resolved path rather than specifier text, fails closed on an unresolved in-scope import,
   and runs in the mandatory check path. **Bundle inspection cannot substitute for it**: inlining
   erases the fixture module while its value still ships.

   **HTML is checked before the script graph.** AR-005 admits the complete fixed source shell in
   [the closed HTML-entry contract](../tasks/AR-005-responsive-web-schedule.md#the-html-entry-has-a-closed-source-shell)
   and rejects every added resource or changed entry. Its sole edge is `index.html → /src/main.tsx`.
   The same mandatory check enforces `publicDir: false`, the resolved web root/default HTML input,
   no library mode or CLI entry override, and the declared plugin/configuration boundary. A URL-free
   stylesheet fixture referenced from HTML is therefore rejected before bundling. Source-shell
   equality is never applied to Vite's emitted HTML, which legitimately contains generated links.

   **An import-only walker also misses Vite's URL dependency form.** `new URL('./x.svg',
   import.meta.url)` — alone, or nested in `new Worker(…)` or `new SharedWorker(…)` — makes the build
   emit an asset or a worker entry with no `import` edge at all. AR-005 needs neither, so the form is
   **rejected** in every production-reachable first-party or workspace script rather than traversed:
   an AST visit over the original source finds the `NewExpression` through parentheses and
   syntax-only wrappers, rejects it whatever its first argument is, and does not resolve the file or
   evaluate anything. Ordinary URL parsing without `import.meta.url` is unaffected, as are the
   third-party boundary and the four emitted-URL categories.

   **The graph is not scripts only.** `main.tsx` side-effect imports `src/app/styles.css`, and a
   stylesheet reaches further files through `@import`, Tailwind's `@reference`/`@plugin`/`@config`,
   and local `url(...)` references — so stopping at the first stylesheet leaves
   `main.tsx → styles.css → @import → a fixture stylesheet` entirely unguarded. CSS is therefore
   **traversed recursively, not treated as a leaf**, with the protected-path check applied to every
   resolved target before any kind-specific handling and before a genuine leaf resource terminates the
   walk. **A protected target is rejected because production reached it**, whatever it contains — a
   URL-free fixture is rejected exactly like one holding a sanctioned value, and the CSS pipeline's
   own inlining is why emitted-artifact information cannot answer this question.
   [AR-005](../tasks/AR-005-responsive-web-schedule.md#the-production-dependency-guard) holds the
   boundaries, resolution rules, the `postcss`-based CSS extractor and the dependency declaration it
   requires, the diagnostic, and the honest analysis limits.
2. **The fresh production build output contains no absolute HTTP(S) URL occurrence** outside the
   [four sanctioned categories](../tasks/AR-005-responsive-web-schedule.md#the-four-sanctioned-categories),
   enumerated once there rather than restated here. This catches loopback, fabricated hosts, and
   unrelated origins without maintaining a selected-host denylist.
3. **`vite.config.ts` contains exactly `http://127.0.0.1:3000` as its proxy target** — a *positive*
   assertion, so the development path cannot silently drift to `localhost`, to another port, or to a
   host nobody reviewed.
4. **The proxy context is exactly `^/api(?:/|$)`**, asserted against the resolved configuration and
   exercised against both the matching paths and the near misses that a plain `/api` prefix key would
   wrongly capture.

#### Emitted-output verification is all-origin and fresh-build ordered

The authoritative `@abfall-radar/web#test:build-output` task recursively scans every emitted
production HTML, JavaScript, and CSS asset from the fresh `apps/web/dist` build. It detects every
absolute `http://` or `https://` literal occurrence in raw or contextually decoded text, including
escaped scheme letters, colons and slashes, CSS escapes, and HTML character references. It reports
the asset, source locator, and detected value when it fails. It rejects every
detected occurrence that does not match one of the **four sanctioned categories** defined by
[AR-005's canonical emitted-URL policy](../tasks/AR-005-responsive-web-schedule.md#the-four-sanctioned-categories):

| Category | Rule |
| --- | --- |
| Platform namespaces | The existing **exact namespace-literal** policy — the allowlist is empty until a fresh build establishes an exact required literal |
| Tailwind | The existing **verified CSS license-comment-context** exemption |
| React | The **exact complete decoded value** `https://react.dev/errors/` in an **ordinary string literal or a no-substitution template literal** |
| Zod IPv6 scaffold | The **exact `` new URL(`http://[${IDENTIFIER_PATH}]`) `` shape** in ordinary code inside a validation `try`/`catch` — a parse, never a request |

The namespace allowlist is **one part** of that policy, not the whole of it: stating the scan as
namespace-only is false the moment a legitimate license banner, a pinned dependency's diagnostic
link, or a dependency's URL-parsing scaffold ships. Each category keeps its own matching restriction, and a near-match, another
path/query/port, or another URL on the same host never inherits an exemption. No selected API-host
denylist is the primary guarantee.

The verifier has `dependsOn: ["@abfall-radar/web#build"]` and `cache: false`, and every authoritative
invocation goes through Turbo. The inner task only scans output; the root outer meta-verifier proves
the dependency and uncached execution from structured Turbo summaries without recursive
self-verification. Deterministic fixtures prove that a clean output passes; loopback,
`https://api.example.test`, and an unrelated `https://unexpected.example.test` fail; HTML,
JavaScript, CSS, and escaped JavaScript origins fail; an exact explicitly allowlisted platform
namespace literal, the verified Tailwind banner in its comment, the React value in either permitted
JavaScript literal form, and the exact Zod IPv6 scaffold shape in ordinary code inside its validation
`try`/`catch` all pass; near-matches — including a **substituted** template literal carrying the React
prefix, and a scaffold whose static segments, interpolation, or enclosing context differ — fail; and failure output names the offending asset and value.
The ordinary test suite never reads `dist` and performs no real network access.

**Parser reuse replaces the former hand-written emitted-JavaScript lexer.** TypeScript is already
declared; the verifier uses a no-emit JavaScript `Program` with public syntactic diagnostics and AST
literal values/source spans. The Zod exemption requires the actual discarded `new URL` expression in
an enclosing try block with a catch clause, plus its unchanged raw scaffold restrictions. A comment
or string containing lookalike source cannot qualify. Vitest's jsdom environment supplies inert HTML
character-reference decoding through the typed DOMParser API; the two approved CSS parsers
locate CSS tokens whose escapes are decoded explicitly.
Their raw values are not assumed to be cooked. No additional dependency is introduced.
The inner runner has its own Vitest configuration and one dist-reading verification entry, explicitly
excluded from ordinary test discovery. Both use the same scanner; script execution and subresource
loading stay disabled. DOM library types avoid requiring a new direct jsdom type dependency.

Raw and decoded candidates retain context: full legal JavaScript escapes apply to whole literals,
CSS escapes follow CSS Syntax, and HTML references are decoded once per language layer. Tagged or
substituted template segments receive no React exemption, and encoded near-matches receive no
exemption of their own. First-party Check 1 also decodes JavaScript/JSX/CSS literals without adopting
dependency exemptions. The task's regression matrix covers escaped schemes/colons, line continuations,
double-escaped text, CSS/HTML encodings, and ordinary minified regex/division syntax.

This is a static literal-occurrence scan; it does not execute assets or prove which URLs arbitrary
runtime computation could construct. Syntax/decoding ambiguity fails explicitly. Same-origin gateway
construction, source provenance, and the four exact emitted categories remain separate contracts.

### Failures are distinguished, and no server diagnostic string is rendered

The web application reuses the client's failure taxonomy unchanged and renders its own German copy
per kind. It never renders a `detail`, an `instance`, an `errors` entry, or any other server-supplied
string: the client already discards those at the parse site, and this surface must not reintroduce a
channel for them.

**`error` is one top-level state with an exhaustive failure context.** The transport failure still
uses the client's discriminated union: `network` and `invalid_response` are **failure subtypes**, not
top-level application states. The surrounding context records which product phase
owned the failed request, because identical transport operations can require different Retry
transitions. The top-level union is the nine members in
[the exhaustive application state union](#the-exhaustive-application-state-union):

```ts
/**
 * Web-owned and never from the wire: `deriveSourceToday` could not produce a source-local date.
 * No api-client `operation`, no HTTP `status`, no `requestId` — nothing failed over HTTP.
 */
type SourceDateUnavailable = {
  readonly kind: 'source_date_unavailable';
  readonly timeZone: string;
};

/**
 * Only the two phases that actually derive a source date admit the local failure. Selection
 * phases never call `deriveSourceToday`, so their failure stays exactly `ApiFailure`.
 */
type ScheduleFailure = ApiFailure | SourceDateUnavailable;

/** Cancellation is control flow and never reaches a surface, whatever the phase. */
type Renderable<Failure> = Exclude<Failure, { kind: 'cancelled' }>;

type RenderableApiFailure = Renderable<ApiFailure>;

/**
 * Maps each context's own `failure` type, so the phase constraint survives the mapping: a
 * selection context still yields `RenderableApiFailure`, a schedule or recovery context yields
 * `RenderableApiFailure | SourceDateUnavailable`.
 */
type WithRenderableFailure<Context> = Context extends { failure: infer Failure }
  ? Omit<Context, 'failure'> & { failure: Renderable<Failure> }
  : never;

/** Exactly the terminal range problem. Not a new interface — a narrowing of `ProblemFailure`. */
type ExactRangeProblem = ProblemFailure & {
  readonly operation: 'listCollectionEvents';
  readonly status: 422;
  readonly code: 'SCHEDULE_RANGE_NOT_COVERED';
};

type ErrorViewState = {
  readonly kind: 'error';
  readonly context: WithRenderableFailure<
    Exclude<FailureContext, { phase: 'range_recovery' }>
  >;
};

type RangeNotCoveredViewState = {
  readonly kind: 'range_not_covered';
  /** The schedule-pipeline problem that caused entry, when a terminal one did. */
  readonly triggeringRangeProblem?: ExactRangeProblem;
  /** The current recovery cycle's renderable failure. Owned by `range_recovery` alone. */
  readonly lastRecoveryFailure?: WithRenderableFailure<
    Extract<FailureContext, { phase: 'range_recovery' }>
  >;
};
```

`FailureContext` is defined once in
[the phase-aware Retry contract](#erneut-versuchen-is-phase-aware-not-operation-routed). Its
selection phases carry the exported `ApiFailure` from `@abfall-radar/api-client` unchanged, and its
two source-date-bearing phases carry `ScheduleFailure`; **no parallel transport failure interface is
invented**, api-client operation metadata stays accurate, and `ExactRangeProblem` narrows the
exported `ProblemFailure` rather
than restating it. A range-recovery failure stays nested in `range_not_covered` as
`lastRecoveryFailure`, so it never becomes this top-level `error` state.

**`RenderableApiFailure` is where cancellation leaves the model.** The transport still returns every
`ApiFailure`, cancellation included; the **transport-to-UI boundary handles it first** — before a
stored UI failure is constructed, before copy is selected, and before anything is announced. Every
stored failure context, the copy mapper's input, and the test parameterization use the **renderable**
form of whatever failure type its phase carries — `RenderableApiFailure` for the two selection phases,
and `RenderableApiFailure | SourceDateUnavailable` for the two that derive a source date — so
"exhaustive over the renderable failures" is a type-level fact rather than a convention, and it
covers the local failure in exactly the phases that admit it. Cancellation therefore needs no copy
entry and no announcement to satisfy exhaustiveness.

#### `range_not_covered` carries two independent diagnostics

The state is reached two ways, and only one of them has a server-supplied identifier to show. Keeping
them in one slot would either lose the triggering identifier or let a later recovery failure inherit
it.

| Field | Owner | Populated when |
| --- | --- | --- |
| `triggeringRangeProblem` | the schedule pipeline that entered the state | **only** by a terminal exact range problem after the shared reconciliation budget is exhausted |
| `lastRecoveryFailure` | `phase: 'range_recovery'` alone | by the **current** recovery cycle's renderable failure |

**Entry rules.** A **local capability-derived** uncovered range has **no** `triggeringRangeProblem` —
including *first exact 422 → reconciliation → refreshed capability yields no requestable range*. The
earlier provisional 422 is **not** attached to that local entry: reconciliation answered it, and the
state is now a statement about the refreshed capability. A **terminal** exact range problem populates
the field with **that terminal validated problem** — covering *first 422 → reconciliation → second
422* and *metadata mismatch → reconciliation → exact 422*. Two HTTP 422 responses are not required;
**exhaustion of the one shared budget is what matters.** The attempt token, owning phase, and
confirmed selection are checked **before** storing the problem or changing state.

**Lifetime.** `triggeringRangeProblem` is retained for the **current range episode**. Later recovery
failures update **only** `lastRecoveryFailure`, which is **cleared when a new recovery cycle begins**
and repopulated only with that cycle's current renderable failure — so a successful revalidation that
remains uncovered leaves it **absent**. Leaving the range episode, starting a new confirmed schedule
episode, changing selection, and authoritative invalidation discard both as appropriate; **a new
episode for the same provider/area inherits neither.** Unmount discards ownership without updating an
unmounted state, and a cancelled or superseded completion can **neither install, replace, nor
restore** either diagnostic.

**Display.** The triggering problem's `requestId` is shown when that validated value exists, labelled
as the **initial range-response** diagnostic; a recovery problem's `requestId` is shown in its own
**separately labelled recovery** diagnostic. A recovery `network`, `timeout`, or `invalid_response`
failure **never borrows** the triggering identifier or an earlier recovery identifier — those kinds
carry none. An independently retained and labelled initial diagnostic may remain visible alongside a
recovery diagnostic. **No empty diagnostic label is rendered** when no validated identifier exists.
German copy and the accessibility conventions are unchanged.

None of this changes reconciliation budgets, retry counts, or lifecycle ownership.

| Failure subtype | Raised when | German meaning wherever the phase contains it | `requestId` |
| --- | --- | --- | --- |
| `network` | `fetch` itself rejected — no HTTP response ever existed | The API could not be reached | Never |
| `timeout` | The configured deadline elapsed | The request exceeded its deadline | Never |
| `invalid_response` | An HTTP response arrived that cannot be used as this contract | The API answered with something unusable | Never |
| `problem`, unrecognized `code` | A validated Problem Details body | **Generic** problem copy | **Yes**, the validated one |
| `problem`, recognized `code` | A validated Problem Details body | Copy selected by `code` | Yes |
| `source_date_unavailable` | `deriveSourceToday` could not derive a source-local date from the validated capability zone — **web-owned, never from the wire**, with no fabricated api-client `operation`, HTTP status, or `requestId` | The current date in the source's time zone could not be determined, so no schedule is shown for it | **Never** — and it never borrows a retained `triggeringRangeProblem`'s |

For non-recovery contexts that copy appears in the top-level `error` surface. For
`phase: 'range_recovery'` it appears as the nested refresh diagnostic while the top-level
`range_not_covered` state remains. Failure kind controls the words and identifier policy; phase
controls containment, actions, and Retry.

**The last row is phase-restricted by the type, not by convention.** `selection_providers` and
`selection_areas` never derive a source date, so their `failure` stays exactly `ApiFailure` and the
combination does not typecheck. `schedule_pipeline` and `range_recovery` carry `ScheduleFailure`,
per [the failure-context types](#failures-are-distinguished-and-no-server-diagnostic-string-is-rendered). Its
checkpoint behaviour — preflight, initial and reconciled publication, the accepted-pair watchdog, and
both recovery checkpoints — is canonical in
[AR-005 step 3c](../tasks/AR-005-responsive-web-schedule.md#3c-source-date-derivation-failure-at-every-checkpoint)
and is not restated here. Recovery source-date failures keep `range_not_covered`, its coordinator,
`Erneut versuchen`, and periodic recovery.

**It carries the same copy and announcement obligations as every other subtype.** The exhaustive
German-copy record and the live-region announcement rule stated for this union cover it in each state
where its phase admits it — the top-level `error` surface for `schedule_pipeline`, and the nested
refresh diagnostic inside `range_not_covered` for `range_recovery`. No separate copy mechanism is
introduced.

Three outcomes are deliberately **not** members of that subtype union:

- **`cancelled` is not a rendered error subtype.** It means the attempt was superseded, so it
  publishes no error state at all — it is excluded by `RenderableApiFailure` at the
  transport-to-UI boundary, not filtered later by a branch that could be forgotten.
- **`configuration_error` remains its own top-level state**, because no API operation was ever
  constructed — there is no operation, status, or identifier for a failure shape to carry.
- **`range_not_covered` remains its own top-level product state**, as already specified: it is a
  statement about the source's calendar rather than a fault.

**An unrecognized problem `code` still renders a validated `requestId`.** Generic copy is about not
having words for a code this build has not seen; it is not a reason to withhold the correlation
identifier the server did supply.

Every member of **`RenderableApiFailure`** must have **visible German copy, defined live-region
behaviour, and a `requestId` policy**, recorded in an exhaustive map keyed by that type's `kind` — so
`cancelled` is outside the map by construction rather than by a special case inside it. Retry and
action policy is instead exhaustive over `FailureContext['phase']`, because `failure.operation` cannot
identify why a request was running. Missing either dimension is a compile error rather than undefined
copy or an incorrect Retry path. **No renderable branch falls through to nothing.**

#### Stopping the API is an invalid response, not a network failure

This distinction is easy to get backwards in the one situation a person is most likely to test, so it
is recorded here rather than discovered during verification.

**With the Vite dev server running and `apps/api` stopped, the browser's `fetch` succeeds.** The
request reaches the dev server, which is up; the *proxy* cannot reach its upstream and answers with an
error response of its own. An HTTP response therefore exists, and `@abfall-radar/api-client`
classifies it exactly as its rules require: the status is not ok, the content type is not
`application/problem+json`, so the result is `{ kind: 'invalid_response', operation, status }`. It
carries **no `requestId`**, because no server that owns this contract produced the body.

**The status is `502`, verified against the pinned Vite rather than assumed.** Vite 8.1.5 — the
catalogued version — registers exactly one HTTP proxy error handler, and it writes `502` with
`Content-Type: text/plain`:

```js
proxy.on('error', (err, _req, res) => {
  if ('req' in res) { /* … log … */
    if (!res.headersSent && !res.writableEnded)
      res.writeHead(502, { 'Content-Type': 'text/plain' }).end();
  } else { /* websocket path */ }
});
```

**No custom proxy error handler is configured to produce this.** It is the default behaviour, and the
`configure` hook is deliberately not used.

**The classification is the durable rule; the number is a fact about the current dev server.** Any
non-ok response whose media type is not `application/problem+json` becomes `invalid_response`
carrying whatever status arrived — so a different Vite major, a different reverse proxy, or a
production topology answering `500`, `503`, or anything else is handled without a code change. The
automated tests therefore assert the *rule* against both `502` and `500` `text/plain` bodies, and only
the manual scenario names the number this dev server actually produces.

**A `network` failure means something else entirely: `fetch` rejected before any HTTP response
existed.** DNS failure, a refused connection with no proxy in front, or the browser being offline.

Both are real, both need their own copy, and conflating them would tell a person to check their
connection when the connection is fine and the upstream service is down. The two are reached by
different verification steps, and the ADR's manual scenarios name which is which.

Neither carries a `requestId`. That rule is unchanged and is what the discriminated union enforces.

- **A `requestId` is displayed only for a validated Problem Details response that supplied one.** It
  is never generated, defaulted, or replaced by a placeholder. The client's discriminated union makes
  this enforceable rather than conventional: a failure that never reached a server cannot be typed as
  though it might carry an identifier.
- **An unrecognized problem `code` degrades to generic copy.** The client validates `code` as a
  string rather than a closed enum precisely so a newer server code does not fail validation, and the
  web surface must complete that intent rather than crash or show the raw code.
- **A cancellation is never an error.** It means a newer selection superseded an older request — work
  the person themselves replaced.

### A successful empty answer is its own state, never a failure and never a spinner

Three responses can succeed and carry nothing. Each is a different statement, each is a **top-level
member of the exhaustive view-state union** rather than an informal outcome nested inside another
state, each renders dedicated German product copy, and each suppresses exactly the requests that
would follow it. Treating any of them as loading would leave a person watching a spinner that will
never resolve; treating any of them as an error would blame the network for an answer the server gave
correctly.

| Successful response | State | Downstream requests |
| --- | --- | --- |
| Provider list is `[]`, **or** every entry is filtered out because `sourceKind` is `demo` | **`no_official_providers`** | No service-area request **and** no collection-events request |
| Service-area list is `[]` for an offered official provider | **`no_service_areas`** | No collection-events request |
| Collection events are `[]` inside the effective covered period | **`empty`** | None; the schedule surface is already terminal |

The demo-only catalogue collapses into `no_official_providers` deliberately: demo providers are
filtered out before anything is offered, so a catalogue containing nothing else offers nothing, and
saying so is more honest than rendering an empty picker.

**An area list in which every area is `unavailable` is a different case and must not collapse into
`no_service_areas`.** The provider does serve those areas; it publishes no calendar for them. Every
area is therefore rendered with its explanation and its disabled semantics, and there is simply no
confirmable choice on the surface. Hiding them, or reporting the list as empty, would claim the
municipality does not serve those areas — a claim nothing in the response supports.

**An empty event array is never read as a statement about coverage.** `coverage.wasteTypes` is the
source's own declaration and is displayed as provenance regardless of how many events came back, so a
covered period with no collections shows both "no collections in this period" and the unchanged
coverage list. Inferring coverage from the events would turn a quiet fortnight into a claim that the
source stopped publishing.

#### The exhaustive application state union

**This is the canonical union. Every other section refers to it rather than restating it.** Nine
top-level members, so nothing is left as an unspecified nested outcome:

`configuration_error` · `needs_selection` · `no_official_providers` · `no_service_areas` ·
`loading` · `live` · `empty` · `range_not_covered` · `error`

Two members carry a presentation subtype:

| Member | Subtypes | Meaning |
| --- | --- | --- |
| `live` | `fresh` \| `upstream_stale` | A schedule is displayed. `fresh` is `meta.freshness === 'fresh'`; `upstream_stale` is `'stale'` — the **source's** own staleness per ADR 0003, never a client-side cache, which this milestone does not have |
| `error` | `problem` \| `network` \| `timeout` \| `invalid_response` \| `source_date_unavailable` | The client's own exported failure types, reused rather than restated — plus the one **web-owned** local failure, which is admitted **only** in `schedule_pipeline`. A `range_recovery` source-date failure stays nested in `range_not_covered` and never reaches this member; a selection phase cannot carry it at all |

`cancelled` is **control flow, not a state**: a superseded attempt publishes nothing.

`error.context.phase` supplies request ownership and Retry behavior without adding a top-level state.
`range_not_covered` may carry an optional `triggeringRangeProblem` and an optional nested
`lastRecoveryFailure`; neither diagnostic changes its top-level member or turns it into an `error`.

`needs_selection` means the **selection flow owns the visible surface**, not necessarily that
`confirmedSelection` is null. On first load both selections are null; after `Auswahl ändern`, the
previous confirmed pair may remain retained while the person edits a separate draft. That retained
value neither assigns request phase nor authorizes selection-flow failures to update schedule state.

**Top-level `loading` is post-confirmation schedule work, not "a request is in flight".** Request
**ownership** decides the phase, and the selection flow owns its own catalogue reads:

| Work in flight | Top-level state | Progress shown as |
| --- | --- | --- |
| Bootstrap provider catalogue | `needs_selection` | a nested loading substate of the provider step |
| Service areas for the **draft** provider | `needs_selection` | a nested loading substate of the area step, which keeps `Zurück` available |
| Selection-phase Retry | `needs_selection` | the same nested substate as the read it repeats |
| Post-confirmation schedule pipeline | `loading` | the top-level state itself |
| Range-recovery cycle | `range_not_covered` | its existing nested progress and `lastRecoveryFailure` |

The earlier phrasing — "an attempt is in flight with nothing yet to show" — captured the bootstrap
provider read and the draft area read as top-level `loading`, which contradicts `needs_selection`
owning the selection surface and would take `Zurück` off the screen during the area read that
`Zurück` exists to cancel. **A retained confirmed pair during `Auswahl ändern` does not convert a
draft catalogue request into schedule-pipeline loading**; the request's owner does, and a draft read
is owned by the selection flow.

Each member carries dedicated German product copy, a defined live-region announcement, defined
accessibility treatment, defined action availability, and a defined focus destination. **Adding a
member without all of them is a build or test failure, not a review catch:** the copy and announcement
lookups are exhaustive records keyed by the union, so an unhandled member is a TypeScript error, and a
deterministic test iterates the union asserting each renders non-empty copy and announces itself. A
state that exists in the type system but has nothing to say to a person is the defect this closes.

### Waste types are displayed, not selected

This first slice has **no waste-type selector, no waste filter, and no preference state.** It shows
every event the selected official source published for the effective period, and it shows the
complete declared `coverage.wasteTypes` as provenance.

The consequence is that "the source does not publish waste type X" is not a product state here: there
is no selected type for it to be about. The distinction ADR 0003 protects — an absence of events
versus an absence of coverage — is preserved by *displaying both facts*, which is the honest form of
it when the person has chosen no filter. A waste-type preference is a later milestone, and it is the
milestone that will need the unpublished-selected-type state.

### Source-local calendar days

Every day this application reasons about is a **calendar date in the source's zone**, carried as a
`YYYY-MM-DD` string, and never a `Date` value interpreted in the device zone.

- **`sourceToday`** is derived from the capability's declared `timeZone` with
  `Intl.DateTimeFormat.formatToParts`, the calendar pinned to `gregory` and the numbering system to
  `latn`, reading the `year`, `month`, and `day` parts. A formatted string is never parsed. It is
  **re-derived whenever the source-local date changes**, per
  [the source-day lifecycle](#the-page-revalidates-when-the-source-local-calendar-date-changes) —
  never held for the lifetime of the page.
- **Upcoming events are selected by comparing `event.date` against `sourceToday` as strings.** ISO
  calendar dates sort lexicographically, so this is calendar comparison with no instant and no zone
  in it. This is a second guard rather than the primary one — the requested range already begins at
  `sourceToday` — and it is worth having because it costs nothing and closes the case where a server
  serves a wider range than it was asked for.
- **German relative-day labels** — `Heute`, `Morgen`, `In N Tagen`, and the absolute fallback — are
  computed from `event.date` and `sourceToday` by calendar-day arithmetic over those two dates. The
  absolute fallback is formatted with `Intl` pinned to `UTC`, because a `YYYY-MM-DD` read as UTC
  midnight and rendered in any other zone shifts the date.
- **No ambient `new Date()` is ever passed into a helper that interprets it in the device zone**, and
  **no local-midnight `Date` is ever constructed from a `YYYY-MM-DD` string.** Those are the two ways
  a calendar day silently becomes a device day.
- **Every pure helper takes its dates explicitly** — `(eventDate: string, sourceToday: string)`, both
  ISO calendar dates — so the zone question is answered by the caller that knows the source rather
  than defaulted inside the helper.

**The evidence for zone-independence is three real dates at one instant, and it has to be a
physically possible three.** Tokyo, Berlin, and New York span thirteen hours, so no instant places
them on three different calendar dates — a fixture claiming otherwise is unsatisfiable and would
have to be weakened until it passed. The zones that do span more than a day are the extremes:

| Instant | Zone | `sourceToday` |
| --- | --- | --- |
| `2026-08-02T10:30:00Z` | `Pacific/Kiritimati` (UTC+14) | `2026-08-03` |
| `2026-08-02T10:30:00Z` | `Europe/Berlin` (UTC+2) | `2026-08-02` |
| `2026-08-02T10:30:00Z` | `Pacific/Pago_Pago` (UTC−11) | `2026-08-01` |

Realistic east and west boundaries are then covered by **two separate instants**, each with a stated
expectation, rather than by one impossible claim:

| Instant | Berlin | Other zone |
| --- | --- | --- |
| `2026-08-02T02:00:00Z` | `2026-08-02` | `America/New_York` → `2026-08-01`, the previous date |
| `2026-08-02T16:00:00Z` | `2026-08-02` | `Asia/Tokyo` → `2026-08-03`, the next date |

`apps/extension/src/schedule/schedule-range.test.ts` already reaches for `Pacific/Kiritimati` and
`Pacific/Pago_Pago` for the same reason.

**A runtime missing one of these IANA zones must make the test skip or fail visibly.** Silently
substituting a fixed offset would turn the strongest evidence in this milestone into a test that
passes without exercising anything.

### A mobile drop-off window is formatted in the source zone

Carrying `startsAt`, `endsAt`, and `timeZone` through to the surface is **not** the same as
displaying them correctly, and the gap between the two is where the real defect lives: rendering a
window with a device-default formatter produces a plausible clock time that is wrong for everyone
whose device is set elsewhere. A drop-off is an appointment at a place, so the hour a person travels
by is the operator's.

**A local clock time plus an IANA zone is still ambiguous during a daylight-saving overlap.** When
Berlin falls back on 2026-10-25, the instants `00:30Z` and `01:30Z` both render as `02:30` local —
verified, not supposed. A window shown as `02:30–02:30 (Europe/Berlin)` names one hour twice and
tells a person nothing about which `02:30` to arrive at, or that the window is an hour long at all.

**A window may also legitimately end on a later source-local date.** A drop-off running to 01:00 the
next morning is a real thing a source can publish, and it must be **rendered**, not rejected —
`endsAt` after `startsAt` is the only ordering rule. But shown as `23:30–01:00` it reads as inverted,
or as a same-day window that runs backwards.

**Every displayed endpoint therefore carries its own source-zone UTC offset, and both endpoint dates
appear whenever they differ.** The formatter derives, per endpoint, in the explicit source zone: the
local calendar date, the local clock time, the UTC offset, and the IANA zone. German date formatting,
24-hour time.

| Endpoints | Display model |
| --- | --- |
| Same source-local date | `start time + start offset – end time + end offset (IANA zone)` |
| Different source-local dates | `start date, start time + start offset – end date, end time + end offset (IANA zone)` |

| Case | Instants | Rendered |
| --- | --- | --- |
| Summer | `2026-07-01T10:00:00Z` – `12:00:00Z` | `12:00 UTC+02:00–14:00 UTC+02:00 (Europe/Berlin)` |
| Winter | `2026-11-07T10:00:00Z` – `12:00:00Z` | `11:00 UTC+01:00–13:00 UTC+01:00 (Europe/Berlin)` |
| **DST overlap** | `2026-10-25T00:30:00Z` – `01:30:00Z` | `02:30 UTC+02:00–02:30 UTC+01:00 (Europe/Berlin)` |
| **Cross-midnight** | `2026-03-21T22:30:00Z` – `2026-03-22T00:00:00Z` | `21.03.2026, 23:30 UTC+01:00–22.03.2026, 01:00 UTC+01:00 (Europe/Berlin)` |

The overlap row is one point: two identical clock readings, made unambiguous by two different
offsets. The cross-midnight row is the other: two clock readings that look inverted, made coherent by
two dates. Both were verified against this runtime's ICU.

One named formatter owns this:

- it formats `startsAt` and `endsAt` with `Intl.DateTimeFormat`, **each endpoint independently**;
- it **always passes the event's own `timing.timeZone` explicitly**, and never relies on the device
  default;
- it renders a **German 24-hour clock**;
- it obtains each endpoint's offset from **`timeZoneName: 'longOffset'`**, read through
  `formatToParts`. On `de-DE` that part serializes as `GMT+02:00`, so the formatter **normalizes the
  prefix to `UTC`** for display — the user-visible form is `UTC+02:00`, and nothing parses the
  formatted string for meaning beyond that substitution;
- it **displays the source IANA zone alongside the window**, because a time without its zone is not
  actionable;
- it lets **`Intl` resolve each offset** rather than applying a fixed or shared one — **one offset
  must never be reused for both endpoints**, which is precisely what breaks the overlap case;
- it provides an **accessible label communicating both endpoint offsets unambiguously**, so a
  screen-reader user is not left with two identical clock readings.

`apps/extension/src/schedule/collection-window.ts` is the structural reference — one formatter, used
by every surface, verified by sibling test files that pin the process zone east and west of the
source and assert the **identical** string from both. The web application follows that shape and adds
the per-endpoint offsets. A device-default formatter, or one that stamps a single offset on both
ends, must fail these tests.

**`packages/domain`'s `getUpcomingEvents` and `getRelativeDateLabel` do not satisfy this contract, so
the web application does not reuse them.** Both default their reference to an ambient `new Date()`,
and both call `parseISO` on a date-only string, which yields **local midnight in the device zone**. At
23:30 UTC that makes the same collection "Morgen" in Berlin and "Heute" in New York.

This is not a new discovery and it needs no change to `packages/domain`: `apps/extension` already
reached the same conclusion and does not call those helpers either — `dashboard-view.tsx` has its own
`relativeDayLabel(date, today)` over two ISO strings, with UTC-pinned formatters. The web application
follows the same model independently. **No shared helper is modified**, so no existing extension
behavior or test is affected, and the ambient-date helpers stay where they are until something
deliberately retires them.

### Deterministic event ordering

Nothing in the contract promises an ordered array, and picking the first element of an unordered one
puts an arbitrary date under "next collection". One **total** order is therefore applied everywhere,
and the next collection is chosen **only after** it has been applied:

1. **local event date**, ascending — two `YYYY-MM-DD` strings, compared lexicographically, which for
   this format *is* calendar order with no instant and no zone involved;
2. on the same date, **all-day curbside events before timed mobile drop-offs** — an all-day event
   names no time, so it cannot honestly be placed after something that does;
3. among timed events on the same date, **`timing.startsAt` compared as a full-precision instant**,
   as defined below;
4. **event `id`**, ascending, as the final tie-breaker, used **only when every preceding key is
   equal**, and compared as described immediately below.

**The id tie-break compares opaque strings, so it must not consult a locale.** An `id` is an identity
token, not text for a reader: `localeCompare` and `Intl.Collator` can report `0` for two genuinely
different strings — `"\u00E9"` and `"e\u0301"` are one such pair — and their answer varies with
locale, collation options, ICU version, and device settings. A comparator that can call two distinct
ids equal has no final tie-break at all, and the order stops being total.

The rule is therefore:

- compare the **original, unmodified** `id` strings — no case folding, no Unicode normalization, no
  trimming, and no derived key;
- order **ascending by UTF-16 code unit**, which is exactly what JavaScript's `<` and `>` give for
  strings: equal ids compare `0`, and otherwise `a < b` yields `-1` and `a > b` yields `1`. This is
  **code-unit order, not byte order** — the two differ for anything outside the BMP, and describing it
  as bytes would be wrong;
- the result is **independent of locale, collation, browser and device settings, and input order**;
- two ids compare equal **only when the original strings are exactly equal**, which after the
  uniqueness check means they are the same event.

Neither `localeCompare` nor `Intl.Collator` may be used here, and schema-valid ids are never rewritten
or the uniqueness policy loosened to sidestep this.

Every key is a validated field, and `id` is unique across a response because
[the uniqueness check](#identifiers-are-checked-for-response-wide-uniqueness-at-the-application-boundary)
establishes that before ordering runs. The order is therefore total: it does not depend on the sort
being stable, and two runs over the same set cannot disagree.

#### Comparing `startsAt` at the precision the contract actually accepts

The accepted grammar was read from `packages/api-client/src/contracts/collection-events.ts` and
exercised against the pinned `zod` build rather than assumed. `TimeWindowTimingSchema` uses
`z.iso.datetime()`, whose behaviour today is:

| Input | Accepted |
| --- | --- |
| `2026-11-07T10:00Z` | **yes — seconds are optional** |
| `2026-11-07T10:00:00Z` | yes |
| `2026-11-07T10:00:00.5Z`, `.0001Z`, `.123456789Z` | yes — **fractional precision is unbounded** |
| `2026-11-07T10Z` | no — hour-only is not a valid form |
| `2026-11-07T10:00:00+01:00` | **no** — a numeric offset is rejected |
| `2026-11-07T10:00:00` | **no** — a designator is required |
| `2026-11-07T10:00:00,5Z` | no — a comma decimal separator is rejected |

**Seconds are optional, and that is the form a naive implementation breaks on.** A comparator written
around a seconds-only pattern would reject `2026-11-07T10:00Z` — a timestamp the contract accepts —
turning valid data into a failure. **The transport contract is not narrowed to require seconds** to
make web sorting easier.

Two comparison strategies are therefore **both wrong**, and each fails on a different input:

- **Lexical string comparison** — and `String.localeCompare`, which is also locale-dependent — sorts
  `...:00.500Z` before `...:00Z`, because `.` (U+002E) precedes `Z` (U+005A). The later window wins.
- **`Date.parse` / `Date#getTime` / epoch milliseconds** silently **truncates below a millisecond**.
  `…10:00:00.0001Z` and `…10:00:00.0002Z` both yield `1794045600000`, so two genuinely different
  instants compare equal and the tie-breaker decides an ordering that time should have decided.
  (`.9999Z` truncates to `…999` rather than rounding, which is the same defect from the other side.)

The comparator therefore preserves **all** accepted precision, using only string and integer
arithmetic — no `Temporal`, no new dependency, and no narrowing of the HTTP contract to make web
sorting easier:

1. split the already-validated timestamp into its **whole-second part**, its **optional fractional
   digits**, and its **zone suffix**. The whole-second parser accepts **both minute-precision and
   second-precision forms**; an omitted `:ss` canonicalizes to `:00`, and omitted fractional digits
   canonicalize to zero;
2. compare the whole-second instants **numerically**, parsed as instants — which normalizes a numeric
   offset against `Z` automatically, should the schema ever accept one;
3. when the whole-second instants are equal, **right-pad the shorter fractional string with zeros** to
   equal width and compare the equal-width digit strings;
4. only then fall through to `id`.

Consequences the tests pin:

- `10:00Z`, `10:00:00Z`, and `10:00:00.000Z` are **the same instant** — canonicalization makes the
  three indistinguishable, and none is rejected for lacking an explicit field;
- `.1`, `.10`, and `.100` are **equal** fractional values — padding makes all three `100`. These
  spellings are **synthetic** comparator fixtures; the verified municipal source records **whole
  seconds** (`2026-03-21T10:00:00Z`), and its paired events share an identical instant rather than
  differing in fractional spelling;
- `.0001` sorts **before** `.0002`, which epoch-millisecond comparison cannot express;
- equivalent instants fall through to the next ordering key rather than being ordered arbitrarily;
- nothing is truncated, rounded, or coerced to milliseconds;
- a form the pinned schema does **not** accept never reaches here — it is already an
  `invalid_response` — and is never repaired into something comparable.

**This is the one timestamp comparator in the application.** Event ordering and
[the window-order invariant](#a-drop-off-window-must-not-end-before-it-starts-at-any-accepted-precision)
both call it. Two subtly different timestamp algorithms in one codebase is how a schedule comes to
disagree with itself about which of two instants is earlier.

#### What the comparator requires of its inputs

The comparator is called at **two different stages**, so "already domain-validated" cannot be its
precondition — one of the two calls happens before domain mapping exists:

| Stage | When | Validator that already ran |
| --- | --- | --- |
| Transport cross-field checks, such as `endsAt >= startsAt` | immediately after api-client response validation, **before** transport-to-domain mapping | the **api-client** timestamp validator |
| Ordering rendered domain events | after domain mapping | the **domain** timestamp validator |

The contract is therefore stated as a disjunction:

- the comparator accepts timestamp strings that have already passed **either** the api-client
  timestamp validator **or** the domain timestamp validator;
- **api-client validation is sufficient** when the comparator is called at the transport boundary;
- **domain validation is sufficient** when it is called during domain-event sorting;
- the parser supports **every timestamp form admitted at the transport boundary** — including omitted
  seconds and arbitrary accepted fractional precision — because the transport boundary is the wider
  of the two;
- it compares **complete instants**, never through `Date.parse`, `Date#getTime`, or epoch
  milliseconds alone;
- **an invalid, unvalidated string must never silently receive a sort position** — no `NaN` fallback,
  no treating an unparsed value as zero, no quietly dropping the event. If the helper exposes a
  runtime failure result, that is what an unparseable input produces.

**Transport window-order validation runs before caching, rendering, and domain mapping**, which is
what makes the earlier of the two calls load-bearing rather than redundant.

Rule 3 before rule 4 is the load-bearing ordering choice. An event `id` is opaque, so its lexical
order carries no meaning about time — a 09:00 drop-off and a 14:00 drop-off on one date can have ids
in either order. Ordering by date and id alone would present the later window as the next collection
roughly half the time, which is a wrong answer that looks completely ordinary.

### Identifiers are checked for response-wide uniqueness at the application boundary

**All three list responses have the same gap.** `ProviderSchema`, `ServiceAreaSchema`, and
`CollectionEventSchema` each validate an `id` individually as a non-empty string, and none of
`ProviderListResponseSchema`, `ServiceAreaListResponseSchema`, or
`CollectionEventListResponseSchema` compares one entry's id against another's. A response carrying
two entries with the same id is schema-valid today, in every one of the three.

Every consumer of those arrays assumes otherwise: a React list keys on the id, a selection is
resolved by finding an id, and the event comparator's final tie-breaker is the id. So the assumption
is **checked** rather than trusted, in all three places, with one rule.

#### The invariant matrix

| Invariant | Checked before | Failure operation | Status | Downstream suppressed | Rendering |
| --- | --- | --- | --- | --- | --- |
| Provider id uniqueness | **demo filtering**, rendering, selection | `listProviders` | `0` | Service-area **and** collection-events requests | No provider rendered |
| Service-area id uniqueness | rendering available/unavailable choices, selection | `listServiceAreas` | `0` | Collection-events request | No area rendered |
| Event id uniqueness | domain mapping, ordering, rendering, state publication | `listCollectionEvents` | `0` | — (terminal) | No event rendered |
| Drop-off window order | domain mapping, id-uniqueness publication, sorting, state publication, rendering | `listCollectionEvents` | `0` | — (terminal) | No event rendered |
| **Timed-event zone consistency** | mapping, publication, sorting, labels, formatting, rendering | `listCollectionEvents` | `0` | — (terminal) | No event rendered |
| **Timed-event local-date consistency** | mapping, publication, sorting, labels, formatting, rendering | `listCollectionEvents` | `0` | — (terminal) | No event rendered |

Capability/schedule metadata consistency runs **before all of these**, so every check below already
compares against a `meta.source.timeZone` known to equal the authoritative capability zone.

**Provider uniqueness is checked across the complete validated response, before demo providers are
filtered out.** Filtering first would let a duplicate hide behind an entry the surface never shows,
so a catalogue that contradicts itself would be accepted whenever the contradiction happened to
involve a demo provider — including the case where one duplicate is `demo` and the other
`official_ics`, which is the most dangerous of all: it is a catalogue that cannot say whether that
identifier is sample data or municipal data.

Common rules for all three:

- the check runs **immediately after `@abfall-radar/api-client` validation succeeds** and **before**
  any filtering, rendering, selection, or downstream request;
- a duplicate is an **`invalid_response`** for the real operation, with **`status: 0`** — the
  established unknown/local-status sentinel, because `ApiSuccess` discarded the successful HTTP
  status and inventing one would be a fabricated fact. `0` is not an HTTP status and is never shown;
- **nothing from that response is partially rendered**, and no downstream request is issued;
- **no `requestId` is fabricated** and no rejected record is exposed in the UI or in a log.

Explicitly forbidden, because each is a plausible-looking way to make the symptom disappear while
keeping the contradiction: filtering demo providers before checking; silently keeping the first or
last duplicate; appending an array index to a React key; deduplicating contradictory records; and
adding a comparator key to route around ambiguous identity.

These are **web consumer invariants** in `apps/web`. They add no dependency from
`@abfall-radar/api-client` to `@abfall-radar/domain`, change no OpenAPI route contract and no server
behaviour, and **do not widen `ApiSuccess`/`ApiResult` to retain a status**. Whether the API should
guarantee uniqueness is a separate question this milestone does not answer.

#### Why the event check in particular

The consequences are not cosmetic. A duplicate id makes the final tie-breaker non-deterministic
between two distinct events, so "next collection" could differ between renders; and duplicate React
keys produce reconciliation defects that show one event's details under another's heading. On a
surface whose entire purpose is telling someone the right day, that is a wrong answer wearing the
right label.

A duplicate event id is an `invalid_response` for `listCollectionEvents` with `status: 0`, per the
matrix above. **No event from that response is rendered** — dropping the duplicate and showing the
rest would present an edited schedule as the source's own, which is the same partial-data failure ADR
0003 refuses server-side.

#### Why `status: 0` and not a fabricated `200`

**Because the web layer does not know what the status
was.** `ApiResult`'s success branch is `{ ok: true, data }` — it retains no status, by design — so a
consumer that has been handed a successful result cannot tell whether the response was `200`, `201`,
`206`, or any other `response.ok` status. Writing `200` would be inventing a fact, and it would be
wrong outright for a `206`. Reconstructing or inferring the discarded status is equally out, and
**`ApiResult` is not widened to carry a status for the sake of one web-local invariant** — that is a
change to a shared public shape to serve a single consumer.

`0` is the convention this repository already uses for a failure no HTTP status describes:
`apps/extension/src/background/gateway.ts` states it as "no response existed, so there is no status
the server sent… stated as `0` rather than as a plausible-looking `500`, and never rendered to a
user", and `view-state.ts` and `use-schedule.ts` follow it. `InvalidResponseFailureSchema` types
`status` as `z.number().int()`, so `0` validates. **No second sentinel name is introduced for the
same meaning.**

`0` is **not an HTTP response status**, it is never shown to a person, and it never appears in product
copy — it exists so a log or a test can distinguish a locally raised failure from one a server
answered.

**Exactly identical repeated records are rejected by the same rule**, in all three catalogues. They
may look interchangeable, but a source that emitted one provider, one area, or one collection twice
is a source this client does not understand, and guessing that the duplication was harmless is
exactly the inference this project keeps out of scheduling data.

### Bounded capability/schedule reconciliation

This is the canonical reconciliation contract. The range in a collection-events request is derived
from a capability read earlier: its `timeZone` decides `sourceToday`, and its validity window clamps
the range. Between that read and the events request, the operator can change the capability or reject
the formerly valid range. Both races use **one shared budget**, not one retry each.

Every schedule attempt for the current `confirmedSelection` starts with:

```ts
reconciliationRemaining: 1 | 0
```

It begins as `1`. The attempt consumes it on whichever of these happens first:

1. the first accepted-shape collection-events response whose metadata disagrees with the capability
   used to build its request; or
2. the first exact range problem:

   ```ts
   failure.kind === 'problem'
   failure.operation === 'listCollectionEvents'
   failure.status === 422
   failure.code === 'SCHEDULE_RANGE_NOT_COVERED'
   ```

Those triggers do **not** receive separate retry budgets. A metadata mismatch followed by the exact
range problem, and the exact range problem followed by a metadata mismatch, both exhaust the same
single budget.

**Metadata comparison happens before anything is published.** After api-client success and before
domain mapping, invariant publication, sorting, rendering, or lifecycle scheduling, require exact
normalized equality:

| Response field | Compared against |
| --- | --- |
| `meta.source.timeZone` | the requesting capability's `timeZone` |
| `meta.validFrom` | the requesting capability's `validity.from` |
| `meta.validTo` | the requesting capability's `validity.to` |

An accepted-shape mismatch discards the complete response: no event and no provenance is published.
Its metadata is never promoted into a capability, because letting a response vouch for the request
range it answered would be circular.

**Exact first-422 or first-mismatch sequence.** While the attempt and `confirmedSelection` are still
current:

1. consume the budget, setting `reconciliationRemaining` to `0`;
2. make a fresh `listProviders` request;
3. verify that the confirmed provider still exists and remains official/non-demo. Missing or `demo`
   invalidates the confirmed selection and starts no further provider-specific request; a provider
   request failure remains a `listProviders` error;
4. make a fresh `listServiceAreas` request for that verified provider;
5. verify that the confirmed area still exists and remains `available`. Missing or unavailable
   invalidates the confirmed selection and starts no events retry; an area request failure remains a
   `listServiceAreas` error;
6. read the clock again, derive source-local today from the refreshed capability, and recompute and
   clamp the 90-day range;
7. if no range is requestable, issue no events request and enter `range_not_covered` through the
   local capability-derived path — **with no `triggeringRangeProblem`**, because the provisional 422
   that opened this sequence has been answered by the refreshed capability;
8. if a range is requestable, issue exactly one `listCollectionEvents` retry for that newly derived
   range;
9. before accepting the retry, apply every request identity, official-source, requested-range,
   coverage, response-wide identifier, timestamp, window-order, source-zone local-date, validity,
   and capability-consistency check required by this decision.

There is no second reconciliation. Newest-selection-wins remains authoritative at every await: a
cancelled or superseded stage publishes no error and starts no later request or lifecycle work.

Every request in this sequence retains `phase: 'schedule_pipeline'` and
`stage: 'reconciliation'`. Its `failure.operation` remains whichever transport call actually failed.
If the sequence fails, [`Erneut versuchen`](#erneut-versuchen-is-phase-aware-not-operation-routed)
starts a completely new schedule attempt from fresh providers with `stage: 'initial'` and a fresh
reconciliation budget of one; it never resumes this partially consumed sequence.

**Outcome of the one reconciled events retry:**

| Outcome | Result |
| --- | --- |
| Matching success after all acceptance checks | Apply [the final source-date gate](#the-final-source-date-gate-before-publication) against **this retry's** snapshot, with **all three** of its outcomes: on a match accept the schedule, start exactly one accepted-pair source-day watchdog, and run no range-recovery coordinator; on a mismatch publish nothing and restart immediately; on a **typed derivation failure** publish nothing and take the local schedule error, installing neither lifecycle owner |
| The exact range problem again | Enter `range_not_covered` with **`triggeringRangeProblem` set to that terminal validated problem**, retain `confirmedSelection`, render no schedule, start the range-recovery coordinator, and do not reconcile again |
| Metadata mismatch with the budget exhausted | `schedule_pipeline` / `reconciliation` context carrying `invalid_response` for `listCollectionEvents`, local/unknown `status: 0`, no `requestId`, no `range_not_covered` state, and no lifecycle timer |
| Another validated Problem Details response | `schedule_pipeline` / `reconciliation` error context with the real `listCollectionEvents` operation, `code`, `status`, and `requestId` |
| `network`, `timeout`, or `invalid_response` | The corresponding `schedule_pipeline` / `reconciliation` error context with its unchanged operation |
| `cancelled` or superseded | No rendered error and no side effect |

A first metadata mismatch whose retry returns the exact range problem therefore ends in
`range_not_covered`: the shared budget is already exhausted, so no second catalogue refresh occurs.
A first exact range problem whose retry mismatches metadata ends in local `invalid_response`, not in
`range_not_covered` and not in another reconciliation.

Reconciliation's fresh provider and capability reads are **one instance** of qualifying entry
evidence, not a special case: when reconciliation ends in `range_not_covered` — because the refreshed
capability yields no requestable range, or because the reconciled events retry returns the exact range
problem — the coordinator reuses those reads as its initial entry revalidation under
[the entry-evidence predicate](#entry-revalidation-is-decided-by-evidence-not-by-the-flows-name),
schedules the next deadline normally, and still allows a later `Erneut versuchen` action or lifecycle
signal to trigger an earlier coalesced attempt. The same reuse applies to every other flow that
satisfies the predicate.

### A timed event's date and zone must agree with its start instant

A `mobile_drop_off` carries three things that can contradict each other: `date`, `timing.startsAt`,
and `timing.timeZone`. Nothing in the contract cross-checks them. `date` is what every label is
computed from — "Heute", "Morgen", the sort key — while `startsAt` is the instant a person actually
has to be somewhere. When they disagree, the surface tells someone to attend on one day at a time
belonging to another, and both halves look perfectly ordinary on their own.

**Two checks, run after capability/schedule metadata consistency and before mapping, publication,
sorting, relative-date labels, window formatting, and rendering.**

**A. Zone consistency.** `event.timing.timeZone` must equal `response.meta.source.timeZone` — which
the earlier consistency check has already pinned to the authoritative capability zone. An event
declaring a different zone is describing an appointment in a zone the source did not publish under,
so there is no basis for choosing which to believe.

**B. Local-date consistency.** Derive the local `YYYY-MM-DD` of `timing.startsAt` **in the
authoritative source zone**, with `Intl.DateTimeFormat`/`formatToParts`, `gregory`, `latn` — the same
derivation used everywhere else — and require it to equal `event.date` exactly.

- **Not the UTC date substring.** `2026-03-20T23:30:00Z` is 20 March in UTC and **21 March** in
  Berlin; slicing the string would reject a correct event and accept a wrong one.
- **Not the device zone**, for the reason every other date in this application avoids it.
- **Nothing is silently rewritten** — not `event.date`, not `timing.timeZone`. A client that
  "corrects" municipal data has invented a schedule.

Either mismatch is an `invalid_response` for `listCollectionEvents` with `status: 0`, no partial
rendering, and no `requestId`, per the matrix above.

**The event's `date` is the local date on which its window *starts*.** A window may legitimately end
on a later source-local date — see
[cross-midnight rendering](#a-mobile-drop-off-window-is-formatted-in-the-source-zone) — and that does
not change `event.date` and is not a violation of this invariant.

### A drop-off window must not end before it starts, at any accepted precision

Both the transport and the domain already refuse an inverted window — and **both compare with
`Date.parse`**, which truncates below a millisecond. A window running from `…10:00:00.0002Z` to
`…10:00:00.0001Z` is inverted by a tenth of a millisecond, parses to two identical epoch
milliseconds, and passes `endsAt >= startsAt` in both schemas. It then reaches a surface that tells
somebody to arrive at a place inside a window that closed before it opened.

**The web application therefore validates window order itself, with the same full-precision
comparator it uses for ordering**, as a named application-boundary invariant. It runs immediately
after api-client success and **before** transport-to-domain mapping, before event-id uniqueness
publication, before sorting, before state publication, and before rendering.

- For every `mobile_drop_off` event, compare `startsAt` and `endsAt` with **the one documented
  full-precision comparator** — never `Date.parse`, never a second implementation.
- **`endsAt` equal to `startsAt` is accepted.** The existing contract forbids only "before", and a
  zero-length window is a thing a source can publish; the two validators must not disagree about
  whether it is representable.
- **`endsAt` earlier than `startsAt` at any accepted fractional precision** is an `invalid_response`
  for `listCollectionEvents` with `status: 0`, for the reasons in the matrix above.
- **No partial schedule renders**, no `requestId` is exposed, and **no timestamp, payload, or parsing
  detail** reaches the UI or a log — the offending value is untrusted input and is not product copy.

**The shared schemas are not changed in AR-005.** `TimeWindowTimingSchema` in
`packages/api-client` and its counterpart in `packages/domain` both keep their millisecond-level
refinement for this milestone, because correcting them changes a shared contract for every consumer —
the extension included — and that is a separate, coordinated follow-up with its own review. **The web
boundary must nevertheless be safe now**, which is exactly what a consumer-local invariant is for:
this milestone does not get to ship a known rendering hazard while waiting for a shared fix.

After the check passes, the `id` tie-breaker genuinely does produce a deterministic total order over
distinct events — which is why the check has to run first.

### The product slice starts at an explicit needs-selection state

**Automatic *discovery* is required; automatic *selection* is forbidden.** Those are different things
and conflating them produces either a dead first screen or a municipality nobody chose. The
application does fetch on load — it has to, or there is nothing to choose from — but it never decides
**which** municipality a person is asking about, and it never retrieves a schedule before they say so.

| Phase | Requested automatically | Never automatic |
| --- | --- | --- |
| **Bootstrap** | Validate the browser origin, construct the same-origin client, request the **provider catalogue** — exactly one request | Selecting a provider or municipality |
| **Provider selected** | That provider's **service areas** | Preselecting the first or the only provider; offering a `demo` provider at all |
| **Area selected** | Nothing — it changes only the **draft** selection | Preselecting the first or only area; requesting collection events |
| **Confirmed** | Capability → range → **collection events** | Confirming on the person's behalf |

- **The catalogue request selects nothing.** It populates a picker.
- **A single offered provider is still not preselected**, and neither is a single available area.
  "There is only one" is a fact about today's catalogue, not consent.
  **Amended** by [addendum 1](0005-addendum-1-city-first-selection.md): once the flow starts at a city,
  the city choice is the consent, and a city served by exactly one official provider resolves that
  provider instead of showing a step with a single answer. A single available **area** is still never
  preselected, and no city is ever chosen automatically.
- **Demo providers are filtered and cannot be selected.**
- **No service-area request before an offered provider has been explicitly selected**, verified
  against a successful catalogue — a stored or in-flight identifier is not evidence.
- **Unavailable areas stay visible and disabled**; selecting an available one changes only the draft.
- **Only explicit confirmation of an available provider/area pair starts the capability, range, and
  schedule lifecycle.** No collection-events request exists before it.
- **Changing the provider clears the draft area**, so an identifier is never carried across providers.
- **Reload returns to needs-selection**, because this milestone has no persistence.
  **Amended** by [addendum 2](0005-addendum-2-confirmed-selection-persistence.md): the confirmed city,
  provider and district are remembered in one versioned `localStorage` record, revalidated against the
  catalogue on the next run, and the schedule is fetched again. No schedule is stored, and an invalid
  record is cleared and ends at the step that has to be decided again.

### Navigation: `Zurück`, `Auswahl ändern`, and `Erneut versuchen`

Three actions were previously named only in the focus checks, with no destination and no state
transition defined. A control whose behaviour is undefined is a control nobody can test, so the
contract is stated here once and every other section defers to it.

#### Confirmed and draft selection are separate values

| Value | Meaning |
| --- | --- |
| `confirmedSelection` | The provider/area pair whose schedule pipeline is active, or whose accepted schedule is displayed |
| `draftSelection` | The provider/area values currently shown in the selection flow |

Both are `null` on first load. **Opening `Auswahl ändern` copies `confirmedSelection` into
`draftSelection`, so the current provider and area remain visible as the defaults** — a person
returning to change one of the two is not made to re-pick both. **Editing the draft never touches the
confirmed selection and never issues a collection-events request** — only explicit area confirmation
replaces `confirmedSelection` and starts a schedule attempt. **Changing the draft provider clears the draft area**, so a
service-area identifier is never carried across providers. A reload clears both, as already decided.

#### The selection flow has two steps, and `Zurück` moves between them

The **provider step** shows the successfully loaded offered catalogue; choosing an official provider
starts its service-area request; nothing is preselected on first load.

The **service-area step** keeps the chosen provider visible and renders the loading, failed,
successful-empty, available, and unavailable outcomes. Only an available area can be confirmed;
unavailable ones stay native-disabled and skipped by sequential keyboard navigation.

**A visible `Zurück` exists on the service-area loading, failure, empty, and list states.** It
supersedes and aborts the active service-area attempt, so a late completion is discarded by the
existing newest-attempt token; returns to the provider step; **retains the already loaded provider
catalogue** rather than refetching it; may retain the previous provider as a draft highlight but
**clears the draft area**; and **issues no collection-events request**. Changing the provider through
the flow follows the same supersession rules.

#### `Auswahl ändern` returns from a schedule to the selection flow

**Available on every post-confirmation schedule surface where a confirmed selection exists** —
`loading`, `live` (`fresh` and `upstream_stale`), `empty`, `range_not_covered` /
range-not-covered, and the schedule failure states.

Activating it **immediately supersedes and aborts** any provider-specific capability or
collection-events attempt so late replies cannot update state; **stops the accepted-pair source-day
watchdog or the range-recovery coordinator, whichever owns the current surface**; copies the confirmed
pair into `draftSelection`; opens the service-area step for that provider when its catalogue data is
still valid, otherwise restarts only the catalogue and service-area reads needed to reconstruct that
step; **hides the schedule while selection is being edited**; and **issues no collection-events
request until explicit confirmation**.

**Reconfirming the same available area runs a new authoritative pipeline** rather than silently
reusing the previous result. The person asked again; the honest answer is a fresh one.

**`configuration_error` carries no `Auswahl ändern`.** There is no trustworthy API origin there, so
there is nothing to select against.

#### `Erneut versuchen` is phase-aware, not operation-routed

This is the **one authoritative Retry table**. Every other Retry description links here. The
api-client's `failure.operation` remains the real failed transport operation — `listProviders`,
`listServiceAreas`, or `listCollectionEvents` — and is never rewritten or fabricated to fit product
state. Product Retry behavior comes from the request owner-assigned `phase`, not from that operation,
not from an endpoint name, and not merely from whether `confirmedSelection` is non-null.

`Selection` below is the web-owned provider/service-area pair type; it does not import the
extension's persisted selection type.

```ts
type FailureContext =
  | {
      phase: 'selection_providers';
      failure: ApiFailure;
    }
  | {
      phase: 'selection_areas';
      draftProviderId: string;
      failure: ApiFailure;
    }
  | {
      phase: 'schedule_pipeline';
      stage: 'initial' | 'reconciliation';
      confirmedSelection: Selection;
      /** Widened: this phase derives a source date, so it can fail locally. */
      failure: ScheduleFailure;
    }
  | {
      phase: 'range_recovery';
      confirmedSelection: Selection;
      /** Widened for the same reason; stays a nested diagnostic, never a top-level `error`. */
      failure: ScheduleFailure;
    };
```

The request owner assigns the context when an attempt starts and retains it through completion. A
confirmed pair can remain in memory while `Auswahl ändern` edits an unrelated draft, so its presence
cannot reconstruct phase after a failure.

| Failure phase | Context owned by that phase | Canonical `Erneut versuchen` transition |
| --- | --- | --- |
| `selection_providers` | Initial provider catalogue or refresh from `no_official_providers`; no schedule pipeline owns the request | Start only a new `listProviders` selection-flow attempt with a new selection-flow token; invent no provider selection and issue no area or events request |
| `selection_areas` | Areas for `draftSelection.providerId`, including initial area load, forward navigation, area refresh, and `no_service_areas`; no confirmed schedule attempt owns it | **Ordinary area failures and `no_service_areas`:** retain only `draftProviderId`; start only `listServiceAreas` for that draft provider with a new selection-flow token; confirm no area and issue no events request. **Exception — a current [`ProviderNotFoundProblem`](#an-invalidated-draft-provider-is-recovered-not-retried):** no area Retry is offered, because the provider no longer exists; the result-handling transition below has already cleared the draft and started one `selection_providers` catalogue refresh, whose own failure is retried under that row |
| `schedule_pipeline` | Work after explicit confirmation, including the initial authoritative pipeline and its bounded reconciliation; the real failed operation may be any of the three | Retain `confirmedSelection`; abort and supersede the old schedule attempt; create a new schedule token and `AbortController`; reset `reconciliationRemaining` to `1`; restart fresh `listProviders` → fresh `listServiceAreas` → new clock read → source-local today → newly clamped range → conditional collection events → every acceptance check → [the final source-date gate](#the-final-source-date-gate-before-publication); install a lifecycle owner only after the relevant accepted state |
| `range_recovery` | A confirmed selection remains in `range_not_covered`; any fresh provider, area/capability, or recovered-events request owned by the coordinator failed | Keep `range_not_covered` and `confirmedSelection`; coalesce with or supersede active recovery; create a new recovery token and `AbortController`; immediately restart fresh `listProviders` → fresh `listServiceAreas` → new source-local today and range → conditional events; remain uncovered if necessary and accept a schedule only after a matching pair passes the final source-date gate; reset the next 15-minute deadline after settlement |

The schedule rule applies even when its reported operation is `listProviders` or `listServiceAreas`:
Retry never resumes only that endpoint. Likewise, a range-recovery `listProviders` or
`listServiceAreas` failure does not become a selection-flow failure. A second failed Retry remains
retryable in the same owning phase.

**Reconciliation interaction.** A failure during first-422 or metadata-mismatch reconciliation has
`phase: 'schedule_pipeline'`, `stage: 'reconciliation'`, and its real failed operation. Retry does not
continue the partially consumed reconciliation. It supersedes the old attempt and begins a new
authoritative schedule attempt at fresh providers with a fresh budget of one. Provisional capability,
range, and partial reconciliation state are discarded. Because this is a new user-requested attempt,
it may itself reconcile once; late results from the old attempt remain inert.

**Phase ownership and supersession.** Selection-flow attempts cannot update schedule-pipeline state;
schedule attempts cannot update draft-selection state; range-recovery attempts cannot repaint after
`Auswahl ändern` or confirmation of another pair. Changing phase supersedes the previous phase's
token, aborts its controller, and clears its stale failure context. Changing the confirmed pair,
changing the draft provider, and unmounting apply the same rule to their respective owners. A late
failure cannot replace the current phase's state or actions.

The successful-empty states use the same table: `no_official_providers` starts a
`selection_providers` refresh, while `no_service_areas` starts a `selection_areas` retry for its draft
provider plus retaining `Zurück`.

#### An invalidated draft provider is recovered, not retried

The catalogue can change between `listProviders` and `listServiceAreas`. When it does, the areas
route tells the application so precisely, and a generic area Retry would be wrong: it would call the
same missing provider again, fail again, and loop.

**The discriminator is read from the contract, not inferred.** `apps/api/src/routes/v1/providers.ts`
declares `404: ProviderNotFoundProblemSchema` on `GET /v1/providers/{providerId}/service-areas` and
throws `ApiProblem.providerNotFound()` when `findProviderEntry` returns nothing;
`apps/api/src/http/problem-details.ts` defines `PROVIDER_NOT_FOUND` with `status: 404`; and the client
reports it as the exported `ProblemFailure`. The narrowing mirrors `ExactRangeProblem` — **not** a new
transport type:

```ts
/** A narrowing of the exported `ProblemFailure`, not a new interface. */
type ProviderNotFoundProblem = ProblemFailure & {
  readonly operation: 'listServiceAreas';
  readonly status: 404;
  readonly code: 'PROVIDER_NOT_FOUND';
};
```

**All four fields must match.** A `404` without that code, a `problem` with that code on another
operation, `invalid_response`, `network`, `timeout`, and any server `detail` text are **not** this
signal, and keep the ordinary area-failure behaviour.

**Ownership is checked before any effect.** Only a completion whose attempt token and
`selection_areas` phase owner are still current may act. A stale completion — after `Zurück`, a
draft-provider change, or unmount — does nothing.

For a current match, one transition runs:

1. **invalidate the loaded catalogue as selection evidence** — it named a provider that no longer
   exists, so it can no longer be offered;
2. **clear** `draftSelection.providerId`, the draft area, and the obsolete area data;
3. **supersede** the area attempt;
4. **return to the provider step** and start **exactly one** fresh `listProviders` attempt, owned by
   **`selection_providers`** with a new selection-flow token.

**The failed request keeps its truth.** It remains a `selection_areas` failure of
`listServiceAreas` with its real status, code, and `requestId`; starting the provider request does
not rewrite its phase or transport metadata. The surface shows application-owned German recovery
copy rather than the generic area error, and focus moves to the **provider step heading**, because
the control that named the old provider is gone.

**The refresh never selects on the person's behalf.** After successful catalogue validation and demo
filtering the refreshed choices are shown **with nothing selected** — even when the same provider id
reappears, areas are not requested again until the person chooses it. That is what breaks the
automatic *areas → failure → providers → areas* loop. An empty or all-demo refresh yields
`no_official_providers`; a failed refresh is an ordinary `selection_providers` failure carrying its
real `listProviders` operation and is retried under that row. **No outcome confirms an area or
requests events.**

**The confirmed-versus-draft contract holds.** If this happens during `Auswahl ändern`, a retained
confirmed pair stays inactive, and no schedule or lifecycle owner resumes without explicit
reconfirmation. `Zurück` from the area step still retains a **still-valid** catalogue, but an
**invalidated** catalogue is never made selectable again through it.

#### Focus destinations

| Transition | Focus moves to |
| --- | --- |
| Entering the service-area step | its heading, or the first appropriate control |
| `Zurück` | the provider choice that opened the area step |
| Draft provider invalidated by `PROVIDER_NOT_FOUND` | the **provider step heading** — the provider choice that opened the area step no longer exists, so it cannot be the target |
| `Auswahl ändern` | the selection heading, or the current-area control |
| `Erneut versuchen`, while pending | stays on the retry action, unless the whole surface is replaced |
| Successful confirmation | the schedule or loading main heading |

**A successful async replacement must never leave focus on an unmounted element or fall back to
`document.body`.** All three actions have accessible names, visible focus, and meet the 44 by 44 CSS
pixel target where the design rules require it. **Focus is never moved onto a native-disabled
unavailable area.**

**An unavailable area of an offered provider stays visible, explained, and inert.** Its capability
says the source publishes no calendar for it, which is a statement about the source rather than about
whether the municipality serves the area — so hiding it would make a different and unfounded claim.

Its unselectability is expressed with **native `disabled` semantics** on a native control:

- it is **skipped by sequential `Tab` navigation**, because a disabled native control is not a tab
  stop. Keyboard users therefore move directly from the previous operable control to the next one and
  never land on something they cannot act on;
- it **exposes its disabled state to assistive technology** through the accessibility tree, not
  through appearance;
- **click, Enter, and Space cannot select or confirm it**, because a disabled control dispatches no
  activation at all;
- its **explanatory German text stays visible** and associated with the area, so a person learns why
  it cannot be chosen rather than finding an inert row with no reason attached.

A focusable pseudo-disabled control, or `aria-disabled` alone on a still-operable element, is
rejected: both put a person on a control that announces itself as unavailable while remaining
reachable, and both leave the activation path open for a defect to walk through later.

**Every one of these behaviours is proven by deterministic tests over a fixture**, because the live
catalogue exposes no unavailable area. A live check is conditional on one actually appearing, and its
absence does not block acceptance — see
[Verification scope](#verification-scope-what-jsdom-proves-and-what-it-cannot).

### Selection is session-only, and reloading returns to needs-selection

> **Superseded** by [addendum 2](0005-addendum-2-confirmed-selection-persistence.md) (2026-09-18): the
> confirmed city, provider and district are now remembered in one versioned `localStorage` record and
> revalidated on the next run. The decision below is retained as the record of the first slice — what
> was true then, and the cost that was accepted with it.

For this milestone the confirmed selection lives in React state and nowhere else. No `localStorage`,
no `IndexedDB`, no cookie, no server persistence, no account, and no migration logic.

**Reloading the page therefore returns to the needs-selection state.** This is a real cost and it is
recorded as one rather than described as a design intent: a person who reloads has to choose again.
It is accepted for this slice because every persistence option carries a decision this milestone is
not ready to make well — where the value lives, what happens when the stored area is later withdrawn,
whether it should be shareable, and what the migration story is when the shape changes. ADR 0004
needed a versioned schema, a migration table, and a single-owner repository to make the extension's
persisted selection safe. Adding a weaker version of that here to save one interaction would be the
wrong trade, and inventing a second persistence model that the eventual one has to migrate away from
is worse than having none.

### Newest-selection-wins uses cancellation and an attempt token together

- Each attempt carries a monotonically increasing token, and a reply whose token is not the latest is
  discarded. This is what makes the *state* correct.
- Each attempt also carries an `AbortSignal` that is aborted when it is superseded. This is what
  makes the *request* stop, and it is available here in a way it was not to the extension popup,
  because `runtime.sendMessage` offers the sender no cancellation while `fetch` does.
- **Both, not either.** The signal alone leaves a race — a response can already be resolved when the
  abort lands — and the token alone leaves a request running that nobody will read.
- **A cancellation caused by a newer selection is not an error state**, and it must not clear a
  schedule the newer selection is about to replace.
- **This is proven by deterministic tests over injected fixtures**, because the live catalogue offers
  one provider and one area and therefore cannot be switched at all. See
  [Verification scope](#verification-scope-what-jsdom-proves-and-what-it-cannot).

**Ownership is checked before content, and a failed ownership check is not an error.** The guards —
attempt token, phase owner, captured confirmed pair, and cancellation — run **before** any processing
that could consume reconciliation budget, issue another request, publish a failure, or install a
lifecycle owner. A completion that fails them is discarded: it publishes nothing, announces nothing,
and installs nothing. It does not become a rendered `error`, and it does not push the surface back to
a selection state.

**Evaluating a current action and handling a stale completion are different questions**, and
conflating them is how a surface ends up telling someone to choose again because of a reply that
arrived late. A *current action* that cannot start a confirmed-selection pipeline for want of a
confirmed selection legitimately transitions to `needs_selection`. A *late completion* whose selection
was cleared, replaced, or whose phase changed is simply dropped; the newer action's state stands.

**Being current is not the same as being valid.** A response that still belongs to the current attempt
but carries invalid identity or payload data is handled by the ordinary validation and failure rules —
it is never quietly relabelled "superseded" to avoid rendering its failure. Conversely, ordinary
cancellation cleanup stays inside the existing ownership rules and must not clear a successor's
controller, pending work, diagnostics, or lifecycle owner.

Only a completion that passes ownership reaches classification, where the two `range_not_covered`
entry paths, the validation rules, and the phase-aware failure contract decide the outcome. AR-005's
[`range_not_covered` classification](../tasks/AR-005-responsive-web-schedule.md#4b-range_not_covered-classification)
holds the case-by-case table.

### The page revalidates when the source-local calendar date changes

A first `sourceToday` is derived when a capability arrives — and a web page can stay open for days.
Without a lifecycle it stays anchored to the date it was opened on: after midnight in the source zone
the page
still labels yesterday's collection "Heute", still requests a range starting yesterday, and still
presents a 90-day window whose newly advanced tail it holds no data for. The extension never had this
problem because a popup is destroyed when it closes; a document is not.

**`sourceToday` is therefore a value with a lifetime, not a constant.**

#### The source-day lifecycle

1. Once an available capability supplies `timeZone` **and the page has a confirmed selection**,
   derive `sourceToday` from the **injected clock** in that zone. That capability is **provisional**:
   it is enough to build a request with, and **not** enough to own a watchdog.
2. Fetch collection events and run every acceptance check — identity, range, official source,
   timestamps, validity, and capability consistency — then
   [the final source-date gate](#the-final-source-date-gate-before-publication), which re-reads the
   clock and refuses a candidate whose source day has moved since its request was built. **Only a
   published schedule/capability pair starts the watchdog**; see
   [what owns the watchdog](#a-watchdog-is-owned-by-an-accepted-schedulecapability-pair).
3. On every check, **derive the date again from the actual current clock** — never by adding one day
   to the previous value. A throttled timer can fire late, and a machine can sleep across several
   dates.
4. If the derived date equals the last authoritative `sourceToday`: **no network refresh and no published view-state change; while visible and still owned by the current accepted pair, ensure exactly one pending watchdog timeout**. An existing pending
   timeout is not duplicated; a hidden, stale, disposed, superseded, or failed owner arms nothing.
5. If it **differs in either direction**: **supersede and abort the current attempt**, **clear any
   schedule that would otherwise be presented as current**, and start a new
   `phase: 'schedule_pipeline'`, `stage: 'initial'` attempt with its own token, controller, and shared
   reconciliation budget. Rerun the authoritative pipeline — selected provider → selected area
   capability → target range → collection events.
6. **Recompute the 90-day range from the new `sourceToday` before requesting events.**
7. **Continue watching only under the capability that matches the accepted schedule**, because the
   operator may have changed the zone.

Four rules govern what the person sees while that runs:

- **Once a date change is observed, yesterday's event is not left labelled "Heute" while the refresh
  is in flight.** The stale schedule and its relative labels are cleared **at that observation**, not
  when the replacement arrives. A wrong label held for the duration of a request is still a wrong
  label, and "Heute" is the one word on this surface that makes somebody act today. Before the
  observation — while a callback is delayed — the previous labels may still be on screen; see
  [what the watchdog guarantees](#what-the-watchdog-does-and-does-not-guarantee).
- **No coverage is claimed for the newly advanced tail until the new response succeeds.** The window
  moved; the data has not yet.
- **The confirmed selection survives** in memory. The date changed, not the person's choice, and
  making them choose again at midnight would be absurd.
- **If the new range falls outside the declared validity window, no collection-events request is
  issued** and the no-calendar-for-this-period state renders — the same rule as at first load, which
  matters most on 31 December.

Cancellation is total: **selection change, `timeZone` change, configuration failure, and unmount** all
cancel the current watchdog and every lifecycle listener, and **a superseded date-change refresh
cannot publish state** — it goes through the same attempt token and `AbortSignal` as any other
attempt.

#### Observe the source date; do not predict the transition

The obvious design is to compute *when* the next boundary falls and set a timer for it. Every version
of that is wrong, and the last one was wrong in a way worth recording.

Arithmetic is wrong because a local day is not a fixed length: 23 or 25 hours across a DST
transition, and longer still when a zone changes its standard offset. **Searching for the boundary is
wrong for a subtler reason: the predicate `formattedDate !== sourceToday` is not monotonic**, and a
binary search requires monotonicity. `America/Creston` shifted from `GMT−06:00` to `GMT−07:00` at
`1944-01-01T06:01:00Z`, un-crossing midnight and repeating the previous date:

| Instant | Source date |
| --- | --- |
| `1944-01-01T05:30:00Z` | `1943-12-31` |
| `1944-01-01T06:00:00Z` | `1944-01-01` |
| `1944-01-01T06:01:00Z` | **`1943-12-31`** — backwards |
| `1944-01-01T07:00:00Z` | `1944-01-01` |

Verified against this runtime's ICU. A bisection over that interval can converge on an instant that
is not the transition, or miss the change entirely; there is no "earliest changed millisecond" to
find, because the date changes more than once and in both directions.

**So the application observes the source date rather than predicting it.**

#### The final source-date gate before publication

Every check above runs on a response that arrived **after** its request was built, and a request can
outlive source midnight. The range was clamped from a `sourceToday` that is no longer today, so a
candidate can satisfy identity, range, official-source, event, timestamp, and capability-consistency
checks and **still describe yesterday**. Publishing it would put yesterday's collection under "Heute"
until the watchdog's next tick noticed — and the watchdog is deliberately not a hard-real-time
mechanism, so "next tick" can be a second or a suspended tab away.

**The watchdog is not the fix.** It remains responsible for date changes **after** a valid
acceptance. This gate closes the in-flight response race, which the watchdog structurally cannot see.

**Each concrete `listCollectionEvents` request retains the `sourceToday` it was derived from**,
alongside its existing identity, requested range, and capability/time-zone context. The snapshot
belongs to **that request**, not to the attempt:

| Request | Snapshot |
| --- | --- |
| Initial | the `sourceToday` derived when that request was built |
| Reconciled retry | the **newly derived** `sourceToday` from the refreshed capability and the reconciliation's own clock read — **never** the original attempt's earlier date |
| Recovered | the `sourceToday` derived by **that recovery cycle** |

**The canonical acceptance sequence.** Every otherwise-valid candidate passes through it — initial
success, matching success after bounded reconciliation, matching success during range recovery, and a
successful response carrying **zero events**:

1. complete the existing parsing and validation — identity, requested range, official-source, event,
   timestamp, and capability/schedule consistency;
2. verify the request token, phase owner, and confirmed selection are still current;
3. **read the injected clock again**;
4. derive the current source-local date using the **validated matching capability's** time zone.
   **This call has three outcomes, and all three are handled here** — the gate is total, and no
   section that refers back to it may restate a two-outcome version;
5. if derivation returned its **typed failure**, stop: publish nothing and take the
   `source_date_unavailable` transition in
   [AR-005 step 3c](../tasks/AR-005-responsive-web-schedule.md#3c-source-date-derivation-failure-at-every-checkpoint).
   A **schedule-owned** failure becomes the local schedule error while the confirmed pair is retained
   and **neither** an accepted-pair watchdog **nor a new** recovery coordinator is installed; a
   **recovery-owned** failure stays nested inside the existing `range_not_covered` episode,
   **retaining the same coordinator**, `Erneut versuchen`, and periodic recovery. "Install no new
   coordinator" never licenses disposing of an existing one: shared cleanup must not clear a recovery
   owner that has just failed its own gate. Neither path installs a watchdog for the rejected
   candidate, and the comparison in step 6 is never reached;
6. otherwise compare the derived date with **this request's** snapshot;
7. if they **differ**, do not publish — supersede and restart, below. Recovery keeps its coordinator
   ownership and its range episode;
8. if they **match**, publish the accepted pair together with its checked `sourceToday`, then install
   exactly the documented accepted-pair watchdog.

**The local failure is not a changed date and not an uncovered range.** It fabricates no transport
operation, HTTP status, or `requestId`; it consumes **no** reconciliation budget; it establishes
**no** absence of a requestable range; and it never triggers the changed-date restart of step 7.

A **successful response carrying zero events** is unchanged by all of this: it is an otherwise-valid
candidate, it passes through the same gate, and on an equal date it publishes as the documented empty
state.

Steps 2 through 8 are **one synchronous decision path with no intervening `await`.** No `await` may
occur between the final successful comparison and publication. A clock read
placed only before an awaited body read, parse step, or other asynchronous work re-opens the race it
exists to close.

The comparison is **inequality**, not "current date is later" — a backward source-date change is
still a change, per the non-monotonic zones the watchdog already handles. It is **not** a comparison
of range bounds: clamping against a validity window can leave `from`/`to` identical across two source
days, so equal bounds prove nothing. The zone is never silently changed to make the check pass;
metadata-mismatch handling and bounded reconciliation still apply **before** a candidate reaches this
gate.

Clock reads and restart side effects live in the request owner, **never inside a reducer or React
state-updater function**, which must stay pure.

**A date-mismatched candidate never** enters accepted schedule state even temporarily, renders
yesterday as "Heute", is relabelled with today while keeping the old requested range, installs an
accepted-pair watchdog, or manufactures an API error, cancellation message, or `requestId`.

While the owner and confirmed selection remain current, the mismatch **supersedes the obsolete
attempt, retains the confirmed provider/area, discards the candidate, and starts exactly one
immediate replacement pipeline** through the existing request-owner and coalescing mechanism — **not**
at the next watchdog tick, 15-minute recovery deadline, focus, or visibility event. The replacement
runs the established authoritative sequence: fresh `listProviders` → validate the confirmed provider →
fresh `listServiceAreas` → validate the confirmed area and capability → new clock read and
source-local today → newly derived and clamped range → `listCollectionEvents` only if requestable →
normal validation → this same gate. It reuses the existing web gateway, `cache: 'no-store'` included,
and provider/area invalidation and request failures during it follow the established rules.

**This is not another bounded reconciliation cycle.** The old attempt ends; a genuinely new schedule
attempt receives the normal single shared budget. The budget is never reset or enlarged inside the old
attempt.

Phase ownership is preserved. Initial and reconciled work restarts under `phase: 'schedule_pipeline'`.
Recovery work stays owned by the existing range-recovery coordinator: **a stale recovered candidate
does not temporarily leave `range_not_covered`**, recovery diagnostics keep their episode and attempt
lifetimes rather than being cleared as though a schedule had been accepted, and **no second
coordinator is created**. The finishing attempt's cleanup must not clear the replacement's controller,
ownership, or pending work — otherwise the restart is lost to the very teardown that scheduled it. A
concurrent Retry, timer, or lifecycle signal asking for the same refresh **coalesces** under the
existing rules so exactly one replacement proceeds, and a selection or phase change or unmount
supersedes the restart too: an obsolete completion never restarts work for an old confirmed pair.

#### A watchdog is owned by an accepted schedule/capability pair

**A provisional capability does not own or start a watchdog.** A capability that has been fetched but
not yet corroborated by a matching schedule is a hypothesis: the operator may have changed the zone
between the two requests, which is exactly the race
[the reconciliation contract](#bounded-capabilityschedule-reconciliation)
exists for. A watchdog started from it would derive dates in a zone the accepted schedule never
confirmed, and would keep doing so.

The rule, stated once:

- provider and area selection, and a **successful capability on its own**, start **nothing**;
- fetch collection events and perform all identity, range, official-source, timestamp, validity, and
  capability-consistency checks;
- when the first metadata mismatch or exact range problem consumes the shared budget, run
  [the bounded reconciliation](#bounded-capabilityschedule-reconciliation);
- **start — or replace — the watchdog only once a matching schedule/capability pair has passed
  [the final source-date gate](#the-final-source-date-gate-before-publication) and been published**;
- if reconciliation or schedule loading fails, render the appropriate state and **leave no watchdog
  running**;
- the watchdog uses **the accepted schedule's matching source-zone metadata**, never a provisional
  capability's.

**Cancellation:** selection change, the selection becoming unavailable or being removed, unmount, and
**replacement by another accepted pair** each cancel the previous watchdog. Exactly one runs per
accepted pair, and none runs when no pair has been accepted.

#### `range_not_covered` needs its own lifecycle, or a confirmed selection is stranded

The rule above is correct and it leaves a hole. When a confirmed selection reaches
`range_not_covered` there is **no accepted pair**, so no watchdog runs — and nothing else is watching
either. The operator publishes next year's calendar, and the page never finds out. On 31 December a
person who confirmed an area in March sits on "no calendar for this period" **until they reload**,
which is not a recovery path anybody would design on purpose.

So `range_not_covered` gets its own mechanism, deliberately **not** a watchdog:

**The `range-recovery coordinator` is owned by `confirmedSelection`. It is not an accepted-schedule
watchdog, and it never authorizes rendering a schedule or a relative-date label.** Its only job is to
ask whether a requestable range exists yet. Naming it separately is the point: the accepted-pair
watchdog's authority comes from a validated matching pair, and this mechanism has no such pair to
draw authority from.

**Entering `range_not_covered`.** A confirmed selection reaches it when source-local today has moved
past `validity.to`, the clamped range inverts, the current capability declares no covered period, or
[bounded reconciliation](#bounded-capabilityschedule-reconciliation) ends in either documented
range outcome. On entry the application:

- **removes the previously accepted schedule and its relative-date labels *before* presenting the
  state** — a stale "Heute" must not survive into a state that says nothing is covered;
- **stops the accepted-pair source-day watchdog**;
- **retains `confirmedSelection`.** The validity window ended; the person's choice did not, and
  clearing it would make them re-pick an area that is still perfectly valid;
- retains the latest validated capability **only as last-observed metadata**, never as authority to
  render a schedule or build a request;
- enters the explicit `range_not_covered` state;
- **starts the range-recovery coordinator.**

#### The range-recovery coordinator's polling policy

`RANGE_RECOVERY_INTERVAL_MS = 15 * 60 * 1000`.

**Fifteen minutes is an AR-005 product and network trade-off, not an API contract.** A municipal
validity window changes at most once a year; polling faster would spend a person's connection on a
question whose answer changes annually, and polling slower would leave a stale surface up for an
afternoon. Nothing in the HTTP contract prescribes it, and a later milestone may revise it freely.

While `range_not_covered` and `confirmedSelection` both hold, the coordinator:

- on entry, either **reuses** a completed authoritative revalidation or runs **one immediate full
  recovery cycle**, decided by
  [the entry-evidence predicate](#entry-revalidation-is-decided-by-evidence-not-by-the-flows-name)
  below — never by which flow produced the entry;
- while the document is **visible**, schedules the next revalidation **after the previous attempt
  settles**, recursively. **Never `setInterval`**, and **never two identical attempts in flight**;
- **pauses its timer while the document is hidden**;
- revalidates **immediately** on `visibilitychange` to visible, `pageshow`, and window focus,
  **coalescing** concurrent signals into one attempt;
- exposes the existing **`Erneut versuchen`** action for an immediate user-requested attempt;
- **resets the next periodic deadline** after any manual or lifecycle-triggered attempt, so a person
  who just retried is not polled again a second later;
- uses an `AbortController` and a **monotonically increasing attempt token**;
- **aborts and supersedes** its work on selection change, `Auswahl ändern`, successful recovery,
  unmount, or configuration failure;
- **discards every late completion.**

Each request is assigned `phase: 'range_recovery'` when the coordinator starts it. Manual Retry,
timer, focus, `pageshow`, and visibility signals all enter the same coalescing gate: at most one
recovery cycle owns the current token and controller. Manual Retry follows
[the canonical phase table](#erneut-versuchen-is-phase-aware-not-operation-routed), starts at fresh
`listProviders`, and resets the next periodic deadline only after that complete attempt settles.

**Browser scheduling is outside the application's control.** Recovery happens on the **next delivered
timer callback or lifecycle signal**, not at a hard real-time deadline, and the application makes no
15-minute punctuality guarantee.

#### Entry revalidation is decided by evidence, not by the flow's name

Recovery exists to answer one question: *does the confirmed pair's declared validity still exclude
today?* Whenever the flow that produced the `range_not_covered` entry has **already answered it with
authoritative reads**, repeating those reads immediately is duplicated traffic and a second answer to
a question nobody asked twice. The earlier rule granted that reuse to **bounded reconciliation by
name**, which is the wrong discriminator: the initial authoritative pipeline, a user-requested
restart, and a source-date replacement pipeline all perform the identical reads and were still made to
redo them.

**The rule is a predicate over completed work, not over which flow ran.** Entry evidence qualifies
only when **all** of the following hold:

1. the required fresh `listProviders` read **completed successfully**;
2. the confirmed provider was validated as **existing, official, and non-demo**;
3. fresh `listServiceAreas` **completed successfully** for that provider;
4. the confirmed area was validated as **belonging to that provider and still available**;
5. its capability **passed the existing validation**;
6. the results belong to the **current entry-producing request flow and the current confirmed pair**;
7. the results were **not invalidated** by unrelated supersession or a selection change before
   handoff.

An intervening collection-events retry does **not** disqualify the evidence — a retry answers a
different question, and the existing rule for reconciliation followed by a terminal exact range
problem stands unchanged.

**"Fresh" means the required authoritative API reads through the web gateway newly completed in that
flow.** It says nothing about the server's own official-source cache, which this application neither
observes nor controls. No TTL, client cache, or new periodic mechanism is introduced: the evidence is
either produced by the flow now handing over, or it does not exist.

**A fresh area-only read for a draft selection does not qualify.** It proves nothing about the
confirmed provider's continued officialness, and the predicate requires the complete pair.

**Eligibility is never inferred** from a non-null `confirmedSelection`, from retained catalogue
objects, or from the word "reconciliation". The evidence travels in the existing entry-producing
request context, extended with only the minimal internal handoff information the predicate needs; it
is not a new public state, failure kind, or diagnostic.

**With qualifying evidence**, the coordinator counts that completed validation as its initial entry
revalidation, issues **no** immediate `listProviders` or `listServiceAreas`, is established exactly
**once**, and schedules its next periodic attempt by the existing 15-minute settle-based rule — the
entry-producing flow's completion **is** the reused initial cycle's completion. Retry, focus,
visibility, and periodic triggers remain available under the existing coalescing rules.

**Without qualifying evidence** — a legitimate entry resting only on retained or stale metadata — the
coordinator runs **one immediate full cycle**: fresh providers → provider validation → fresh service
areas → area/capability validation → current source-local date and range → collection events **only
when requestable**, then the ordinary outcomes and scheduling above.

**The handoff is a legitimate ownership transfer, not an invalidation.** The entry-producing phase is
validated as current *before* the transfer, and the evidence survives it; afterwards, that phase's
own cleanup must not clear the new coordinator's ownership. Conversely, evidence arriving from a
**superseded** producer creates no entry, hands nothing over, and suppresses none of the current
owner's required work.

**Reuse suppresses only the duplicate initial cycle.** Later recovery attempts still perform
authoritative reads. Signals already coalesced into the completing flow are **not** replayed as a
second entry cycle, while genuinely later eligible signals stay actionable. And an **already active**
coordinator that completes fresh validation and remains uncovered simply keeps that coordinator and
schedules its next attempt — that is an ordinary attempt, not a new entry.

Absence of evidence never *creates* an entry: an unrelated schedule-pipeline failure or an invalidated
selection keeps its existing transition.

#### Recovery outcomes

A recovery attempt starts with **fresh `listProviders`, then fresh `listServiceAreas`**, rereads the
clock, derives source-local today, and reclamps the range for the confirmed provider and area. It
**never constructs a collection-events request from the expired capability snapshot** — that
snapshot is what said the range was uncovered.

| Fresh capability says | Action |
| --- | --- |
| Provider removed, no longer official, or filtered as `demo` | Invalidate `confirmedSelection`, stop the coordinator, return to the appropriate selection/catalogue state, **no** collection-events request |
| Service area removed | Invalidate the selection, stop the coordinator, return to selection, **no** collection-events request |
| Area now `unavailable` | Invalidate the selection, stop the coordinator, show needs-selection with the documented explanation, **no** collection-events request |
| Area available, fresh validity **still** yields no requestable range | **Stay** in `range_not_covered`, render no schedule, schedule the next attempt |
| Fresh capability yields a **requestable range** | Run the complete current capability → range → collection-events → cross-field and metadata-consistency pipeline |

On a **requestable range**, no schedule is shown until a matching response passes
[the final source-date gate](#the-final-source-date-gate-before-publication) against **that recovery
cycle's** snapshot, in **all three** of its outcomes. A mismatched candidate stays unpublished, the
episode remains `range_not_covered`, and the **same single coordinator** starts one immediate
replacement cycle. A **typed derivation failure** likewise publishes nothing, keeps the episode and
**that same coordinator**, and records the local failure as the nested `lastRecoveryFailure` while
`Erneut versuchen` and the periodic deadline stay available. On acceptance, **stop the coordinator and
start exactly one accepted-pair source-day watchdog**.

**A failed recovery attempt never fabricates coverage or strands the confirmed pair.** A transient
`network`, `timeout`, `problem`, or `invalid_response` from providers, areas, recovered events, or a
recovery-owned local consistency check retains `range_not_covered`, `confirmedSelection`, and the
coordinator. Store the truthful `phase: 'range_recovery'` context and unchanged real transport
operation as nested `lastRecoveryFailure`; announce the failed refresh through the existing live
region; keep `Erneut versuchen` available; and keep the next periodic attempt scheduled after the
failed attempt settles. Show a support `requestId` **only** for a validated `problem` failure. Never
replace the range state with an unrelated selection or schedule error, and never start a duplicate
concurrent request.

Provider absence, non-official/demo reclassification, area absence, and area unavailability are
authoritative catalogue outcomes, **not transient request failures**. They follow the invalidation
rows above: clear `confirmedSelection`, stop recovery, return to selection, clear the obsolete
`lastRecoveryFailure`, and offer no Retry for the obsolete pair.

#### Exactly one mechanism owns scheduled work

**At most one of the accepted-pair source-day watchdog and the range-recovery coordinator may own
scheduled work for a confirmed selection. They never run concurrently.**

| Transition | Result |
| --- | --- |
| Accepted schedule | accepted-pair watchdog |
| Range becomes uncovered | **stop** watchdog → range-recovery coordinator |
| New matching schedule accepted | **stop** coordinator → accepted-pair watchdog |
| Selection editing, clearing, or unmount | **stop both** |

**Provider and service-area selection loading owns neither.** Two timers running against one confirmed
selection would issue overlapping capability reads and race each other to publish, which is the class
of defect the attempt token exists to catch rather than to tolerate.

One cancellable **source-date watchdog** therefore runs per **accepted schedule/capability pair**:

- while the document is **visible**, a **recursive `setTimeout`** — never overlapping `setInterval`
  callbacks — **requests** a source-date check every `SOURCE_DATE_WATCH_INTERVAL_MS`, a named
  constant of `1000`. Requesting is not the same as running: whether the callback is delivered on
  time is the browser's decision, not this application's;
- each check derives `YYYY-MM-DD` from the **current injected clock** through the existing
  `Intl.DateTimeFormat`/`formatToParts` source-zone formatter. It **never increments the previous
  date and never predicts a transition**;
- if the derived date differs from the last authoritative `sourceToday` **in either direction**, it
  supersedes the current attempt and starts a new `phase: 'schedule_pipeline'`, `stage: 'initial'`
  attempt with a new token, controller, and shared reconciliation budget, then reruns the
  authoritative pipeline: provider → area capability → range → collection events. Forward changes,
  backward changes, and repeated dates are all handled by the same comparison, because it is an
  inequality rather than an ordering;
- a **same-date** check — from polling, visibility return, `pageshow`, or focus — performs
  **no network refresh and no published view-state change; while visible and still owned by the current accepted pair, ensure exactly one pending watchdog timeout**. An existing pending timeout is not duplicated, and a hidden, stale, disposed, superseded,
  or failed owner arms nothing;
- **exactly one watchdog exists for the current accepted schedule/capability pair, and at most one
  exists for the current confirmed selection.**

Cancellation is total: **selection change, `timeZone` change, configuration failure, and unmount** all
cancel the current watchdog. When the document becomes **hidden**, the polling timer is suspended, so
a backgrounded tab is not spending a tick a second on a question nobody is looking at the answer to.

Recovery covers everything the timer cannot: on **`visibilitychange` to visible**, on **`pageshow`**,
and on **window focus**, the current source date is derived immediately and put through the same
change check. After throttling or machine sleep the next callback derives the actual current date
directly, so any number of elapsed dates is handled by one comparison. **A timer callback and a
lifecycle event arriving together coalesce into one refresh**, and a superseded watchdog or response
cannot publish state.

**Suspending on hide creates an obligation to rearm.** Cancelling the pending timeout and then
finding the date *unchanged* on return would leave the accepted pair watching nothing, so the next
source midnight would pass unobserved until some unrelated signal happened to arrive. The
visibility-return branch therefore checks ownership first — a stale, cancelled, or disposed owner arms
nothing — then derives the date and takes one of three paths: **unchanged** performs no network
refresh and no published view-state change and, while visible and still owned by the current accepted
pair, **ensures exactly one** pending timeout at the same interval — never a duplicate;
**changed** runs the authoritative refresh, and the superseded watchdog does not rearm
itself; **derivation failure** takes the accepted-pair local-error transition and stops that watchdog.
AR-005's
[source-day lifecycle](../tasks/AR-005-responsive-web-schedule.md#8b-the-source-day-lifecycle) holds
the implementable form and its regression.

#### What the watchdog does and does not guarantee

A visible tab is not a running tab. Browsers throttle and suspend timers in foreground documents too,
and **no lifecycle event is guaranteed to fire at source midnight** — the application only observes
time when the browser executes its code. The guarantee is therefore stated as a bound, not as a
promise:

- under normal foreground scheduling, the watchdog **requests** a source-date check every
  `SOURCE_DATE_WATCH_INTERVAL_MS`;
- **browser scheduling delay is outside the application's control**;
- **while a callback is delayed, the previously rendered schedule and its relative labels may
  temporarily remain based on the previous `sourceToday`** — including a "Heute" that has become
  yesterday's;
- **the application makes no hard-real-time midnight guarantee**;
- at the **next** delivered signal — a watchdog callback, `visibilitychange` to visible, `pageshow`,
  window focus, or another documented recovery signal — it derives the **actual current source date
  directly**;
- if the date changed it **immediately supersedes the old attempt, removes or invalidates the
  relative labels and schedule state that would otherwise read as current, and begins authoritative
  revalidation**;
- it **never advances the date by assumption** and **never publishes a replacement schedule from
  stale capability metadata**.

**Freshness is bounded by the next callback or recovery signal, not by wall-clock midnight.** For a
collection schedule that is the right trade — but it is a bound, and describing it as anything
tighter would be describing a browser this application does not control.

This needs **no `Temporal`, no time-zone dependency, and no monotonicity assumption**. The formatter
supports whatever IANA data the runtime exposes; the watchdog simply observes what it says.

**The application is not constrained to `Europe/Berlin` to sidestep any of this.** The capability
contract accepts any validated IANA zone and the product stays city-neutral; narrowing the helper to
one zone's behaviour would trade a correctness problem for a product one.

No arithmetic assumption about day length, no offset table, and **no time-zone dependency added** —
`Intl` is the platform's own database and is already the authority everywhere else in this milestone.

#### Visibility recovery, because timers are not reliable

A background tab's timers are throttled, and a sleeping machine runs none at all. A timer alone would
mean a laptop opened on Tuesday still showing Monday.

- On **`visibilitychange`** and **`pageshow`**, when the page becomes active again, derive
  `sourceToday` from the current clock.
- If it differs from the last authoritative `sourceToday`, run **the same superseding refresh
  immediately**.
- If it is the same source date: **no network refresh and no published view-state change; while visible and still owned by the current accepted pair, ensure exactly one pending watchdog timeout**. An existing pending timeout is not duplicated, and a
  hidden, stale, disposed, superseded, or failed owner arms nothing.

**Every signal coalesces into one refresh attempt.** A timer firing at the same moment a tab is
restored, or several visibility events in a row, must produce exactly one authoritative refresh. Two
concurrent refreshes for one date change would issue duplicate requests and race each other to
publish, which is the defect the attempt token exists to prevent — so the coalescing is explicit
rather than left to that token to clean up afterwards.

#### This lifecycle is verified deterministically, not by waiting for midnight

Every branch above is reachable with a fake clock and fake timers. **No manual scenario may require a
tester to wait for real midnight or to change the operating-system clock**; an incidental live
observation is welcome and is not an acceptance blocker. Waiting for midnight is not a test, and
moving the machine clock changes the device zone's relationship to the source zone in ways that make
the observation ambiguous.

### The requested range is derived in the source's zone

Unchanged in substance from ADR 0004, because the same rule must hold for every client, and built on
the calendar-day model above.

**Time-zone failure belongs to `deriveSourceToday`, not to `deriveTargetRange`.** The two helpers own
different questions, and blurring them means the range helper carries a time-zone failure mode it
cannot cause and validates a zone something upstream already validated.

| Helper | Inputs | Owns | Must not |
| --- | --- | --- | --- |
| `deriveSourceToday` | the injected clock's current instant; the **validated capability `timeZone`** | Constructing and using the source-zone `Intl` formatter; deriving source-local `YYYY-MM-DD`; returning **either** the date **or** a typed source-date/time-zone failure | Fall back to the device zone; substitute UTC; throw into React rendering |
| `deriveTargetRange` | **`sourceToday` as an already-derived ISO date**; validated `validity.from` and `validity.to` | Calendar-day addition; clamping; the outside-current-period no-request result | Accept a `timeZone`; construct `Intl.DateTimeFormat`; derive `sourceToday` again; return an unusable-zone result; duplicate time-zone validation |

**Where an unusable zone actually fails.** Normally it never reaches here: `TimeZoneSchema` rejects it
at the transport boundary and it becomes an `invalid_response` for the **service-area** operation. If
`Intl` nevertheless fails after api-client success, `deriveSourceToday` returns its typed derivation
failure.

**That failure is web-owned, and a transport failure is the wrong shape for it.** Every
`ApiFailure` member requires an `operation`, and `problem`/`invalid_response` additionally require a
`status` — so representing a date-derivation failure as one means inventing a transport operation
that did not fail and a status no server sent. At the accepted-pair watchdog there is no current
request at all, and the invention would be plainest there. The decision is therefore a **single
web-owned renderable failure**, `source_date_unavailable`, carrying only the capability zone that
could not be used: no `operation`, no HTTP `status`, no `requestId`, and no `RangeError` text. The
shared `@abfall-radar/api-client` contract is **not** changed to accommodate a web lifecycle failure,
and the local failure stays distinguishable from a transport failure in both diagnostics and Retry
routing.

**Derivation has three outcomes wherever it is called**, and all three are handled: a date equal to
the request's captured snapshot, a different date, and the typed failure. A failure is not a changed
date — it does not trigger the restart, does not establish that a range is uncovered, does not consume
the shared reconciliation budget, and does not invalidate a confirmed provider/area. Ownership guards
run before any derivation result is acted on, so a superseded or cancelled owner never publishes a
local error, removes a successor's schedule, stops a successor's lifecycle owner, or starts a request.

**The no-events guarantee is about one request, not about history.** A failed *preflight* derivation
prevents the particular events request whose range would have come from that result. It never claims
that no events request occurred in the attempt: the initial request before reconciliation, a request
already issued before its own publication gate, and the request behind a schedule the watchdog is
monitoring have all legitimately happened. A gate failure adds no further request from its own
handling; a watchdog failure starts none by itself; a later Retry is a separate attempt.

AR-005's [step 3c](../tasks/AR-005-responsive-web-schedule.md#3c-source-date-derivation-failure-at-every-checkpoint)
holds the checkpoint-by-checkpoint table and the Retry and recovery-scheduling rules.

- `sourceToday` is derived as described in [Source-local calendar days](#source-local-calendar-days).
- The window is 90 calendar days forward from `sourceToday`, computed as calendar arithmetic.
- The range is clamped into the declared validity window: `from` is the later of `sourceToday` and
  `validity.from`, `to` is the earlier of `sourceToday` plus 90 days and `validity.to`.
- **When `sourceToday` is past `validity.to`, or the clamp inverts, no request is issued** and the
  surface states that the source publishes no calendar for the current period.
- **`SCHEDULE_RANGE_NOT_COVERED` is still handled as a product state**, because the capability
  response and the collection-events request can race: the declared window can change between the
  two, so a range that was correct when computed can be refused by the time it arrives. Its first
  exact result is a trigger for [bounded reconciliation](#bounded-capabilityschedule-reconciliation),
  not immediate entry; the product state follows only a refreshed capability with no requestable
  range or the reconciled events retry returning the exact problem — and budget exhaustion may come
  from **either** an earlier exact result **or** a metadata mismatch, so two `422` responses are never
  required. What ordinary live manual use cannot arrange is **the terminal 422 race**: it needs the
  declared window to change between the capability and events reads, and the normal UI exposes no
  arbitrary range control and clamps every request it issues. **The local, capability-derived entry
  path is a different matter and can be reachable by hand** when source-local today lies beyond the
  selected capability's validity. Both are verified through the injected data boundary regardless, as
  [Verification scope](#verification-scope-what-jsdom-proves-and-what-it-cannot) records.

### Transport-to-domain mapping stays consumer-local, and nothing is extracted

ADR 0004 deferred this until a second consumer existed. That consumer now exists, so the decision is
made here explicitly rather than deferred again — and it is made under
[the canonical extraction rule](../architecture/repository-structure.md#when-a-mapping-becomes-shared),
which this ADR is the first application of: **another consumer triggers a comparison, not an
extraction, and no consumer count ever mandates one.** That rule permits extraction on **either** of
two grounds — **demonstrated duplicated behavior** (proven identical semantics, a stable owner, an
appropriate dependency direction, and a meaningful reduction in duplicated *policy*), **or** a
**stable domain boundary that already requires the abstraction**, which needs no second consumer and
no concrete duplication. Both grounds are examined below; neither is satisfied here.

**Ground B is examined and does not apply either.** A transport-to-domain field rename is not a
domain boundary that already requires an abstraction; it is an implementation detail of each
consumer's own boundary, and the two consumers' boundaries differ in lifecycle, failure handling, and
persistence. The responsibility that *is* stable — what a collection event means — already lives in
`packages/domain` behind `CollectionEventSchema`, which is precisely why nothing further needs
extracting.

**Decision: `apps/web` gets its own transport-to-domain adapter, and no shared module is created.**
`apps/extension`'s behaviour is not modified — with one documentation consequence. Its adapter's doc
comment still says the mapping "lives in the extension until a second consumer exists", which is the
superseded consumer-count rule: the web application *is* that second consumer, and the adapter
correctly stays local anyway. AR-005's implementation session therefore corrects **that comment
only**, to agree with
[the two permitted grounds](../architecture/repository-structure.md#the-two-permitted-grounds) — a
second consumer alone does not require extraction; either demonstrated duplicated behavior or an
already established stable domain boundary may justify it; speculative future reuse establishes
neither. Runtime behaviour, imports, exports, types, dependencies, and adapter logic stay unchanged,
and the scope is recorded in
[AR-005](../tasks/AR-005-responsive-web-schedule.md#the-one-permitted-extension-edit-a-comment-correction).

The rule applied, which is the same rule for every candidate in this slice:

> Extract when the thing being shared is a **decision** — something two consumers must not be allowed
> to answer differently and that nothing else already checks. Duplicate when the thing being shared is
> a **body** — code whose correctness is already pinned by something shared.

Applied to the adapter:

- **The two adapters do not share an input type.** The extension's maps `CollectionEventPayload`, the
  strict internal schema declared in `apps/extension/src/messaging/contract.ts` that also validates
  every persisted cache entry on every read — including entries written by an older build. The web's
  maps `CollectionEventTransport`, the stripping HTTP validator in `@abfall-radar/api-client`. A
  shared module typed against the transport type would put `@abfall-radar/api-client` back into the
  popup's import graph, which `apps/extension/src/boundaries.test.ts` fails on and which ADR 0004
  decided against. A structurally typed shared function would avoid that by accepting any object with
  the right field names — which erases the one thing each adapter's signature currently proves,
  namely that its input is the validated payload of *its own* boundary.
- **The correctness of the mapping is already pinned by something shared.** Both adapters validate
  their result through `CollectionEventSchema` from `@abfall-radar/domain`. They cannot disagree about
  what a valid `CollectionEvent` is, and a rename that stopped matching would fail loudly in both. The
  duplicated part is roughly thirty lines of field renames with no policy in it.
- **A new package would have to justify itself as a package**, not as a home for a body. The
  repository requires one precise owner, a stated dependency direction, a browser-safe boundary, an
  import-graph test, and a concrete need demonstrated by both consumers. The need demonstrated here is
  for the body; the boundary each consumer needs is different. A package whose only job is to hold a
  body is where unrelated helpers accumulate afterwards.
- The same rule keeps the source-zone range derivation and the calendar-day helpers consumer-local:
  the extension's schedule module is entangled with worker-owned concerns the web has no analogue for
  — the cache range intersection, and an `unusable_zone` outcome shaped by the popup's effect
  handling — and the behavior that must not diverge is pinned by the contract and by the boundary
  tests AR-005 requires on both sides of UTC and near midnight.

**Revisit on evidence, never on a consumer count.**

> Re-evaluate extraction when another concrete consumer exposes proven identical behavior and a
> stable owner.

That is the whole trigger. A mapping that grows policy nothing else checks — a defaulted field, a
derived value, a normalization rule — is the kind of evidence that qualifies. **The mere existence of
a further consumer, mobile included, is not**: it is a prompt to look, exactly as the web application
was, and it decides nothing by itself. Any eventual extraction must satisfy **one of the two
permitted grounds** in
[the canonical rule](../architecture/repository-structure.md#the-two-permitted-grounds) — the
duplicated-behavior ground in full, **or** the stable-domain-boundary ground with its present
responsibility explained — preserve existing extension behaviour and tests, and stay narrowly scoped
to what that ground actually justifies.

**No bridge, `shared`, or `common` package is created by this milestone**, and nothing here promises
one later.

### UI and accessibility

- `@abfall-radar/ui` semantic tokens, baseline styles, `BrandMark`, and `WasteIcon` are reused.
- **No component moves into `packages/ui` in this milestone.** The bar is a component that is
  genuinely host-agnostic *and* already has two real consumers. The web's surfaces are its own
  composition of primitives and are not that yet.
- User-visible copy is German. Code, identifiers, comments, tests, and documentation are English.
- Semantic HTML before ARIA; every control has an accessible name and visible focus; focus order is
  preserved and returned across state transitions.
- Every member of [the exhaustive state union](#the-exhaustive-application-state-union) — including
  `no_official_providers`, `no_service_areas`, and `configuration_error` — carries its own German copy
  and its own announcement.
- State transitions are announced through a **polite live region**, so a change from loading to a
  rendered schedule, or to an error, is not silent for a screen-reader user.
- A failed range refresh is announced without replacing the `range_not_covered` heading or state;
  `Erneut versuchen` keeps its accessible name while its action follows the failure context's phase,
  never the transport operation alone.
- Provenance, freshness, and status are conveyed by text and icon, never by color alone.
- Layouts work at **320, 390, 768, and 1280 CSS px, and at 200% browser zoom**, with no horizontal
  page scrolling at any of them. The popup's `min-width: 392px` floor is an extension shell constraint
  and is not copied.
- Primary touch targets are at least 44 by 44 CSS pixels.
- `prefers-reduced-motion` is respected; `packages/ui/src/styles.css` already carries the global
  reduction, and no surface may reintroduce unconditional motion.

#### Verification scope: what jsdom proves, and what it cannot

jsdom implements the DOM. It does **not** lay out a document: it has no viewport, it computes no box
sizes, it resolves no CSS cascade from a Tailwind build, and `getBoundingClientRect` returns zeroes.
Any test claiming to have measured a width, an overflow, an element dimension, or a rendered focus
ring in jsdom would be asserting a value the runtime invented. This ADR therefore splits verification
explicitly, and neither half is allowed to claim the other's evidence.

**Automated, with Vitest and jsdom — deterministic and required:**

- which responsive classes and semantic tokens a surface selects for a given state;
- semantic structure, element roles, accessible names, and heading order;
- conditional rendering: which states, copy, and controls appear for which data;
- keyboard behavior expressed through the DOM — focus order, focus movement across state
  transitions, and that a disabled control is skipped by sequential navigation;
- accessibility state exposed through the accessibility tree, including `disabled`;
- live-region markup and the content announced into it;
- every product state, including race-derived ones, driven through the injected data boundary.

**Manual browser verification — required, and recorded as manual:**

- actual layout at **320, 390, 768, and 1280 CSS px**, named exactly rather than as "phone" and
  "tablet", so two reviewers check the same thing;
- the same flows at **200% browser zoom**, including **768 px at 200%**, verifying *effective reflow*
  rather than a changed DevTools width;
- **long dynamic content** — a long provider name, area name, German attribution, link label, status
  line, and an unbroken externally supplied compound word — substituted through the Elements panel
  after a real render, at every width and at 200% zoom;
- absence of horizontal page scrolling at each of those widths and zoom levels, including with long
  unbroken content that cannot be wrapped at a space;
- visible focus appearance on **every operable control that exists in the current live flow**;
- keyboard focus order through provider selection, available-area selection, confirmation, the
  schedule, and the retry, back, and change-selection actions;
- rendered touch-target dimensions against the 44 by 44 CSS pixel floor;
- visual reduced-motion behavior;
- that the Tailwind pipeline actually produced the token utilities the classes name.

These manual checks remain acceptance criteria. They are not downgraded to advice, and they are not
satisfied by a jsdom test that happens to mention a width.

**Automated because the live catalogue cannot demonstrate it — not a preference, a fact about the
data:**

The API this milestone is verified against currently offers **one** non-demo provider
(`koblenz-servicebetrieb`) with **one** available service area (`koblenz-stadtmitte`), and that
source publishes exactly **two** timed mobile drop-offs, on `2026-03-21` and `2026-11-07`, inside a
validity window of `2026-01-01` to `2026-12-31`. This milestone adds no manual fixture mechanism, no
debug control, no clock control, and no browser automation, so nothing in it can manufacture a second
provider, a second area, or a drop-off on a different date.

**Three** behaviors have no reachable live scenario and are proven by deterministic tests over
injected fixtures instead. **Two more are conditional rather than unreachable** and are described
after them — the distinction matters, because "we cannot reach this" and "we could not reach this
today" are different records:

- **provider switching and area switching**, including that changing the provider clears the area —
  a single offered choice cannot be switched away from;
- **newest-selection-wins and supersession**, which needs two selections in flight;
- **every unavailable-area behaviour** — that it stays visible with explanatory German copy, carries
  native disabled semantics, is skipped by sequential `Tab` so focus advances to the next operable
  control, cannot be selected or confirmed by click, Enter, or Space, and triggers neither a
  confirmation nor a collection-events request. **The live catalogue exposes no unavailable area**,
  and exposing the demo provider to manufacture one would break the very rule being verified.

**Mobile drop-off rendering is conditional, not unreachable.** The reason it was once grouped with
the three above — that whether a timed event lies inside the rolling 90-day range depends on the date
verification happens — is a statement about the **calendar**, not about the catalogue, and it does not
belong beside "there is only one provider". The source does publish drop-off appointments, and a
90-day range can contain one; whether the check applies is read from the **accepted response** at the
moment of verification rather than assumed either way. When a drop-off is present the live check is
mandatory and blocking; when the accepted response carries none it is recorded `not applicable` with
the effective range, the capability's validity window, and the accepted event set. AR-005 holds the
scenario.

**Relative-day labels are the other conditional one, for a different reason.** `Heute`,
`Morgen`, and `In N Tagen` render only for an accepted event inside the documented relative window;
anything further out falls back to the absolute German date, which is formatted identically whether
the day came from the source zone or the device zone — and an empty result set shows no label at all.
A live observation therefore proves the source-versus-device rule **only** when an accepted event is
inside that window **and** the chosen device zone and the actual verification instant put the two
calendar dates on different days. When both hold the live check is mandatory and blocking; otherwise
it is recorded `not applicable` with the observed instant, zones, derived source date, and event
labels, and the deterministic source-local calendar-day tests — which own both the zone difference and
the relative/absolute boundary — remain the standing evidence. **No verification date is fixed in
advance**, and the catalogue is read rather than assumed. **The two conditional checks are
independent**: an in-range drop-off roughly two months out supports drop-off rendering verification
while still rendering the **absolute** date label, so neither check's applicability implies the
other's.

**No mandatory live step may depend on an unavailable area.** Visible focus and keyboard focus order
remain mandatory live checks — over the controls the current flow actually contains: provider
selection, available-area selection, confirmation, the schedule, and the retry, back, and
change-selection actions. An absent unavailable area is not a gap in verification and **must not
block acceptance**; the component tests are the standing evidence.

A live check of any of them is **conditional, and recorded as not applicable when its precondition
does not hold** — never as passed, and never as failed. A behavior that could not be exercised was not
tested, and saying so is the only honest report. Recording the precondition alongside the outcome is
what lets a later reader tell "we could not reach this" from "this did not work".

**A conditional scenario whose documented precondition is false does not block acceptance.** It
cannot: there is nothing to perform. Treating it as outstanding would make the milestone permanently
unacceptable for a reason no implementation can fix, which is how a checklist stops being read. Its
automated counterpart is the evidence, and that counterpart *is* mandatory.

**The ordinary reachable manual scenarios stay mandatory** and none of them is downgraded here:
application startup, the needs-selection state, selecting the live official Koblenz provider and
area, schedule and provenance rendering for the current range, reload returning to needs-selection,
keyboard and focus checks, the responsive viewport checks, and every reachable failure and retry
flow — including both upstream-failure modes described in
[Stopping the API is an invalid response](#stopping-the-api-is-an-invalid-response-not-a-network-failure).

### Provenance the surface must display

A successful collection-events response carries **three separate provenance values**, and the surface
renders all three. They are not interchangeable and none may be collapsed into another:

| Field | What it is | Rendered as |
| --- | --- | --- |
| `meta.source.name` | The operator's name | The source name |
| `meta.source.attribution` | The credit line the source requires | Attribution **text**, verbatim |
| `meta.source.landingPageUrl` | The operator's public page | The source **link** |

The distinction is the point. `name` is `Kommunaler Servicebetrieb`; `attribution` is
`Kommunaler Servicebetrieb, Koblenz` — a different string the operator asks to be shown. Rendering
only the name and the link discards a credit the shared rules require to be displayed where the data
is displayed.

- **Attribution is never synthesized** from the source name, the locality, or the two joined
  together, and it is **never replaced by the link's hostname**. It is whatever the source said.
- **The link is the validated `landingPageUrl`** and nothing else. **No upstream calendar or download
  URL is ever exposed** — that is a retrieval detail the server owns, and it is not in the transport
  contract for a client to show.
- The link stays accessible and safe: `WebUrlSchema` has already refused any scheme that is not
  `http(s)` and any URL carrying credentials, and **if it opens in a new context it carries the
  appropriate `rel` protection**.

Alongside those three, every rendered schedule shows `retrievedAt`, the freshness state, the complete
declared waste-type coverage, and the effective display range.

**All of this renders whenever the response carries provenance — including a successful empty
schedule.** An empty period is still an answer from a named source at a known time, and stripping the
credit from it would leave the one state most likely to be doubted with nothing to attribute it to.

**Every normalized `CollectionEvent` in the accepted response is represented.** One upstream
appointment can normalize into several events — the verified source's combined
`Schadstoffe / Elektrokleinteile` appointment yields one `hazardous` and one `small_electronics`
event sharing date, window, zone, and location — and **they are not deduplicated for sharing any of
those**. That *normalization* is proven in its owning workspace by
`packages/data-providers/src/node/normalize.test.ts`; the web application never sees an appointment,
because every transport record carries exactly one `wasteType`. What the web owns is that **all
accepted records are displayed**. They are distinct events with distinct waste types and distinct identities, and each keeps
its own label. Collapsing them would silently drop a collection the source published.

The authoritative design remains **one event per rendered row or card**. If a future design groups
events that share a window and place, the grouped presentation must still **visibly represent every
normalized event** and discard no identity, waste type, or required drop-off detail.

Every `mobile_drop_off` event that is rendered shows **its own** time window — formatted in the
source zone by the formatter above, never in raw UTC and never in the device's zone — the window's
source time zone identifier, and its location. Not only the first or the next event. A `curbside`
event never renders drop-off instructions. The contract makes the two variants closed and complete
precisely so a client cannot render "bring something somewhere" with no window and no place.

**This is proven by deterministic tests over a validated fixture**, not by looking at the live
schedule. The verified source publishes only two timed **upstream appointments** a year — each
normalizing into a `hazardous` and a `small_electronics` `CollectionEvent`, so **four** normalized
events in total — and whether either appointment falls inside the rolling 90-day range depends
entirely on when verification happens. That makes the live view evidence of the calendar rather than
of the rendering.

## Consequences

### Positive

- a second surface reads official municipal dates with their provenance intact, from the same
  validated contract, with no second ingestion path and no municipal host contacted;
- the network boundary is one named data layer, so the timeout, cancellation, and failure policy has
  exactly one home in the application;
- because that layer is injectable, states that depend on a race between two responses are reachable
  from a deterministic test rather than needing a debug control in the product;
- same-origin requests mean the API needs no CORS policy for this milestone, and the development
  proxy makes local development look like the eventual production topology;
- no production domain enters the repository, and the fresh emitted-output scan rejects every
  absolute HTTP(S) occurrence that does not match one of
  [the four sanctioned categories](../tasks/AR-005-responsive-web-schedule.md#the-four-sanctioned-categories) —
  exact platform-namespace literals, the verified Tailwind banner inside a genuine CSS block comment,
  the exact React diagnostic value, and Zod's IPv6 URL-parsing scaffold — never a bare
  namespace-only allowlist;
- every dependency comes from the existing catalogue **except the two approved parser entries**,
  `postcss` 8.5.28 and `postcss-value-parser` 4.2.0 — the two version decisions this milestone
  makes, approved by the repository owner on 2026-09-15 as `apps/web` devDependencies; and no
  browser runner enters the toolchain;
- `@abfall-radar/api-client`'s independence from `@abfall-radar/domain` survives an additional
  consumer rather than being quietly abandoned at the first opportunity to share code;
- the extension is untouched, so this milestone cannot regress a surface it does not change.

### Trade-offs

- **reloading loses the selection.** The web application is measurably less convenient than the
  extension on this point, and it is the most visible cost of the slice;
- there is no offline behavior at all: with the API unreachable, the web application shows an error
  where the extension would show a labelled cached schedule;
- **layout is verified by a person, not by a test.** Without a browser runner, a regression in
  responsive behavior is caught at review time rather than in CI, and the manual checks have to
  actually be performed;
- showing every published waste type with no filter means a busy area's schedule is longer than a
  filtered one would be, and someone who cares about one bin has to scan for it;
- the transport-to-domain mapping, the source-zone range derivation, and the calendar-day helpers
  each exist twice in the repository, and only the shared domain schema and the boundary tests keep
  them honest;
- same-origin means the web application cannot run against a differently hosted API without a
  reverse proxy, which is a deployment constraint accepted deliberately in exchange for not deciding
  a CORS policy early;
- Vite's dev proxy is development-only configuration that has no production counterpart yet, so the
  production topology is asserted by this ADR rather than exercised by anything;
- the milestone produces no deployable artifact, because there is nowhere to deploy it to.

## Alternatives considered

### Mirror the extension and route requests through a worker

Rejected. The reasons ADR 0004 gave are host-specific: a short-lived popup, worker-owned storage and
alarms, and no cancellation for the sender. None of them holds for a web document. A Service Worker
here would additionally be a PWA decision wearing an architecture costume, and offline behavior is an
explicit non-goal.

### Add Playwright or another browser runner to prove the responsive behavior

Rejected for this milestone. It is the only thing that would turn the layout checks into automated
evidence, and it is a genuine gap — but it is a new dependency, a second test runner, a CI browser
download, and a whole verification strategy, none of which is a first-slice decision. Naming the gap
honestly in [Verification scope](#verification-scope-what-jsdom-proves-and-what-it-cannot) is better
than either pretending jsdom covers it or expanding this milestone to cover it properly.

### Assert widths and overflow in jsdom anyway

Rejected outright. jsdom performs no layout, so such an assertion passes on a value the runtime made
up. A test that cannot fail when the layout breaks is worse than no test: it converts an unverified
property into a verified-looking one, and the next person reads the green tick rather than the
document.

### Configure an absolute API base URL through a build-time environment variable

Rejected for this milestone. It is the natural counterpart to the extension's `WXT_API_BASE_URL`, and
it will probably be right eventually — but it needs a production origin to point at, and it makes
every request cross-origin, which forces a CORS policy on `apps/api` now. Same-origin plus a
development proxy defers both decisions without pretending they do not exist.

### Add CORS to `apps/api` for local development

Rejected. A permissive origin policy added for a dev server's convenience is exactly the policy that
survives into production unnoticed, and ADR 0002's error and contract discipline would be undermined
by a security decision made as a side effect of a client milestone.

### Persist the selection in `localStorage`

Rejected for this slice. It looks like one line and is not: the extension needed a versioned schema, a
verified migration table, and a single-owner repository to make a persisted selection safe, plus an
invalidation rule for an area that later becomes unavailable. A weaker version here would create a
persisted shape the eventual design has to migrate away from, in exchange for saving one interaction.

### Ship a waste-type filter in the first slice

Rejected. A filter needs preference state, and preference state needs somewhere to live — which is
the persistence decision this milestone has already deferred. It also introduces the
unpublished-selected-type state, which only makes sense once a person can select a type. Showing
everything the source published, with the coverage declaration alongside it, is complete and honest
without any of that.

### Ship `aria-disabled` on a focusable row instead of a disabled control

Rejected. It puts a keyboard user on a control they cannot use, and it keeps the activation path
open — so the guarantee that an unavailable area cannot be chosen would rest on a handler
remembering to refuse rather than on the platform. A native disabled control is skipped by `Tab`,
announced as disabled, and dispatches no activation at all.

### Extract the transport-to-domain adapter into a shared package now

Rejected, with the reasoning recorded above and an explicit trigger for revisiting it. The short
version: the two adapters share a body, not a boundary, and their correctness is already pinned by
`CollectionEventSchema`.

### Change `packages/domain`'s schedule helpers to take an explicit source day

Rejected for this milestone. It would be a reasonable eventual cleanup — the current signatures
default to an ambient `new Date()` and parse date-only strings into device-local midnight, which is
the wrong question for a municipal calendar — but neither client calls them today, so changing them
now would be a cross-workspace edit with no consumer, made inside a web milestone. The web
application simply does not use them, and says so.

### Add TanStack Query or a similar data library

Rejected. It would own caching and retry policy that this milestone has deliberately decided not to
have, and `@abfall-radar/api-client` already owns deadlines, cancellation, and failure translation.
The product behavior would then live partly in a dependency's defaults.

### Add a router now, with the selection in the URL

Rejected. One document and two surfaces do not need one, and putting the selection in the URL would
make it shareable and bookmarkable state — which is a persistence decision this milestone explicitly
defers, arriving through the back door.

## Risks

- **The API is not deployed, and there is no production topology.** This milestone produces a
  locally-verified artifact by design. The same-origin assumption is an assertion until a reverse
  proxy exists to satisfy it.
- **Browser cache policy and schedule persistence are separate guarantees.** The web wrapper's
  `cache: 'no-store'` prevents browser HTTP-cache reuse or storage, while the session-only product
  separately persists no schedule; neither claim bypasses the API's deliberate server-side cache.
- **Layout has no automated guard.** Responsive behavior, overflow, focus appearance, touch-target
  size, and reduced-motion are verified by a person at review time. A regression between reviews is
  invisible to CI, and the mitigation is that these stay acceptance criteria rather than becoming
  advice.
- **The live catalogue is too small to exercise selection behavior.** One provider, one area, and two
  timed upstream appointments a year — normalizing into four events, often none inside the rolling
  window — mean switching and supersession are fixture-only, while live drop-off rendering is merely
  conditional. Those tests use fixtures the implementer wrote, so a mismatch between the fixture and
  what the API really returns would not be caught here — the `apps/api` contract tests and the client's
  own validators are what keep the fixture shapes honest. The exposure grows if a second provider is
  added later and nobody revisits these scenarios.
- **Session-only selection will read as a bug to anyone comparing the web application with the
  extension.** The mitigation is honesty in the copy and in the documentation, not a quick
  persistence layer.
- **Two implementations of the source-zone derivation and the calendar-day helpers can drift.** A
  drift would mean two clients disagreeing about which day it is for the same municipality. The
  boundary tests on both sides of UTC and near midnight are the detector, and the extraction trigger
  is the exit.
- **Reusing a completed revalidation is only as sound as its predicate.** The evidence rule removes a
  duplicate catalogue round-trip on entry, but suppressing the immediate cycle is correct solely while
  every clause holds. A loosened clause, or eligibility inferred from a retained object rather than
  from completed work, would silently leave an uncovered state unrefreshed until the next 15-minute
  deadline. This is why the rule is a predicate over evidence and not a list of blessed flow names.
- **The final source-date gate narrows the stale-publication window; it does not remove it.** The gate
  makes the checked date and the publication one synchronous decision, so no schedule is ever accepted
  for a day the application already knows has passed. A rollover occurring *after* publication is a
  different event, and the accepted-pair watchdog — deliberately not hard real time — is what handles
  it. Between the gate and the next watchdog tick a rendered `Heute` can lag reality by up to its
  interval, and that is the residual this design accepts rather than hides.
- **The gate depends on the clock being injected everywhere.** A direct `Date.now()` or
  `new Date()` anywhere on the acceptance path would make the check unverifiable and could compare a
  snapshot against a different clock than the one the tests drive. The rule is a convention with test
  coverage behind it, not a mechanism the type system enforces.
- **The ambient-date helpers in `packages/domain` remain exported and callable.** Nothing prevents a
  future contributor from reaching for `getUpcomingEvents` and reintroducing a device-zone day. Both
  clients avoid them by decision rather than by a mechanism, and this ADR is the record of why.
- **A browsing context does not always have a usable origin, and `location` will not say so.** A
  `file:` document or a sandboxed frame has an opaque security origin while `location.origin` may
  still read as an ordinary URL. The resolver treats the serialized global origin as authoritative and
  refuses rather than issuing requests from a context it cannot attribute.
- **The development proxy changes which failure a stopped API produces.** Behind Vite, stopping
  `apps/api` yields `invalid_response` from the proxy's own `text/plain` error — `502` on the pinned
  Vite 8.1.5 — not `network`. In a production topology with a
  different reverse proxy the status and body could differ again, and with no proxy at all the same
  outage would be a genuine `network` failure. The web application handles all of them, but nobody
  should read the development behavior as the deployed behavior — and a tester who expects `network`
  will report a defect that is not one.
- **Instant comparison is one line away from being wrong again, in two different ways.** Sorting
  `startsAt` as text passes every whole-second fixture; sorting it through `Date.parse` passes
  everything down to a millisecond and then silently ties on finer precision the contract accepts.
  The named fractional-second tests — `.500` for the lexical trap and `.0001` against `.0002` for the
  truncation trap — are the guards, and both have to stay.
- **The id-uniqueness check is a client-side invariant, not a contract guarantee.** The API may still
  emit duplicate identifiers; the web application refuses such a response rather than rendering it.
  If that ever happens against real data the schedule disappears entirely, which is the intended
  fail-closed cost — but it means a server-side regression surfaces here as an unusable answer rather
  than as a diagnosable one. Whether the contract should guarantee uniqueness is left open.
- **The origin resolver depends on two globals agreeing.** A browsing context that reports a usable
  `window.origin` while `location.origin` says something else is refused outright. That is correct
  and it is also untested against real embedders, because this milestone adds no browser automation.
- **The midnight refresh is a background state change nobody asked for.** A page left open overnight
  clears its schedule and refetches on its own. That is the correct behaviour — the alternative is a
  confidently wrong "Heute" — but it means the surface can go from populated to loading with no user
  action, and a screen-reader user needs the live region to say so.
- **Timer throttling is browser policy, not something this milestone controls, and it applies to
  visible tabs too.** A page whose timers are throttled by a battery-saving or background-CPU policy
  can sit past source midnight still showing yesterday's schedule and a stale "Heute". That window is
  **real and accepted**: freshness is bounded by the next delivered callback or recovery signal, not
  by midnight. What the application guarantees is that the moment it does run, it derives the actual
  current date, clears what would read as current, and revalidates authoritatively — it never
  assumes, and never republishes from stale capability metadata.
- **The 90-day window is a product choice**, not a contract constraint, and the near-year-end
  experience still depends on the operator publishing the next year's validity window.
- **A new `collectionMode` variant fails validation loudly** in this client too. That remains ADR
  0003's intended cost of a closed variant set.
- **Deriving today in the source's zone means a traveller sees the municipality's day**, not their
  own. Correct for a collection schedule, and recorded here as it was in ADR 0004.
- **No offline path exists.** A transient selection or schedule-pipeline network failure is a
  full-screen error rather than a degraded but useful schedule; during range recovery the truthful
  range state remains with a nested failure and no cached schedule appears. That is a deliberate
  consequence of deferring the cache, and it is the first thing the PWA milestone should address.
- **The same transport operation can fail under several product owners.** A `listProviders` failure
  can belong to selection, schedule reconciliation, or range recovery; routing Retry from the
  operation would either resume an unsafe partial schedule attempt or strand recovery. The typed
  `FailureContext`, phase-matrix tests, and owner-assigned attempt tokens are the guard, and stale
  context must be cleared whenever ownership changes.

## Deferred decisions

Each of these is deliberately *not* decided here, and none is blocked by anything in this ADR:

- PWA manifest, service worker, install prompt, offline mode, persistent schedule cache, background
  sync, and push notifications;
- persistence of the selection, and with it accounts, saved addresses, and cross-device
  synchronization;
- **waste-type filtering and preferences**, and with them the unpublished-selected-type state that
  only exists once a person can select a type;
- a browser test runner and the automated responsive and visual verification it would enable;
- production hosting, reverse-proxy configuration, DNS, TLS, a production API origin, and CORS
  policy;
- web reminders and browser notifications;
- maps, recycling points, geocoding, routing, and location permission;
- retiring or re-signing `packages/domain`'s ambient-date schedule helpers;
- SSR, SEO, and a marketing website;
- the mobile application. Its arrival is **not** an extraction trigger and implies **no** bridge
  package: a future mobile task evaluates
  [the canonical rule](../architecture/repository-structure.md#when-a-mapping-becomes-shared) from
  evidence, like any other consumer.

## Rollout

1. Activate the workspace: manifests, TypeScript and Vite configuration, the stylesheet wiring, and
   the responsive shell, so the application builds and is reachable from `pnpm check` before any
   product behavior depends on it.
2. Land the data layer — base URL resolution, the client, the three reads, and the
   transport-to-domain adapter — with its import-graph guards.
3. Land the source-local calendar-day helpers, range derivation, total event order, pure view-state
   derivation, and phase-owned `FailureContext`/Retry transition, with zone, clamping, ordering, and
   phase-matrix tests.
4. Land the needs-selection surface, including official-provider verification, the successful-empty
   catalogue states, and native disabled semantics for unavailable areas.
5. Land the schedule surface with provenance, coverage, drop-off details, the empty-period state, and
   every failure state including the injected range-not-covered race; then wire bounded
   reconciliation and range recovery through the same phase-aware Retry contract.
6. Verify manually in a browser against a locally running API at 320 px, phone, tablet, and desktop
   widths, keyboard-only, with a non-European device time zone; record each conditional live scenario
   as performed or not applicable with its precondition; and confirm the production build output
   contains no absolute HTTP(S) URL occurrence outside the
   [four sanctioned categories](../tasks/AR-005-responsive-web-schedule.md#the-four-sanctioned-categories) —
   exact required platform namespace literals, the narrowly defined Tailwind license-comment
   exception, the exact React diagnostic-literal exception, and the narrowly defined Zod IPv6 scaffold
   exception — classifying each occurrence against that table or recording it as unresolved. Every
   namespace-allowlist entry is **one of the four categories, not the whole policy**, and is
   established from that fresh build.

[AR-005](../tasks/AR-005-responsive-web-schedule.md) is the task that implements this decision.
