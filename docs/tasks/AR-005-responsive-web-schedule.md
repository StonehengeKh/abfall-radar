# AR-005: Responsive web application with the first official-schedule vertical slice

- Status: Ready
- Owner: Claude Code

**The parser-dependency blocker is removed.** The production dependency guard's CSS traversal needs
`postcss` **8.5.28** and `postcss-value-parser` **4.2.0** as `apps/web` devDependencies through two new
catalogue entries, and CLAUDE.md requires asking before adding a dependency. **The repository owner
approved both packages at both versions on 2026-09-15**, as recorded in
[Dependency approval record](#dependency-approval-record). That approval does not waive any other
gate: implementation still starts only after
[this task and ADR 0005 are reviewed, committed, and pushed](#handoff-workflow), and
readiness for human acceptance still requires Codex `APPROVE` per
[`docs/ai/workflow.md` §6](../ai/workflow.md#6-codex-performs-final-review).

## Goal

Activate `apps/web` as a responsive React 19 and TypeScript Vite application and deliver one complete
vertical slice through it: a person selects an offered official provider and service area and sees the
municipality's published collection schedule, with its provenance, freshness, declared coverage, and
complete mobile drop-off details intact. The web application reaches data by calling
`@abfall-radar/api-client` directly from a named application data layer over same-origin requests,
with no worker hop, browser requests forced to `cache: 'no-store'`, and no persisted schedule cache
or selection persistence.

## User outcome

A person opens the web application and is asked to choose. They pick an offered official provider —
never a demo one — and then one of that provider's service areas. An area the provider publishes no
calendar for stays visible with an explanation, is skipped by keyboard navigation, and cannot be
chosen by mouse, by keyboard, or by a screen reader. They confirm their choice explicitly, and see
every collection the responsible municipal operator published for the covered period: who published
it, the credit line that operator asks to be shown, a link to their public page, when it was
retrieved, whether that data is current, which waste types the source declares it covers, and the
exact period the answer is about. Every mobile drop-off states its own window, the
zone that window is in, and where to go. When the source published nothing for that period, they are
told exactly that — not shown a blank screen and not told something failed. When the API cannot be
reached, times out, answers with something unusable, or reports a problem, they see which of those
happened in plain German, with a support identifier only when the server actually supplied one. Demo
data is never shown as official data. Reloading the page returns them to the choice, which this
milestone accepts as a stated trade-off.

## Context

- [ADR 0005: Responsive web schedule](../decisions/0005-responsive-web-schedule.md) — the approved
  architecture this task implements. Do not restate it; link it.
- [ADR 0004: Extension API integration](../decisions/0004-extension-api-integration.md) — the client,
  the failure taxonomy, the source-zone derivation rule, and the statement that the transport adapter
  waits for a second consumer. ADR 0005 resolves that statement under
  [the canonical extraction rule](../architecture/repository-structure.md#when-a-mapping-becomes-shared):
  another consumer triggers a comparison, never an automatic extraction, and no consumer count
  mandates one. That rule permits extraction on **either** demonstrated duplicated behavior **or** a
  stable domain boundary that already requires the abstraction; the second ground needs no second
  consumer and no concrete duplication.
- [ADR 0003: Official schedule ingestion](../decisions/0003-official-schedule-ingestion.md) — the
  provenance, freshness, coverage, and closed-variant semantics this surface must preserve.
- [ADR 0002: Shared documented HTTP API](../decisions/0002-shared-http-api.md) — the contract and
  Problem Details rules that stay in force.
- [Repository architecture](../architecture/repository-structure.md),
  [Shared engineering rules](../ai/shared-rules.md), [Design system](../design/design-system.md),
  [Agent workflow](../ai/workflow.md).
- [AR-004](AR-004-extension-api-integration.md) — the first consumer of the same contract, and the
  source of every reusable pattern below.

Existing code this task reuses rather than duplicating:

| Location | Reuse |
| --- | --- |
| `packages/api-client/src/index.ts` | `createApiClient`, `parseApiBaseUrl`, the failure union, and every response validator and type |
| `packages/api-client/src/client.ts` | The already-implemented request-identity, officiality, requested-range, and content-type checks. The web reuses them and adds only the explicitly documented cross-record and cross-request invariants that the client cannot own |
| `packages/domain/src/waste.ts` | `CollectionEventSchema`, `WasteTypeSchema`, `wasteLabels`, `wasteDescriptions` |
| `packages/ui/src/styles.css` | Semantic tokens, the `@theme inline` block, the focus treatment, and the global reduced-motion rule |
| `packages/ui/src/brand-mark.tsx`, `waste-icon.tsx` | `BrandMark` and `WasteIcon`, used as-is |
| `apps/extension/entrypoints/popup/style.css` | The `@import` plus `@source` wiring pattern for the shared stylesheet — **the 392 px floor is not copied** |
| `apps/extension/src/schedule/schedule-range.ts` | Reference behavior for `deriveLocalDate`, `addCalendarDays`, `daysBetween`, and `deriveTargetRange` — reimplemented in `apps/web`, not imported |
| `apps/extension/src/features/dashboard/dashboard-view.tsx` | Reference behavior for `relativeDayLabel(date, today)` over two ISO strings and for UTC-pinned `Intl` day formatters |
| `apps/extension/src/schedule/view-state.ts` | Reference behavior for one pure state derivation. **The event order is specified in full in [step 5](#5-view-state-derivation-and-event-ordering) and is not read off the extension.** |
| `apps/extension/src/hooks/use-catalogue.ts` | Reference behavior for provider verification, the once-per-provider area request, and attempt-token supersession |
| `apps/extension/src/adapters/collection-event.ts` | Reference mapping and its non-throwing variant |
| `apps/extension/src/features/onboarding/needs-selection-view.tsx` | Reference for confirmation, native disabled semantics on unavailable areas, and German copy |
| `apps/extension/src/boundaries.test.ts` | The import-graph walk to adapt for this workspace's guards |
| `apps/extension/vitest.config.ts`, `src/test/setup.ts` | The jsdom and Testing Library setup shape. jsdom performs no layout; see [Verification scope](#verification-scope) |
| `packages/domain/tsconfig.json`, `packages/ui/tsconfig.json` | The TypeScript configuration shape to mirror |

**Deliberately not reused: `packages/domain/src/schedule.ts`.** `getUpcomingEvents` and
`getRelativeDateLabel` both default their reference to an ambient `new Date()` and both call
`parseISO` on a date-only string, which yields local midnight **in the device zone**. That is the
wrong question for a municipal calendar. `apps/extension` already reached the same conclusion and
calls neither. See [step 3](#3-source-local-calendar-days). **`packages/domain` is not modified.**

`apps/extension` is a **reference to read, never a module to import.** Every row above marked as
reference behavior is reimplemented in `apps/web`, per
[ADR 0005's extraction decision](../decisions/0005-responsive-web-schedule.md#transport-to-domain-mapping-stays-consumer-local-and-nothing-is-extracted).

## Verification scope

jsdom implements the DOM and performs **no layout**: no viewport, no box sizes, no Tailwind cascade,
and `getBoundingClientRect` returns zeroes. This task therefore splits verification, and **no
automated test may claim to have measured layout.**

**Automated — Vitest and jsdom, deterministic, required:** responsive class and token selection,
semantic structure, roles, accessible names, heading order, conditional rendering, DOM-expressed
keyboard behavior including focus order and disabled-control skipping, accessibility-tree state,
live-region content, and every product state driven through the injected data boundary.

**Manual browser verification — required, recorded as manual, never claimed by a test:** actual
layout at **320, 390, 768, and 1280 CSS px**, plus 200% browser zoom; absence of horizontal page
scrolling; visible focus appearance; rendered touch-target dimensions; visual reduced-motion
behavior; and that the Tailwind pipeline really produced the token utilities the classes name.

**No browser test runner is added.** Playwright, another browser runner, and screenshot or
visual-regression tooling are out of scope, per
[ADR 0005](../decisions/0005-responsive-web-schedule.md#add-playwright-or-another-browser-runner-to-prove-the-responsive-behavior).

### What the live catalogue can and cannot show

Verified against the repository, not assumed:

| Fact | Evidence |
| --- | --- |
| Exactly **one** offered non-demo provider, `koblenz-servicebetrieb` | `apps/api/src/providers/provider-catalogue.ts` returns one `demo` and one `official_ics` entry |
| Exactly **one service area**, the available `koblenz-stadtmitte`; no unavailable area | `packages/data-providers/src/node/koblenz/manifest.ts` declares a single available manifest |
| Validity window `2026-01-01` to `2026-12-31` | the same manifest |
| Exactly **two** timed mobile-drop-off **upstream appointments** (`VEVENT`), on `2026-03-21` and `2026-11-07` | the source verification record in [AR-003](AR-003-official-ics-provider.md) |
| Those two appointments normalize into **four** mobile-drop-off `CollectionEvent` values | AR-003: each `Schadstoffe / Elektrokleinteile` appointment yields one `hazardous` **and** one `small_electronics` event |

**Appointments and normalized events are different counts, and AR-003 says so explicitly: "keep the
two numbers apart."** One **upstream appointment** is one ICS `VEVENT`. One **normalized product
event** is one domain `CollectionEvent`. Each of the two verified timed appointments declares two
waste types and normalizes into **two separate `CollectionEvent` values** — one `hazardous`, one
`small_electronics` — sharing date, window, zone, and location while carrying distinct identifiers.
So the source has **two timed appointments** and **four normalized timed events**.

**What a request returns depends on the range**, and the ordinary rolling 90-day window frequently
contains neither appointment:

| Requested range contains | Normalized mobile-drop-off events returned |
| --- | --- |
| Neither timed appointment | **0** |
| One timed appointment | **2** — one `hazardous`, one `small_electronics` |
| Both timed appointments | **4** |

This task adds **no manual fixture mechanism, no debug control, no clock control, and no browser
automation**, so nothing in it can manufacture a second provider, a second area, or an appointment on
another date.

**Three** behavior groups have **no reachable live scenario**, each for a stated structural reason
about the catalogue rather than about the calendar:

- **provider and area switching** — the catalogue offers exactly one official provider and one
  available area, so there is nothing to switch to;
- **newest-selection-wins supersession** — it needs two selections in flight, which one offered choice
  cannot produce;
- **unavailable-area semantics and interaction** — the live catalogue exposes **no** unavailable area,
  and using the demo provider to manufacture one would break the rule being verified.

**Mobile drop-off rendering is not in that group.** It is **date-dependent, not structurally
unreachable**: the catalogue does publish drop-off appointments, so whether the check applies is
decided by what the accepted response actually contains on the day of verification. It is classified
under [conditional live scenarios](#verification) with its own prerequisites, and it is applicable and
**mandatory** whenever those hold.

All four remain **conditional** rather than guaranteed. A conditional check is recorded as **not
applicable** — with the concrete reason and the observed evidence — when its prerequisite is absent.
Never as passed, never as failed. See [Verification](#verification).

## Absolute API origins: where they may and may not appear

The same-origin rule constrains **what the runtime constructs and what ships**, not every string in
the workspace. Stated per location, so the development proxy and the prohibition do not contradict
each other — the reasoning is in
[ADR 0005](../decisions/0005-responsive-web-schedule.md#where-an-absolute-api-origin-may-and-may-not-appear).

| Location | Absolute API origin |
| --- | --- |
| `apps/web/vite.config.ts`, the dev `server.proxy` target | **Required, exactly one value:** `http://127.0.0.1:3000` |
| Tests and documentation **that verify or describe that proxy** | **Permitted**, the same literal |
| Test fixtures | **Scoped by fixture category** — see [Fixture URL policy](#fixture-url-policy) |
| `apps/web/src/**` — production runtime application source | **Forbidden.** No hard-coded absolute API origin of any kind |
| Production JavaScript, CSS, and HTML output | **Forbidden:** every absolute HTTP(S) URL occurrence is rejected unless it matches one of the [four sanctioned categories](#the-four-sanctioned-categories), which is the canonical enumeration and is not restated here |

- **`vite.config.ts` is build tooling, not production runtime application source.** Vite consumes
  `server.proxy` in the dev-server process and never emits it into the production module graph. A
  correct `vite.config.ts` must therefore be **incapable of failing the host scan**.
- Runtime product code issues **same-origin** requests, resolving the document's own origin through
  the browser-origin resolver rather than naming one.
- The proxy context is **segment-aware**: `^/api(?:/|$)`, not a plain `/api` prefix key.
- **No production API origin is invented** — real, placeholder, or derived from an environment
  variable. An env-dependent host is still an invented host.
- Reserved fixture origins are `*.example.test`, matching the convention already used across
  `packages/api-client` and `apps/extension`. RFC 6761 reserves `.test`, so such a value can never
  resolve to a real service.

### Fixture URL policy

**Permission to place text in a fixture and the verifier's expected verdict are different rules.** A
negative fixture is allowed to contain a real URL **precisely because** production output containing
it must be rejected — a blanket "all fixtures must use reserved domains" rule would make the
rejection tests unwritable and is therefore replaced by these four scopes.

| Fixture category | Location | Policy |
| --- | --- | --- |
| API origins / API-base configuration | `apps/web/src/test/fixtures.ts`, gateway and origin-resolver tests | The existing loopback and reserved-test-domain rules, plus the documented development-proxy exception |
| Artifact-verifier **positive** fixtures | `apps/web/src/test/build-output-fixtures/` | May contain the exact sanctioned values: the documented W3C namespace literals, the verified Tailwind banner, and the exact React diagnostic value in either permitted JavaScript literal form |
| Artifact-verifier **negative** fixtures | the same directory | May contain those real values **in forbidden contexts**, plus the near-match variants the tests need — changed paths, queries, fragments, altered banner contents, and **substituted template literals** carrying the React prefix |
| Other API-payload / provenance fixtures | schedule and provenance fixtures | Their existing data contract. A source-attribution URL **inside payload data is not an API destination** and is not governed by the origin rule |

- **First-party source guards must not reject the sanctioned verifier fixtures.** Check 1 scans
  `apps/web/src/**` with test files excluded, so `build-output-fixtures/` — test data by location and
  by name — is outside it. The verifier tests must be able to run at all.
- **That exclusion permits the fixtures to exist; it permits no production import of them.**
  [Check 1b, the production dependency guard](#the-production-dependency-guard), forbids any
  production entry from reaching a fixture, so a value that is legal *in* a fixture cannot become a
  production destination through one.
- These fixtures are **inert data** exercised through **deterministic local or fake transports**. They
  **never fetch a real website, perform DNS resolution, or depend on live API behaviour**.
- A fixture exception authorizes **nothing** in production: no production API destination, no shipping
  of test modules, and no skipping of emitted assets. **Prohibited fixture content that reaches
  production output is still rejected by the production verifier** — which is the point of the
  negative fixtures.
- No blanket exemption is granted to application source or to tests generally; each scope above stands
  on its own.

**The emitted-artifact verifier is an all-origin scan, not a denylist.** After a fresh production
build, it recursively reads every emitted HTML, JavaScript, and CSS asset under `apps/web/dist` and
detects absolute `http://` or `https://` occurrences in raw text and contextually decoded literal
values, per [contextual decoding](#contextual-decoding-before-url-matching). This includes escaped
scheme letters, colons and slashes, CSS escapes, and HTML character references. It reports the asset,
source location, and detected value, and **rejects every detected occurrence outside
[the four sanctioned categories](#the-four-sanctioned-categories)**. The **namespace** allowlist
starts empty for the application; implementation may add an entry only when a fresh build proves that
exact literal is emitted and documents why it is an identifier rather than a fetchable application/API
origin. No exception is a host exemption: none covers another path, query, port, or near-match.

**State the guarantee precisely.** It is **not** "no absolute URL bytes anywhere in `dist`". It is:
*the scan rejects every absolute HTTP(S) URL occurrence except
[the four sanctioned categories](#the-four-sanctioned-categories).* The looser phrasing is false the
moment a legitimate license banner, a pinned dependency's diagnostic link, or a dependency's
URL-parsing scaffold ships, and a guarantee that is false in the ordinary case gets switched off.

### Contextual decoding before URL matching

This is the canonical decoding contract for Check 2 and its deterministic fixtures. **Scan both raw
text and the values represented by its syntax**, keeping each candidate's original file, source
locator, and syntactic context. A locator is an AST/token range for JavaScript/CSS or a DOM path plus
attribute/text role for decoded HTML; DOMParser is not assumed to expose HTML byte offsets. Case-insensitive detection covers the scheme spelling `http://` or
`https://`, including an escaped letter, colon, or slash. Category matching remains exact: detection
does not lowercase paths, normalize a URL, remove ports, decode percent escapes, or widen an exemption.

| Asset/context | Required interpretation before matching |
| --- | --- |
| JavaScript (`.js`, `.mjs`, `.cjs`) | Reuse the declared TypeScript compiler API: a no-emit `Program` with `allowJs: true`, `checkJs: false`, the appropriate JavaScript source mode, `target: Latest`, and public `getSyntacticDiagnostics`. Visit the original AST. Inspect cooked `StringLiteral.text` and no-substitution-template text, and each static head/middle/tail of a substituted template; visit its expressions separately. Cooked `.text` is used directly, never unescaped a second time. Interpret JavaScript literal escapes once, including `\xHH`, `\uHHHH`, `\u{...}`, ordinary escapes, and line continuations. Verify the parser's cooked values on the fixtures below; never use a slash-only replacement or `JSON.parse` as a JavaScript-literal parser. |
| CSS | Reuse the approved `postcss` and `postcss-value-parser` dependencies to locate selectors, declaration names/values, at-rule names/parameters, strings, words, and `url(...)` values. Their raw value/prelude strings are **not proof of escape decoding**. Apply CSS Syntax's escaped-code-point and string-continuation rules to the relevant tokens, including one-to-six hex digits with optional terminating whitespace and escaped non-hex characters; then inspect the complete represented string or URL argument, not isolated punctuation nodes. The same decoding is used before resolving CSS dependency paths and directive/function names in Check 1b. |
| HTML | Use the standard typed `DOMParser` supplied by Vitest's already-declared `jsdom` environment, with script execution and subresource loading disabled. Inspect decoded attribute values and text, including template contents and recursively parsed `srcdoc`; retain raw-source inspection for comments. A URL such as `https&#58;&#47;&#47;api.example.test` therefore cannot hide in an attribute. Feed inline JavaScript and CSS, and decoded event/style attributes, to their respective contextual scanners. Decode an attribute as HTML first and its embedded language second; never repeatedly decode a value until it changes no further. |

The CSS decoder follows [CSS Syntax](https://drafts.csswg.org/css-syntax-3/#consume-escaped-code-point).
The inert HTML configuration follows [jsdom's defaults](https://github.com/jsdom/jsdom#executing-scripts).
Use DOM library types through `DOMParser`, not a direct `JSDOM` import requiring another type package.
Parse inline script text as JavaScript, event attributes as function bodies, and style attributes as
CSS declaration lists; any synthetic parsing wrapper retains a mapping to the original locator.
An HTML `srcdoc` value introduces another HTML layer. Nested parsing remains inert, and any parser or
resource-limit failure is reported explicitly rather than accepted.
These are uses of dependencies already listed by this task; no additional dependency is proposed.

Raw and decoded views of one source occurrence are associated before classification; a raw spelling
does not bypass or independently broaden its token's exemption. The React category compares the
**whole cooked literal** and its permitted context. A template segment or tagged template cannot gain
that exemption. The Tailwind category still requires the exact raw banner in a genuine CSS-asset
comment. The Zod category still requires its exact raw scaffold and AST context; an escaped scaffold
outside that raw shape is detected and rejected, not silently promoted into the exemption. Namespace
entries keep their exact decoded literal and non-network-use restrictions. Any separate forbidden
occurrence in the same asset still fails.

Malformed syntax, an unreadable asset, or an escape/context that cannot be interpreted unambiguously
is an explicit unresolved failure with its source locator. Nothing is executed: no `eval`,
`Function` constructor, bundle import, identifier resolution, arbitrary constant folding, or template
substitution evaluation. Raw template segments are also inspected; invalid/ambiguous cooked values
cannot be silently omitted. **This is a static literal-occurrence guarantee, not proof of every URL
that arbitrary runtime computation could assemble.** Same-origin request construction and
first-party source/boundary checks continue to enforce their own contracts. Check 1 uses this
JavaScript/CSS decoding for its first-party literal scan too, with its existing test exclusions and
**without importing Check 2's dependency exemptions**.

For Check 1's `.tsx` source, distinguish JavaScript literals from JSX text and quoted JSX attributes.
Use the TypeScript AST to identify those JSX contexts and inert HTML character-reference decoding
for their represented text; do not treat a JSX attribute as a JavaScript-escaped string. An encoded
React diagnostic URL in first-party JSX must fail Check 1 even though the emitted literal would
qualify for Check 2's context-specific exemption.

### The Tailwind license-comment exemption

Tailwind emits a retained license banner as the first bytes of every compiled stylesheet. It carries
the project's website URL, so the all-origin scan rejects it — while the namespace allowlist cannot
admit it, because it is a real website rather than a non-network identifier. Both mechanisms are
behaving correctly; the banner needs a **third, narrower** treatment.

**Preserve the banner.** Stripping a retained MIT license notice to satisfy our own scan would be
both a licensing problem and a scan configuring the artifact instead of checking it.

**Verified evidence, recorded rather than assumed:**

| Fact | Evidence |
| --- | --- |
| Pinned version | `tailwindcss: 4.3.3` and `@tailwindcss/vite: 4.3.3` in `pnpm-workspace.yaml`; `node_modules/.pnpm/tailwindcss@4.3.3` installed |
| Generator | `tailwindcss/dist/lib.mjs` — `` t.unshift(gt(`! tailwindcss v${yr} \| MIT License \| https://tailwindcss.com `)) `` with `yr="4.3.3"` |
| Emitted banner | `apps/extension/.output/chrome-mv3/assets/popup-CigTHy3A.css`, first line, byte-for-byte |

The observed banner, as emitted by the pinned toolchain:

```css
/*! tailwindcss v4.3.3 | MIT License | https://tailwindcss.com */
```

Note the leading `!` and the **trailing space** before `*/` — both are part of the generator's
template and therefore part of the exact match.

**The exemption is a comment-context exemption, separate from the exact platform-namespace
allowlist.** It is scoped as narrowly as it can be stated:

- it applies **only** to a genuine CSS **block-comment token** in an emitted **CSS** asset;
- the comment's **complete content** must match the documented banner above. A comment merely
  *containing* "Tailwind", "MIT", or the website URL does **not** qualify;
- **only the matched comment's own text range** is excluded from URL detection — not the asset, not
  the line, not the surrounding CSS;
- recognition must **distinguish CSS comments from quoted CSS strings** containing comment-like text;
- an **altered banner carrying an additional URL does not qualify**: the match is on the whole
  comment, so an extra URL makes it a different comment;
- **no other comment gains an exemption** from this change;
- the verifier stays **read-only**: it never rewrites an emitted asset and never strips a license
  notice;
- a **global URL replacement or blanket comment-stripping regex across HTML, JavaScript, and CSS is
  not an acceptable implementation** — that would blind the scan to prohibited URLs in every other
  comment in every asset type.

**`https://tailwindcss.com` is not added to any global URL or hostname allowlist, and is not
classified as a non-network namespace identifier.** It is a real website. Outside the sanctioned CSS
comment the same URL is still rejected — in JavaScript strings and template literals, HTML
attributes, CSS strings, `url(...)`, and `@import` — because the exemption is a property of *that
comment*, not of the host.

**A dependency update that changes the banner requires reviewing and updating the recorded evidence
and the fixtures**, not widening the pattern. The exact-match rule is what forces that review: a
version bump changes `v4.3.3` and the match fails loudly rather than drifting.

### The React diagnostic-literal exemption

React DOM's production error decoder builds a documentation link from a hard-coded prefix. The prefix
ships in every production bundle that imports `react-dom/client`, so the all-origin scan rejects it.
Neither existing category fits: it is a JavaScript string value, not a CSS comment, and it is a real
fetchable website, not a platform namespace identifier.

**Decision: sanction the exact prefix value in either permitted JavaScript literal form, and keep
React's production diagnostics intact.**

**Verified evidence, from the installed pinned dependency rather than upstream documentation:**

| Fact | Evidence |
| --- | --- |
| Pinned versions | `react: 19.2.8`, `react-dom: 19.2.8` in `pnpm-workspace.yaml`; `node_modules/.pnpm/react@19.2.8` and `react-dom@19.2.8_react@19.2.8` installed, both `package.json` `version: 19.2.8` |
| Source | `react-dom/cjs/react-dom-client.production.js`, in `formatProdErrorMessage`: `var url = "https://react.dev/errors/" + code;` |
| Emitted form | `apps/extension/.output/chrome-mv3/chunks/popup-DGIF6Q0T.js` — `` var t=`https://react.dev/errors/`+e `` . Bundling rewrote the source's double-quoted literal as a **no-substitution template literal**; the complete value is unchanged, and the concatenation stays outside it |
| Not in React core | `react/cjs/react.production.js` contains no `react.dev` literal; the prefix comes from `react-dom` |

The sanctioned value, complete and exact:

```text
https://react.dev/errors/
```

The error **code is concatenated at runtime** (`+ code`), and query arguments are appended with
`encodeURIComponent`. The emitted artifact therefore contains the **prefix only** — never a complete
hard-coded `…/errors/123`. That is precisely why an exact-equality rule is sufficient here and why a
prefix rule would be strictly weaker.

**Including this address in an error message performs no HTTP request.** React formats a string; a
person may choose to open it. The address is nevertheless a real, fetchable HTTPS URL, so it is
**not** classified as a platform namespace identifier and **not** as a license comment.

#### Exact matching rule

The verifier may exempt this value **only** when it is the **complete decoded value of an ordinary
string literal or a no-substitution template literal in an emitted JavaScript asset**. Both forms are
required because the pinned React source writes an ordinary double-quoted literal while the emitted
bundle above writes the identical value as a no-substitution template literal; a rule naming only one
of them rejects the artifact that actually ships.

The three permitted literal forms, with equivalent legal escape spellings decoded as specified:

```js
"https://react.dev/errors/"
'https://react.dev/errors/'
`https://react.dev/errors/`
```

- compare the **complete cooked value** after the full, one-pass JavaScript literal decoding in
  [contextual decoding](#contextual-decoding-before-url-matching), identically in all three forms;
- require **exact equality** with `https://react.dev/errors/`;
- **preserve the trailing slash** — it is part of the sanctioned value;
- **reject** additional path segments, query strings, fragments, or any surrounding text;
- **no** hostname-wide, origin-wide, substring, or prefix matching;
- **no** URL normalization that would discard a meaningful difference;
- **continue scanning every other URL occurrence in the same asset.**

**A template literal qualifies only when it has no substitution at all.** A template containing any
`${…}` is outside this exemption, and **an individual segment of a substituted template never
qualifies** merely because that segment's text equals the prefix — including when the substitution
is the last thing in the template, and including when it could evaluate to an empty string. The
verifier **evaluates no JavaScript and folds no constants**: eligibility is decided from the literal
as written, because anything else would make the exemption depend on reasoning the scanner cannot
perform soundly.

"Ordinary string literal or no-substitution template literal" is the exact scope. It is deliberately
**not** "any static expression": a concatenation, `String.raw`, tagged template, variable or member
access is never evaluated to obtain an exempt value. An individual complete matching literal operand
in React's documented `prefix + code` expression still qualifies as that literal; the concatenation
as a whole receives no exemption.

Not permitted: all of `https://react.dev`, all `/errors/*` addresses, or all URLs originating from
dependencies. **The same text in HTML or CSS receives no React exemption** — the exemption is a
property of the complete value of one of the three permitted JavaScript literal forms.

**Not permitted as alternatives:** patching React, removing production diagnostics, switching to a
development React build, or relying on tree-shaking to drop code that the required production import
retains.

### The Zod IPv6 URL-parsing scaffold exemption

Zod validates an IPv6 literal by **parsing** it, not by fetching it: `new URL()` is the only
WHATWG-conformant host parser a browser exposes, and a bracketed IPv6 host is only parseable inside a
URL. The `http://` prefix is scaffolding the parser requires; the constructed object is discarded and
no request is made. The all-origin scan nevertheless detects `http://[` as an absolute HTTP(S)
occurrence, and none of the three existing categories fits: it is neither a namespace identifier, nor
a CSS license comment, nor a complete literal value.

**Verified evidence, read from the installed pinned dependency and real emitted output.**

| Fact | Evidence |
| --- | --- |
| Pinned version | `zod: 4.4.3`; `node_modules/.pnpm/zod@4.4.3/node_modules/zod/package.json` → `"version": "4.4.3"` |
| Source, `ipv6` | `zod/src/v4/core/schemas.ts:812`, inside `$ZodIPv6`'s `inst._zod.check`: `` new URL(`http://[${payload.value}]`); `` wrapped in `try { … } catch { payload.issues.push({ code: "invalid_format", format: "ipv6", … }) }` |
| Source, `cidrv6` | `zod/src/v4/core/schemas.ts:898`, inside `$ZodCIDRv6`'s `inst._zod.check`: `` new URL(`http://[${address}]`); `` after the prefix-length checks, in the same `try`/`catch` shape with `format: "cidrv6"` |
| Emitted form 1 | `apps/extension/.output/chrome-mv3/background.js` and `chunks/popup-DGIF6Q0T.js`: `` …e._zod.bag.format=`ipv6`,e._zod.check=n=>{try{new URL(`http://[${n.value}]`)}catch{n.issues.push({code:`invalid_format`,format:`ipv6`,… `` |
| Emitted form 2 | the same two assets: `` …if(`${n}`!==t\|\|n<0\|\|n>128)throw Error();new URL(`http://[${e}]`)}catch{n.issues.push({code:`invalid_format`,format:`cidrv6`,… `` |
| Reachability | Both `apps/extension` and `packages/api-client` import `z` from the **root `zod` barrel**, which carries the classic string-format surface. No first-party code calls `.ipv6()` or `.cidrv6()` — `rg` finds no occurrence outside `node_modules` — yet the extension's Vite build **retained both**, despite the `/*@__PURE__*/` annotation on each `core.$constructor(…)` |

**What this evidence does and does not establish.** It establishes the exact emitted syntax, its
purpose, and that a Vite production build of a first-party workspace in this repository keeps it. It
does **not** establish that the `apps/web` bundle contains it: `apps/web` is currently a stub —
`README.md` and `package.json` only — so **no web build exists and none was produced in this
documentation session.** The forms are *expected* to appear, for the same barrel import through the
same bundler family, but that is a prediction. **The first fresh `apps/web` production build decides
it**, and the handoff records what was actually found. If they are absent, this category simply never
matches and nothing is weakened.

#### What is permitted, exactly

The exemption is **not** for `new URL`, not for `http://` prefixes, not for dynamic templates, and
not for `zod` as a package. It is for one fixed shape:

```js
new URL(`http://[${IDENTIFIER_PATH}]`)
```

- **Static segments, byte-exact:** `` new URL(` `` then `http://[`, then the single substitution, then
  `` ]`) ``. **Nothing else** may appear inside the template — no additional characters, path, port,
  query, fragment, or second static run.
- **Exactly one substitution**, and it spans the entire bracketed host. Zero substitutions, two or
  more, or a substitution that covers only part of the host all fall outside.
- **Interpolation structure:** the text between `${` and `}` must match
  `/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/` — a single identifier, optionally followed by
  dot-separated property names. That admits the observed `e` and `n.value` and **survives minifier
  renaming**, because any renamed identifier still matches the same shape. It admits **no** call,
  operator, index, template, conditional, or nested substitution.
- **Enclosing syntactic context:** the construction must be a **discarded expression** — no
  assignment, `return`, `await`, or member access on the result — and must sit inside a
  `try { … } catch` block, within a bounded window of the match. This is exactly the observed shape at
  both sites and is what distinguishes a parse-and-discard validation from any use of the value.

**Boundary.** The exemption covers **that occurrence only**. Another URL in the same expression, the
same statement, or anywhere else in the same asset is still classified normally, and the scan
continues through the whole asset. The exemption is not a host allowlist: no other address on any
host inherits it, and the same template used as an argument to `fetch`, `XMLHttpRequest`, `Request`,
`navigator.sendBeacon`, `importScripts`, or an assignment to `location`/`src`/`href` is **rejected**.

#### How the verifier recognizes it, with the toolchain it actually has

**Reuse the declared TypeScript parser; no new parser dependency is added.** The output scanner uses
the JavaScript AST and public syntactic diagnostics from
[contextual decoding](#contextual-decoding-before-url-matching). It does not maintain a second,
hand-written JavaScript lexer or guess whether a slash means division or a regular expression.

1. Find a real `NewExpression` whose constructor is `URL` and whose sole argument has the exact
   raw template and identifier-path shape specified above.
2. Require that constructor to be the discarded expression of an `ExpressionStatement` inside the
   try block of an enclosing `TryStatement` with a catch clause. A constructor in the catch/finally
   block, assigned, returned, awaited, or member-accessed does not qualify.
3. Compare the original source span with the canonical scaffold restrictions. Comments and strings
   containing source-looking text are not constructor nodes and cannot qualify.
4. Continue scanning the whole asset. A syntax diagnostic or unsupported context is an unresolved
   failure, not a reason to skip that asset or add an exemption.

**Nothing is evaluated.** Recognition uses emitted syntax and source spans only; it does not execute
bundle code, resolve identifiers, constant-fold, or infer what a substitution produces at runtime.

**A URL-parsing constructor is not a network request — and that alone is not the justification.** The
grounds are the *specific validated use* read from the pinned source above: a bracketed-host parse
whose result is discarded inside a validation `try`/`catch`. A different `new URL(…)` argument, even
one that also performs no request, is outside this category.

#### The four sanctioned categories

| Category | Matching rule |
| --- | --- |
| Platform namespace identifiers | Existing explicitly documented **exact literals** |
| Tailwind license banner | Existing verified **CSS-comment-context** exemption — only inside a genuine CSS block comment |
| React error-decoder prefix | **Exact complete decoded value** `https://react.dev/errors/` of an ordinary string literal or a no-substitution template literal, with its existing context restrictions |
| Zod IPv6 URL-parsing scaffold | The **exact `` new URL(`http://[${IDENTIFIER_PATH}]`) `` shape** in ordinary code inside a validation `try`/`catch`, described above |

**Every other absolute HTTP(S) URL occurrence remains subject to rejection.** This table is the
canonical enumeration; other sections reference it rather than restating a partial list.

#### This exemption grants the application nothing

**It is an artifact-audit accommodation for a pinned dependency.** It does **not** authorize
first-party application code to use that address as an API base URL, a configurable origin, or any
network destination. Those restrictions are enforced independently, and the emitted-literal allowlist
is explicitly **not** the guard that enforces them:

| Guard | Owns |
| --- | --- |
| Check 1 — `apps/web/src/**` source scan, tests excluded | Rejecting **any** hard-coded absolute API origin in first-party production source, including this one |
| Check 1b — [production dependency guard](#the-production-dependency-guard) | Rejecting any production-entry path that *reaches* an excluded test or fixture module, so check 1's exclusion cannot be imported around |
| The web gateway contract | Same-origin API requests built from the resolved document origin, and `cache: 'no-store'` |
| Check 2 — emitted-output scan | Auditing what shipped; it exempts exactly [the four sanctioned categories](#the-four-sanctioned-categories) and nothing more |

**An exact-literal output allowlist cannot distinguish dependency provenance** from first-party use of
an identical string, and cannot detect every possible runtime use of that string. That is not a defect
in the scan; it is why the source-level guard and the gateway contract exist and must keep their own
independent enforcement. **No requirement is introduced to reconstruct package ownership from
arbitrary minified JavaScript** — that is not feasible and this policy does not depend on it.

#### Dependency baseline inventory

Every HTTP(S) literal observed in the available emitted output and in the installed pinned dependency
code, classified against the policy. Recorded so no value is silently absorbed later.

| Observed value | Source | Classification |
| --- | --- | --- |
| `https://react.dev/errors/` | `react-dom` 19.2.8 | **React diagnostic exemption** (this section) |
| `http://www.w3.org/2000/svg` | `react-dom` | Platform namespace identifier — exact-literal allowlist |
| `http://www.w3.org/1999/xlink` | `react-dom` | Platform namespace identifier |
| `http://www.w3.org/1998/Math/MathML` | `react-dom` | Platform namespace identifier |
| `http://www.w3.org/XML/1998/namespace` | `react-dom` | Platform namespace identifier |
| `https://json-schema.org/draft/2020-12/schema` | `zod` 4.4.3 `to-json-schema` | JSON Schema **dialect identifier** — see below |
| `http://json-schema.org/draft-07/schema#` | `zod` | Dialect identifier |
| `http://json-schema.org/draft-04/schema#` | `zod` | Dialect identifier |
| `/*! tailwindcss v4.3.3 … */` banner URL | `tailwindcss` 4.3.3 | Tailwind license-comment exemption |
| `` new URL(`http://[${n.value}]`) `` — `ipv6` | `zod` 4.4.3 `$ZodIPv6` | [Zod IPv6 URL-parsing scaffold exemption](#the-zod-ipv6-url-parsing-scaffold-exemption) |
| `` new URL(`http://[${e}]`) `` — `cidrv6` | `zod` 4.4.3 `$ZodCIDRv6` | Same exemption |

Both Zod rows are observed in the **extension** output. Whether they appear in `apps/web`'s bundle is
**unconfirmed** — that workspace is a stub and no web build exists — and the first fresh build
records the answer either way.

**The `json-schema.org` values need a decision at first build, and the existing mechanism already
provides one.** `zod`'s main entry re-exports `toJSONSchema` (`v4/classic/external.js` →
`v4/core/json-schema-processors.js`), and the extension's emitted popup chunk proves those literals
are **not** tree-shaken there. `apps/web` reaches `zod` through `@abfall-radar/api-client` and never
calls `toJSONSchema`, so whether Vite drops them in **this** build is unknown until a fresh build
exists.

They are `$schema` **dialect identifiers** — canonical names for a schema dialect, the same shape of
thing as an XML namespace — and so they fit the **existing platform-namespace category**, whose
documented process is exactly this: the allowlist starts empty, and an exact literal is added only
after a fresh build proves it is emitted and the handoff records why it is an identifier rather than a
fetchable application origin. **They are deliberately not pre-authorized here**, because no fresh
`apps/web` build exists to prove emission. **No new category is created for them**, and fixing React
does not imply they are covered.

**Extension assets are toolchain evidence, not proof about the web build.** They show what these
pinned dependencies emit; they do not establish that `apps/web` or its verification tasks pass. The
[handoff](#handoff-workflow) requires reporting every occurrence detected in the first fresh
`apps/web` production build, classifying each HTTP(S) occurrence against
[the canonical emitted-URL policy table](#the-four-sanctioned-categories) — exact required platform
namespace literals, the narrowly defined Tailwind license-comment exception, the exact React
diagnostic-literal exception, and the narrowly defined Zod IPv6 scaffold exception — **or as an
unresolved occurrence**. Each category keeps its own syntax, context, and matching restrictions, and
**no occurrence is assumed to belong to an allowed category**: anything that does not match one is a
forbidden occurrence and fails the check.

The production application has no legitimate hard-coded network destination. Runtime source
attribution links are validated API data and do not justify an emitted hard-coded origin. Test
fixtures may contain reserved origins specifically to prove rejection and are never copied into
production output.

**Enforcement is five deterministic checks — three negative, two positive** — and they distinguish
production application source and output from the approved development proxy configuration. Check 2
runs in the **emitted-artifact verifier**, never in the ordinary test suite; see
[Build and verification ordering](#build-and-verification-ordering). This count is about **checks**
and is unrelated to [the four sanctioned emitted-URL categories](#the-four-sanctioned-categories).

1. `apps/web/src/**`, **test files and `src/test/` fixture data excluded**, contains no absolute API
   origin — the exclusion is what lets the sanctioned verifier fixtures exist at all, per
   [Fixture URL policy](#fixture-url-policy);
1b. **no production entry reaches an excluded test or fixture module**, per
   [the production dependency guard](#the-production-dependency-guard) — the rule that keeps check 1's
   exclusion from becoming a hole;
2. the fresh production build output contains **no absolute HTTP(S) URL occurrence** outside the
   [four sanctioned categories](#the-four-sanctioned-categories). This catches loopback, fabricated
   hosts, and unrelated origins without maintaining a selected-host denylist;
3. `vite.config.ts` contains **exactly** the proxy target `http://127.0.0.1:3000` — a positive
   assertion, so the development path cannot drift to `localhost`, another port, or an unreviewed
   host;
4. the proxy context is exactly **`^/api(?:/|$)`**, asserted against the resolved configuration and
   exercised against both the matching paths and the near misses a prefix key would capture.

Check 1 does not read `vite.config.ts`, fixtures, or documentation. The output scan recursively reads
only the fresh emitted HTML, JavaScript, and CSS assets and reports each offending asset/value.

### The production dependency guard

**Check 1's exclusion is a hole unless reachability is also guarded.** Check 1 skips `src/test/` so
the verifier fixtures can legally hold real sanctioned values. Nothing in the remaining checks stops
production code from *importing* one:

```ts
// apps/web/src/adapters/schedule-gateway.ts — the bypass this guard closes
import { REACT_DIAGNOSTIC_PREFIX } from '@/src/test/build-output-fixtures/react';
```

Check 1 never sees the literal, because it lives in an excluded file. Check 2 sees the emitted value
and **exempts** it, because `https://react.dev/errors/` is a sanctioned category. A prohibited
production use would ship with every check green. The same holds for any exact allowlisted namespace
literal.

**An emitted-URL exemption is a statement about artifact audit, never about source provenance.** The
categories are unchanged, unbroadened, and not the mechanism that resolves this; a source-graph rule
is.

#### What the guard asserts

**No admitted production input may reach a protected test or fixture file.** The closed
HTML/build-entry check precedes the script/CSS graph walk.

| Element | Definition |
| --- | --- |
| **Production entries** | The complete `apps/web/index.html`, admitted only by [the closed source-shell check](#the-html-entry-has-a-closed-source-shell), followed by its sole `/src/main.tsx` edge. Additional HTML resources, public-directory copying, and alternate entry inputs are rejected by that check before script traversal |
| **Protected boundaries** | `apps/web/src/test/**` in full — including **`apps/web/src/test/build-output-fixtures/**`** — plus every `*.test.ts`, `*.test.tsx`, and `*.spec.ts`/`*.spec.tsx` module anywhere under `apps/web/src/**` |
| **Edges walked** | the sole admitted HTML module-script edge, then static `import`/`export … from`, side-effect `import '…'`, **barrel re-exports** (`export * from`, `export { x } from`), and `import()` whose specifier is a **string literal or a no-substitution template literal**. Intermediary modules count: the violation is reachability, not adjacency. See [parser-based import extraction](#import-extraction-is-parser-based-not-regex-and-line-stripping) |
| **Rejected dependency-producing forms** | **`new URL(…, import.meta.url)`** anywhere in a production-reachable first-party or workspace script — standalone, or **nested inside `new Worker(…)` or `new SharedWorker(…)`** — is an **unsupported form and fails the check**. Vite turns it into a bundled asset or worker entry, so it loads a file with no `import` edge. It is rejected whatever its first argument is and **without** resolving the referenced file. See [URL dependency forms](#url-dependency-forms-are-rejected) |
| **Resolution** | the same rules the production build uses, for **four** dependency classes — see [package and workspace resolution](#package-and-workspace-resolution). Local and aliased files use the **`@/` alias resolving to the `apps/web` workspace root**, identically in `vite.config.ts`, `tsconfig.json`, and `vitest.config.ts`, plus directory `index` resolution and the TS/TSX candidates; a Vite **query suffix** (`?raw`, `?url`, `?worker`, `?inline`) is stripped before resolving. Each resolved path is then classified by [the dependency-classification order](#classifying-a-resolved-dependency), which checks protected boundaries **before** any kind-specific handling |
| **Judgement** | by the **resolved absolute path**, never by whether the specifier text contains "test" or "fixture". A production-looking wrapper, an alias, a re-export barrel, or a renamed directory changes nothing if the resolved file lies inside a protected boundary |
| **Diagnostic** | the forbidden **resolved target** and the **complete import chain** from the production entry to it, each step as `importer → specifier → resolved`, so the fix is obvious from the failure message |

**Test and verifier entries keep their fixtures.** The guard walks **only** from production entries.
Walks that begin in a test file, in the verifier, or in `src/test/` are outside it, and a fixture
importing another fixture is unaffected.

#### The HTML entry has a closed source shell

**AR-005 rejects additional HTML build inputs.** Before following any script edge, Check 1b reads
`apps/web/index.html` in full and compares it with this fixed source template.

> **Amended** by [ADR 0005 addendum 3](../decisions/0005-addendum-3-audited-favicon.md) (2026-09-19):
> the template gains **one** resource link, the favicon, referenced from inside `src/` so Vite resolves,
> hashes and emits it like every other shipped output. `publicDir: false` remains in force and no public
> directory exists. The amended template is:
>
> ```html
> <!doctype html>
> <html lang="de">
>   <head>
>     <meta charset="UTF-8">
>     <meta name="viewport" content="width=device-width, initial-scale=1">
>     <link rel="icon" type="image/svg+xml" href="/src/assets/favicon.svg">
>     <title>AbfallRadar</title>
>   </head>
>   <body>
>     <div id="root"></div>
>     <script type="module" src="/src/main.tsx"></script>
>   </body>
> </html>
> ```
>
> Everything below still holds, with one exception named there: the favicon's icon link. A **second**
> icon link, any other resource link, and every other construct in the list remain rejected, and the
> emitted asset is audited with the outputs it ships beside — exactly one icon link in the emitted HTML,
> pointing at a hashed asset that exists, is the only image in the build, and whose only absolute URL is
> the SVG namespace name.

The original template of the first slice, retained as the record of that decision:

```html
<!doctype html>
<html lang="de">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>AbfallRadar</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

The comparison allows CRLF-to-LF conversion and the presence or absence of the final LF only.
It does not strip comments, decode entities, remove tags or attributes, or compare only a selected
DOM subtree. The expected template is an independent test constant transcribed from this contract,
never generated from the file being checked. The canonical template must also pass the repository's
applicable formatter check; a required formatting-only adjustment updates this template and its
constant together without changing any element, attribute, value, or text.

Consequently an added stylesheet/preload/icon link, image or `srcset`, media source, iframe or
`srcdoc`, object, SVG resource reference, `base`, template, inline script/style, event attribute,
import map, second module script, changed entry path, or entity-encoded spelling is rejected as an
unsupported HTML source shell. No HTML parser dependency or general HTML resource walker is required.

Since [addendum 3](../decisions/0005-addendum-3-audited-favicon.md), the single favicon icon link above
is part of the template rather than an addition to it; every other item in this list is unchanged, and a
further icon link is still rejected.
The reported file and first differing source location identify the rejection; fixture contents are
irrelevant. HTML introduces exactly one permitted edge:
`index.html → /src/main.tsx → apps/web/src/main.tsx`. The normal script/CSS traversal owns everything
after it. A future HTML resource requires an explicit contract and guard change before admission.

**Close the other build-entry channels in the same source check.** The web build script is
`vite build` with no CLI entry/config override. Assert the production-resolved Vite root is
`apps/web`, `publicDir: false`, library mode is disabled, and no custom
`build.rollupOptions.input` adds or replaces the default `index.html` entry. No custom asset-copy,
HTML-transform, or file-emission plugin/hook is introduced; application-configured plugins remain the
documented React and Tailwind integrations. Check those declarations and the resolved entry settings,
rather than merely documenting their intended values. Vite's built-in plugins and the declared
third-party integrations remain the stated dependency trust boundary. This is not an audit of their
internals or of an externally modified build command.

The source-shell comparison runs in the ordinary boundary suite and reads no `dist`. It must **not**
be applied to emitted HTML: Vite legitimately rewrites the entry script and adds generated stylesheet
and module-preload links. The post-build verifier checks that output separately, including the
existing language/viewport assertion and contextual URL inspection.

#### Tree-shaking is not evidence

**An emitted bundle containing no identifiable fixture module does not show the boundary was
respected.** A bundler inlines an imported constant and erases the module that held it, and a
minifier removes the name; the value ships while the provenance disappears. That is precisely the
case this guard exists for, so it is a **source-graph** rule evaluated before and independently of any
build, and no bundle inspection may be substituted for it.

#### Import extraction is parser-based, not regex-and-line-stripping

**The extension walker's text preprocessing is unsafe for this guard and is not reused.**
`withoutCommentLines` drops every line whose trimmed text begins with `//`, `/*`, or `*`. Run against
the real function, a valid protected import **disappears before extraction**:

| Source | What survives preprocessing |
| --- | --- |
| `` /* c */ import '@/src/test/build-output-fixtures/react'; `` | `""` — the whole line is gone |
| a block comment whose **closing line** carries the import | only the comment's interior text |

The guard would pass while the production build still pulled the fixture in — the exact bypass this
check exists to close. `specifiersOf`'s regex is unsafe for the same reason in the other direction: it
cannot tell an import from import-shaped text inside a string.

**Decision: parse the source with the TypeScript compiler API.** A real AST treats **comments as
trivia** — never deleted lines — and never rewrites string or template contents. Import-like text
inside a comment or an ordinary string simply is not an import node, so both failure directions close
at once.

**Availability, checked rather than assumed.** `typescript` is a **declared** dependency, not merely
hoisted: it is a root `devDependency` at `catalog:` → **5.9.3** in `pnpm-workspace.yaml`, and every
workspace that typechecks declares it in its own `devDependencies` — `apps/extension`, `apps/api`,
`packages/domain`, `packages/api-client`, `packages/ui`, `packages/data-providers`.
[The dependency table](#manifest-and-dependency-changes) **already** lists `typescript` as an
`apps/web` `catalog:` devDependency for `typecheck`, so the guard adds **no** new dependency, and
`require.resolve('typescript')` succeeds from inside a workspace today. It is usable from the planned
entry point, which is an ordinary `apps/web` Vitest test running in Node.

**Syntax validity comes from a `Program`, through public API only.** Two facts were read from the
pinned `typescript@5.9.3` declarations at
`node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/typescript.d.ts` rather than assumed:

- **`SourceFile.parseDiagnostics` is not public** — it appears nowhere in that declaration file, so
  reaching it needs an unchecked cast, which this guard must not do;
- **`Program.getSyntacticDiagnostics(sourceFile?, cancellationToken?):
  readonly DiagnosticWithLocation[]`** is public (`:6041`), as is
  **`Program.getSourceFile(fileName: string): SourceFile | undefined`** (`:5985`).

**A recovered AST is not proof of valid syntax.** Checked against the pinned build: parsing
`/* c */ import '@/x'; const = ;` yields a `SourceFile` and **throws nothing**, while
`getSyntacticDiagnostics` on it returns **1** diagnostic. Treating "we got an AST" as "the file
parsed" would therefore let malformed production source through with a partial import list.

**The extraction contract.**

1. **Build one `ts.Program`** over the scoped script files with
   `ts.createProgram(rootNames, options)`, `options` carrying **`noEmit: true`**, `jsx:
   ts.JsxEmit.ReactJSX`, and `target: ts.ScriptTarget.Latest` — matching the workspace's parser modes
   for `.ts` and `.tsx`. **No file is emitted.**
2. **Obtain each source file with `program.getSourceFile(fileName)`.** A `undefined` result means the
   file is missing or unreadable and **fails the check**, naming the file — it is never treated as a
   module with no imports.
3. **Require zero syntactic diagnostics.** Call `program.getSyntacticDiagnostics(sourceFile)`; a
   non-empty result **fails the check**, reporting the file and the formatted diagnostics. Only the
   **syntactic** set is required — semantic and type diagnostics are **not** substituted for it, since
   this guard checks dependencies, not types.
4. **Extract from that same AST, over the original source** — no preprocessing, no line filtering, no
   string rewriting. Collect a specifier from exactly these nodes: `ImportDeclaration` (including
   side-effect `import '…'`), `ExportDeclaration` with a `moduleSpecifier` (covering `export * from`
   and `export { x } from`), and a `CallExpression` whose expression is `SyntaxKind.ImportKeyword`.
5. **Permitted dynamic-import arguments** are a `StringLiteral` and a
   `NoSubstitutionTemplateLiteral`. Their `.text` is the specifier.
6. **Reject unresolved computed dynamic imports.** A dynamic import whose argument is anything else —
   an identifier, a concatenation, a `TemplateExpression` with substitutions, a conditional — is
   **rejected as unresolved** and fails the check under the existing production-source policy. The
   guard **never evaluates** the expression.
7. **Unsupported forms are rejected, not skipped**: `import.meta.glob` or any other wildcard loader on
   a production-entry path, `require` in any form, and
   [`new URL(…, import.meta.url)`](#url-dependency-forms-are-rejected) fail the check explicitly.

**No internal member is touched, no type error is suppressed, and no emit is required.** If a future
TypeScript version removes one of these public members the guard fails to compile, which is the
intended way to find out.

#### URL dependency forms are rejected

`new URL('./asset.svg', import.meta.url)` is how Vite loads a file **without** an `import`: the build
rewrites it into a hashed asset URL, and wrapped in `new Worker(…)` or `new SharedWorker(…)` it becomes a
separate bundled worker entry. Neither produces an `ImportDeclaration`, an `ExportDeclaration`, or an
`import()` call, so an import-only walker would never see a protected SVG or worker loaded this way.
**AR-005 does not need this form, so it is rejected rather than traversed.**

**Detection is an AST visit over the original source, not a pattern match.** The extractor already
walks the whole tree with the public `ts.forEachChild` (`typescript.d.ts:9191`); it additionally
inspects every **`NewExpression`**, however deeply nested:

1. **unwrap syntax-only wrappers** with an explicit loop over the public guards
   `isParenthesizedExpression`, `isAsExpression`, `isSatisfiesExpression`, `isNonNullExpression`, and
   `isTypeAssertionExpression`. `ts.skipOuterExpressions` is **not** in the public declarations and
   must not be reached for;
2. the unwrapped callee is the **identifier `URL`**;
3. there are **at least two arguments**, and the unwrapped second argument is a
   `PropertyAccessExpression` named **`url`** whose unwrapped object is a **`MetaProperty`** with
   `keywordToken === SyntaxKind.ImportKeyword` and `name.text === 'meta'` — that is, `import.meta.url`.

A match is **rejected regardless of the first argument** — a `StringLiteral`, a
`NoSubstitutionTemplateLiteral`, or any computed expression. Nothing is evaluated, and the referenced
file is **not** resolved: rejection does not depend on whether it exists or where it lies. Because
detection works on AST nodes, `new URL(…, import.meta.url)` appearing inside a comment or an ordinary
string is **not** a `NewExpression` and creates nothing.

**The diagnostic reports** the file and line and column of the expression, the unsupported
expression's source text, and the **production-entry chain** that made that file reachable, in the
same `importer → specifier → resolved` form as every other rejection.

**This restriction is narrow.** Ordinary URL parsing — `new URL('https://…')`, `new URL(path, base)`
with no `import.meta.url` — is unaffected. The third-party traversal boundary is unchanged: a
third-party package's internals are still not parsed. The four emitted-URL categories keep their
existing contracts.

**Checked against the pinned `typescript@5.9.3`.** A probe over the original source found exactly five
matches — `new URL("./a.svg", import.meta.url)`; `new URL(/* c */ \`./b.svg\`, (import.meta.url as
string))`; `new URL(name, import.meta!.url)`; and the URLs nested in `new Worker(…)` and
`new SharedWorker((… satisfies URL))` — and **none** for the same text inside a `//` comment or a
string literal, `new URL("https://example.test/x")`, or `new URL(path, base)`.

#### Classifying a resolved dependency

The production graph legitimately contains **non-script** edges: `apps/web/src/main.tsx` side-effect
imports `apps/web/src/app/styles.css`, which itself `@import`s Tailwind and the shared UI stylesheet.

**Terminating at the first stylesheet does not enforce the fixture prohibition.** This chain reaches a
protected fixture while every script edge looks clean:

```text
main.tsx → src/app/styles.css → @import → src/test/build-output-fixtures/banner.css
```

The guard must therefore follow CSS dependencies too. The order is fixed, and the protected-path check
comes **before** any leniency:

1. **Resolve** the specifier by the resolution rules applicable to its kind — for local and aliased
   scripts, relative or `@/`-aliased with `.ts`/`.tsx`/`index` candidates and the Vite query suffix
   stripped; for bare specifiers,
   [package and workspace resolution](#package-and-workspace-resolution) under production browser
   conditions; for stylesheets, [the CSS rules below](#extracting-css-dependencies).
2. **Check the resolved absolute path against the protected boundaries.** A match is a **violation**,
   whatever the file's kind or contents. **A protected fixture is rejected because production reached
   its resolved path** — not because of what is inside it. A fixture with **no URLs at all**, one
   holding an otherwise **sanctioned** namespace or React diagnostic value, and one containing
   ordinary harmless CSS are **all** rejected identically. An emitted-output exemption is an
   artifact-audit statement and is **never** permission to import a fixture.
3. **Classify** the surviving resolved path by kind.
4. **`.ts` / `.tsx` → traverse** as a script module, under the AST extraction and public
   syntax-diagnostic contract above. This includes a **workspace package's** resolved TypeScript
   source; a **third-party** target is recorded and stopped at instead, per the trust boundary.
5. **`.css` → traverse recursively**, extracting its own dependencies per
   [Extracting CSS dependencies](#extracting-css-dependencies). A stylesheet is **not** a leaf.
6. **A genuine leaf resource** — a `url(...)` target the build processes, such as an image or font —
   is checked against the protected boundaries **before** traversal terminates, then recorded and
   stopped at. Leaf status never precedes the boundary check.
7. **Anything else — another extension, an unstripped query suffix, an unresolvable specifier, or an
   unsupported dependency-producing form inside the guard's scope — fails the check explicitly**,
   naming the importer, the specifier, and the resolved path when there is one. **Nothing unknown is
   silently accepted**, and adding a kind is a deliberate edit to this list.

**One visited set spans the whole graph**, keyed by resolved absolute path and shared across script
and CSS edges, so a repeated import or an `@import` cycle terminates deterministically. Marking a file
visited must **not** skip other edges: every edge is still classified and boundary-checked before the
visited set short-circuits traversal *into* an already-walked file. Rejection diagnostics carry the
complete chain from the production entry, each step as `importer → specifier → resolved`, crossing the
script/CSS boundary intact — the reported bypass must be reported as all three steps, not as one
anonymous CSS failure.

#### Tailwind content discovery

**Import traversal does not cover Tailwind's class scan, and this is a separate check.** Tailwind reads
source files to find utility candidates without any `import` edge, so a protected fixture that nothing
imports can still contribute generated CSS. Left on, **automatic source discovery** scans the project
tree — including `apps/web/src/test/**` and colocated tests — and a unique utility class written only in
a fixture would ship in production CSS while the dependency guard passes. Tailwind content discovery is
therefore closed explicitly.

**Evidence from the installed `tailwindcss@4.3.3`** (`dist/lib.js`): an `@import` parameter starting
`source(` is parsed, and the value `none` is accepted as a distinct case; `@source` accepts a leading
`not ` and an `inline(…)` form; `@source` paths **must be quoted**; and sources resolve from the
stylesheet's own base. `packages/ui/src/styles.css` was read in full: it contains **no** `@source`,
**no** `@import "tailwindcss"`, and **no** `source(…)` setting, so today it cannot re-enable discovery.

**The canonical web stylesheet**, `apps/web/src/app/styles.css`. Every path resolves **relative to
this file's directory**, `apps/web/src/app/`:

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

| Directive | Resolves to | Purpose |
| --- | --- | --- |
| `source(none)` | — | **Disables automatic discovery.** Only explicit registrations are scanned |
| `@source "../../index.html"` | `apps/web/index.html` | Registered unconditionally: a file with no candidates emits nothing, and registering it prevents a later class in the document from silently rendering unstyled |
| `@source ".."` | `apps/web/src` | The web application's production sources — **a broad positive directory**, acceptable only because the exclusions below remove every protected descendant |
| `@source "../../../../packages/ui/src"` | `packages/ui/src` | The shared primitives, so `BrandMark` and `WasteIcon` utilities reach the web build |
| `@source not "../test"` | `apps/web/src/test/**` | Excludes the whole protected fixture tree, including `build-output-fixtures/` |
| `@source not "../**/*.{test,spec}.{ts,tsx}"` (four directives) | colocated tests under `apps/web/src` | Excludes every colocated test and spec |
| `@source not "../../../../packages/ui/src/**/*.{test,spec}.{ts,tsx}"` (four directives) | colocated tests under `packages/ui/src` | Equivalent exclusions for the scanned shared-UI tree. None exist today; the exclusions keep a future one out |

The brace forms in the table are shorthand; the stylesheet spells each of the eight exclusions out as
shown.

**What the content-discovery check asserts**, separately from import traversal:

1. the canonical stylesheet's `@import "tailwindcss"` carries **`source(none)`**;
2. every `@source` and `@source not` directive is enumerated from **the canonical stylesheet and every
   stylesheet it imports**, using the same `postcss` parse as the dependency guard, with each path
   resolved **relative to the stylesheet containing it**;
3. **no imported workspace stylesheet** adds a positive `@source`, imports `tailwindcss`, or sets
   `source(…)` — an imported stylesheet must not widen or re-enable what the entry closed;
4. the positive registrations are **exactly** the three documented ones, so an added registration
   fails rather than silently widening the scan;
5. the **effective scanned file set** is computed by expanding every positive registration and
   subtracting every exclusion, using Node's built-in `fs.globSync` — present on the pinned Node 24
   (`engines.node` is `>=24 <25`), so no glob dependency is added;
6. **no file in that effective set** lies in `apps/web/src/test/**` or matches `*.test.ts`,
   `*.test.tsx`, `*.spec.ts`, or `*.spec.tsx` under `apps/web/src` or `packages/ui/src`. This is a
   check on **files**, not on a glob's base directory.

This check runs in the same mandatory source-guard path as the dependency guard. The **emitted-CSS**
half of the proof runs in the existing post-build verification stage — see
[Tailwind content-discovery tests](#tailwind-content-discovery-tests).

#### Package and workspace resolution

`apps/web/src/main.tsx` imports `react-dom/client`; modules under `src/adapters/` — and only those —
import `@abfall-radar/api-client`; and application modules import `@abfall-radar/domain`,
`@abfall-radar/ui`, and `@abfall-radar/ui/styles.css`. **A bare specifier is not automatically external**, and the guard must
decide ownership from the **resolved target**, not from the specifier's shape.

| Dependency class | Required handling |
| --- | --- |
| **Local or aliased application file** | Resolve, check protected boundaries, then traverse or classify by kind |
| **Workspace package or exported subpath** | Resolve the **actual workspace target** through the package's `exports` under production conditions, then check boundaries and **continue traversal** |
| **Declared third-party package or exported subpath** | Resolve, verify the installed package identity and the actual target, then **terminate traversal at that boundary** — see the honest statement below |
| **Missing, undeclared, forbidden, or unsupported import** | **Fail** with a diagnostic naming the importer, the specifier, and what was attempted |

**Workspace packages are first-party and are walked.** Read from their manifests: `packages/ui`
declares `"exports": { ".": "./src/index.ts", "./styles.css": "./src/styles.css" }`, and
`packages/api-client` and `packages/domain` each declare `"exports": { ".": "./src/index.ts" }`. These
resolve to **TypeScript sources inside this repository**, so `@abfall-radar/ui` is traversed as a
script module and `@abfall-radar/ui/styles.css` is traversed as CSS. Treating them as opaque would
leave a re-export chain — `@abfall-radar/ui` → some module → a protected fixture — unguarded.

**A `node_modules`-looking path proves nothing.** pnpm links workspace packages into `node_modules`,
so a resolved path may pass through a symlink and still be a first-party file. **Resolve the real
path, then decide ownership** by whether the target lies inside a workspace of this repository. A
symlinked or `node_modules`-shaped path must never cause a workspace package — or a protected local
target reached through one — to be skipped.

**Export conditions must match the browser build, not CJS.** `react-dom@19.2.8`'s manifest declares
`"./client": { "react-server": "./client.react-server.js", "default": "./client.js" }`, so a
`require.resolve` under CommonJS conditions can select a different file than the browser import. The
guard resolves with the **production browser conditions the build uses** — `import`, `browser`,
`default` — and does **not** assume a `require.resolve` result is the import target.

**Third-party packages are a trust boundary, stated honestly.** `react`, `react-dom`, `zod`, and the
rest are resolved and identity-checked, then traversal **stops**. This guard exists to stop
**first-party production code from reaching first-party test fixtures**; it is not a supply-chain
audit. **No claim is made that any third-party package's internals were examined**, and their
CommonJS internals are never fed into the TS/TSX-only parser, which would be both wrong and noisy.

**The separate rules still stand.** The forbidden-package list and the Node-built-in prohibition are
unchanged and are applied before this classification; a package on those lists fails regardless of
whether it resolves.

#### Extracting CSS dependencies

**Use a real CSS parser, not line removal or a specifier regex** — the same reasoning that replaced
the script walker's text preprocessing. Comments, escapes, and at-rule preludes are grammar, and a
regex gets them wrong in both directions.

**Selected approach: `postcss`, with its public `parse` and `walkAtRules`.** The parsing behaviour
below was observed against the only `postcss` build present in this repository, the store's
transitive `postcss@8.5.22` — **not** the approved `8.5.28`, which is not installed and has not been
exercised: parsing
`/* c */ @import "./a.css"; @import url("./b.css") layer(base); @reference "../t.css"; …` yields
exactly `[["import", "\"./a.css\""], ["import", "url(\"./b.css\") layer(base)"], ["reference",
"\"../t.css\""]]`, and the leading comment produces no at-rule. Node parsing, prelude parsing, and
resolution are **three separate steps** — the AST hands back a raw `params` string and resolves
nothing.

**Availability, and the dependency this requires.** Checked rather than assumed: `postcss@8.5.22`,
`lightningcss`, and `css-tree@3.2.1` are all present in the pnpm store as transitive dependencies of
Vite and Tailwind, but **none is resolvable from a workspace** — `require.resolve('postcss')` from
`apps/extension` fails under pnpm's isolated `node_modules`. **Transitive installation does not make a
package available to the verifier.** This approach therefore requires two direct `apps/web`
devDependencies through new catalogue entries — **`postcss` 8.5.28** and **`postcss-value-parser`
4.2.0** — recorded in [the dependency table](#manifest-and-dependency-changes). Per CLAUDE.md, adding
them needed the owner's approval first; **that approval is recorded** in
[Dependency approval record](#dependency-approval-record). The implementation re-confirms the parse behaviour above on `8.5.28`
rather than inheriting the `8.5.22` observation.

**What the extractor must cover.**

| Source | Handling |
| --- | --- |
| `@import "./a.css"` and `@import url("./b.css")` | Both forms; the prelude is parsed with `postcss-value-parser`, so a `url()` wrapper is unwrapped rather than pattern-matched |
| Import **modifiers** — `layer(…)`, `supports(…)`, media queries | Parsed and discarded; a modifier may **never** conceal the target |
| **Relative** specifiers | Resolved from the **importing stylesheet's** directory, not the entry's |
| **Alias and package** specifiers | Resolved by the build's actual configuration — the `@/` alias to the `apps/web` root, and workspace package entries such as `@abfall-radar/ui/styles.css` via its `exports` |
| `@reference "…"`, `@plugin "…"`, `@config "…"` | Tailwind 4.3.3 dependency-bearing at-rules, confirmed present in the installed `tailwindcss@4.3.3` alongside `@import`, `@source`, `@theme`, `@utility`, and `@apply`. Each **loads another file**, so each is resolved and traversed like `@import` |
| `@source "…"` and `@source not "…"` | **Not a dependency load, and not judged by this traversal.** A positive `@source` registers content for Tailwind's class scan; a negative `@source not` is an **exclusion** and is never treated as a forbidden load. Both are owned by the **separate** [Tailwind content discovery](#tailwind-content-discovery) check, which evaluates the effective scanned file set — **checking only a glob's base directory is insufficient**, because a permitted base can still contain protected descendants |
| `url(...)` references to **local build-processed resources** | Resolved and boundary-checked. A protected resource is forbidden even though it is a terminal asset |
| `url(...)` to a **remote or `data:` URL**, and bare CSS values | Not a local dependency; produces no edge. The emitted-output scan keeps its own jurisdiction here, unchanged |
| Comments and escaped syntax | Locate syntax with the parsers, then decode escaped names and path values per [contextual decoding](#contextual-decoding-before-url-matching) before matching directives or resolving paths. PostCSS/value-parser raw values are not assumed to be decoded; never strip lines |
| Anything the parser reports as an error, or an at-rule that loads a file but is not listed above | **Fails the check** explicitly |

**The required Tailwind import keeps working.** `@import "tailwindcss"` resolves to the installed
package and is traversed or recorded like any other permitted dependency; the fix is **not** to reject
stylesheets or disable CSS processing. `apps/web/src/app/styles.css`'s documented chain — Tailwind,
then `@abfall-radar/ui/styles.css` — must pass this traversal. Its `@source` registrations are checked
by [Tailwind content discovery](#tailwind-content-discovery), not here.

**Build-provided dependency information is not a substitute.** A Rollup/Vite bundle's module list
records emitted chunks and script modules; CSS `@import` targets are inlined by the CSS pipeline
before that point, so their provenance is already gone. Listing chunks would therefore report the
guard clean on the exact chain it exists to catch. Nothing may substitute emitted-artifact information
for this source-graph walk.

**What is still reused from the extension walker**, and only this:

| Reused | Status |
| --- | --- |
| `resolveLocal`'s resolution strategy — relative and `@/`-aliased specifiers across `.ts`/`.tsx`/`index` candidates | Reused **for local and aliased files only**, with the root retargeted to `apps/web` and the Vite query suffix stripped. It handles **no** bare specifier, so workspace and third-party resolution per [package and workspace resolution](#package-and-workspace-resolution) is an **addition** this adaptation must write |
| `walkFrom`'s transitive walk and its **fail-closed** `Unresolvable import …` throw | Reused, with the classification step above inserted before traversal |
| Protected-directory membership by **resolved absolute path**, and the `importer → specifier → resolved` import-chain diagnostic | Unchanged |
| `specifiersOf` and `withoutCommentLines` | **Not reused.** They are replaced by the AST extraction above, and no part of this guard's contract may refer back to them |

**Honest boundary.** The parser removes the comment and string hazards entirely; it does not evaluate
runtime expressions, and this task makes no such claim. A computed specifier is rejected rather than
guessed. **For the TypeScript portion no unresolved tooling requirement remains**: the compiler API is
declared, resolvable, and already used by this workspace's toolchain, and that half adds no
dependency. **The CSS portion is different** — it requires `postcss` 8.5.28 and
`postcss-value-parser` 4.2.0 from [the dependency table](#manifest-and-dependency-changes), which
are **approved but not yet installed**, so no blanket "the guard needs nothing new" claim holds. [Step 9](#9-boundary-guards) owns the file.

## Build and verification ordering

**Ordinary source tests must never read `apps/web/dist`.** The repository's current ordering makes
that unsafe, verified rather than assumed: root `check` is
`format:check && lint && typecheck && test && pnpm build` — **`test` runs before `build`** — and
turbo's `test` task declares `dependsOn: ["^build"]`, which builds *upstream packages* and never
`apps/web` itself. An emitted-artifact assertion inside `test` therefore reads whatever `dist`
happens to be on disk: absent on a clean checkout, and stale from an earlier session otherwise.

Responsibilities are separated:

| Command | Reads `dist`? | Purpose |
| --- | --- | --- |
| `pnpm --filter @abfall-radar/web test` | **No** | Source, unit, hook, and component tests |
| `pnpm --filter @abfall-radar/web typecheck` | No | Types |
| `pnpm exec turbo run test:build-output --filter=@abfall-radar/web` | **Yes** | Fresh build **then** the emitted-artifact verifier |

**`pnpm --filter @abfall-radar/web test:build-output` is not an authoritative invocation and must not
be documented as one.** `pnpm --filter` runs the workspace script directly; it does not read
`turbo.json` and therefore does not honour the task's `dependsOn`. Invoked that way, the verifier
inspects whatever `dist` happens to be on disk — exactly the defect this section exists to close.
**Every authoritative invocation goes through Turbo**, which is what makes the build a prerequisite
rather than a hope.

- **`test` must not read `dist` at all.** It may keep whatever dependency builds its imports require;
  that is not the same as building `apps/web`.
- **The verifier only inspects already-emitted artifacts.** It builds nothing itself; producing the
  build is Turbo's job through the declared dependency, which is why the invocation must be Turbo's.
- It **fails clearly when an expected emitted file is absent or empty**, rather than passing
  vacuously, and **never accepts a stale artifact merely because `dist` exists**.

**Two layers, because a task cannot verify its own cache behaviour.** The inner task inspects
artifacts; a separate **root-level outer meta-verifier** verifies Turbo's behaviour *around* it. Asking
the inner task to observe whether it was cache-replayed would require it to invoke Turbo from inside a
Turbo task and observe itself — recursive, and self-reporting besides.

| Concern | Owner |
| --- | --- |
| Inspect emitted HTML/CSS/JS | web `test:build-output` (inner) |
| Ensure the current web build precedes the scan | Turbo dependency graph |
| Assert resolved `cache: false` | root outer meta-verifier |
| Run twice and reject cache hits | root outer meta-verifier |
| Sequence the complete verification | root `pnpm check` |

**Ordinary Vitest tests never spawn Turbo** and never host these meta-assertions.

**The inner runner is explicit.** `test:build-output` is
`vitest run --config vitest.build-output.config.ts`. That separate configuration includes only
`src/test/build-output.verify.ts` and uses `environment: 'jsdom'` with
`environmentOptions.jsdom.runScripts: 'outside-only'`, with no `resources` loader or custom
`userAgent`: parsed inline/external scripts do not execute and subresources are not loaded. The
verifier never calls the exposed eval/Function APIs. Do not pass `runScripts: undefined` as a way to
disable scripts, since a test environment may substitute its own default.
It reuses the web's declared aliases and tooling dependencies. The ordinary `vitest.config.ts`
explicitly excludes that verification entry, so default test discovery cannot read `dist` before
build. Its filename is also outside the ordinary `*.test.*`/`*.spec.*` patterns.

The shared scanner stays in `src/test/build-output-scanner.ts`. Ordinary scanner fixture tests call
it on inert supplied strings/files without reading `dist`; only the inner verification entry
enumerates fresh output. Tests invoking its HTML or JSX decoder use the same inert jsdom options.
The decoder uses standard DOM types and `DOMParser`, so it requires no new direct jsdom type package.
No parsed node is attached to a live document, and no emitted module is imported or executed.

**Turborepo wiring** — the dependency is explicit, and the verifier is **uncacheable**:

```json
"@abfall-radar/web#test:build-output": {
  "dependsOn": ["@abfall-radar/web#build"],
  "cache": false,
  "outputs": []
}
```

Valid for the pinned Turbo **2.10.6** and the existing `tasks` table — `"cache": false` is already
used there on `dev` and `test:watch`, so this introduces no unverified syntax.

- `dependsOn: ["@abfall-radar/web#build"]` names the web workspace's **own** build, not `^build`;
- **`cache: false` is what makes the check evidence.** Without it Turbo would replay a previous
  successful verifier result on unchanged inputs — reporting a pass having inspected nothing. A cached
  "the output contains no invented host" is a statement about a run that already happened, not about
  the artifacts now on disk. **That the setting is honoured is proven by the outer meta-verifier, not
  by this task**;
- **the web `build` task stays cacheable**, and its output may legitimately be **restored** from cache.
  That is fine and is the point of the split: the build may be replayed, the **inspection** may not;
- **no caching is disabled for the normal web build or any unrelated task**;
- **do not** rely on Turbo happening to schedule two unrelated tasks in a convenient order.

### The outer meta-verifier

`pnpm verify:web-build-output-task`, implemented by **`scripts/verify-web-build-output-task.mjs`** —
outside `apps/web`. It is **deliberately not a Turbo task** and **must never be invoked from inside
one**. It owns verification of Turbo's behaviour around the inner task.

**It is a Node 24 ESM JavaScript module, deliberately `.mjs` rather than `.ts`:**

- it runs under the repository's Node 24 engine with no build step and no loader;
- **it is not typechecked, and no document claims otherwise.** No workspace `tsconfig` includes root
  `scripts/`, so calling it typechecked would be false;
- **Biome covers it** — `biome.json` includes `**` and Biome processes `.mjs` as JavaScript, verified
  against the pinned Biome 2.5.5;
- because it is unchecked, it **validates every parsed Turbo JSON structure at runtime** before
  reading a field, and **fails closed** on malformed, missing, or ambiguous data rather than
  optional-chaining its way to a pass;
- if pure parser/decision logic needs its own fixtures, they live beside the script — **never** inside
  `apps/web` component tests.

**All field and flag names below were verified against the pinned Turbo 2.10.6 CLI**, not assumed.

**Step 1 — structured dry run.** `turbo run test:build-output --filter=@abfall-radar/web
--dry-run=json`, parsed as JSON, and assert on its `tasks[]`:

| Assertion | Field |
| --- | --- |
| the inner task is present | some entry has `taskId === "@abfall-radar/web#test:build-output"` |
| its same-workspace build dependency is present | that entry's `dependencies` contains `"@abfall-radar/web#build"` |
| its resolved cache configuration is disabled | that entry's `resolvedTaskDefinition.cache === false` |

**Step 2 — two real runs.** Invoke the authoritative command **twice, as two child processes, without
`--force`**:

```
pnpm exec turbo run test:build-output --filter=@abfall-radar/web --summarize
```

`--summarize` writes a run summary to `.turbo/runs/<id>.json` and prints its absolute path on stdout
as `Summary:    <path>`. **Identify only the summary produced by the current child invocation** — by
capturing that printed path, or by diffing `.turbo/runs` around the call. `.turbo` is already
gitignored, and the script **cleans up only its own** temporary data.

**Step 3 — prove execution from each summary**, per run, on the entry whose `taskId` is
`@abfall-radar/web#test:build-output`:

| Assertion | Field |
| --- | --- |
| caching was bypassed — not replayed | `cache.status === "MISS"` (the pinned version's vocabulary is `"HIT"` / `"MISS"`) |
| it actually ran | `execution` is present with `exitCode === 0` |

**`cache.status === "MISS"` plus a present `execution` block is the evidence.** Replayed **stdout is
not**: a cache hit reprints the original logs verbatim, so identical text proves nothing. This is why
structured summaries are required rather than output matching.

**Failure conditions** — the outer command fails when the inner task is missing from the dry graph;
when its `@abfall-radar/web#build` dependency is missing; when `resolvedTaskDefinition.cache` is not
`false`; when either child Turbo run exits non-zero; when either summary reports
`cache.status === "HIT"`; when either summary lacks the inner task or its `execution` block; and
whenever summary evidence is **missing or ambiguous** — it fails closed rather than assuming success.

The pinned Turbo 2.10.6 exposes everything points 1–3 need, so the two-run proof is **fully
automated**. No flag, field, or status name here was invented.

**How `pnpm check` reaches it — without nesting Turbo.** Root `check` gains one sequential step
**after** the ordinary Turbo graph completes:

```json
"verify:web-build-output-task": "node scripts/verify-web-build-output-task.mjs",
"check": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm verify:web-build-output-task"
```

The topology is: root `pnpm check` → the ordinary Turbo verification graph completes → **the root
shell** invokes `pnpm verify:web-build-output-task` → that script starts its **own two independent
filtered Turbo child runs** → each child builds or restores the current web output and executes the
uncached inner scan.

**No Turbo task ever calls `pnpm verify:web-build-output-task`, another `turbo run`, or itself.** The
outer script sits outside the graph precisely so that never happens.

This requires small, precisely scoped edits to `turbo.json` and the root `package.json`, plus one new
`scripts/` file, listed in [Expected files](#expected-files).

## Canonical sections

Each rule below has **one** authoritative home. Later sections link here rather than restating, and
anything that appears to contradict one of these is stale and should be treated as such.

| Concern | Canonical home |
| --- | --- |
| HTML and additional build inputs | [the closed source shell](#the-html-entry-has-a-closed-source-shell) |
| URL decoding and emitted syntax | [contextual decoding](#contextual-decoding-before-url-matching) |
| Emitted URL exemptions | [the four sanctioned categories](#the-four-sanctioned-categories) |
| Application state union | [the canonical state table](#5-view-state-derivation-and-event-ordering) |
| Navigation action transitions | [step 6b](#6b-navigation-zurück-auswahl-ändern-and-erneut-versuchen) |
| Failure context and phase-aware Retry | [ADR 0005's canonical phase table](../decisions/0005-responsive-web-schedule.md#erneut-versuchen-is-phase-aware-not-operation-routed) |
| Failure classification | [the canonical state table](#5-view-state-derivation-and-event-ordering) and [step 4b](#4b-range_not_covered-classification) |
| Shared reconciliation budget, request order, and terminal outcomes | [ADR 0005's bounded reconciliation contract](../decisions/0005-responsive-web-schedule.md#bounded-capabilityschedule-reconciliation) |
| Request lifecycle and bootstrap | [step 6](#6-needs-selection-surface) and [request gating](#request-gating-and-bootstrap-request-counts) |
| Lifecycle ownership — watchdog vs recovery | [step 8b](#8b-the-source-day-lifecycle) and [step 8c](#8c-the-range-recovery-coordinator) |
| Event ordering and identity | [step 5](#5-view-state-derivation-and-event-ordering) and [step 5b](#5b-response-wide-identifier-uniqueness) |
| Test ownership — provider vs web | [paired-event rendering tests](#paired-event-rendering-tests) |
| Build-verification ownership | [build and verification ordering](#build-and-verification-ordering) and [the outer meta-verifier](#the-outer-meta-verifier) |
| Absolute API origins | [absolute API origins](#absolute-api-origins-where-they-may-and-may-not-appear) |
| What the live environment can exercise | [what the live catalogue can and cannot show](#what-the-live-catalogue-can-and-cannot-show) and [the feasibility audit](#verification-feasibility-audit) |

ADR 0005 owns the **decisions and trade-offs**; this task owns **scope, criteria, tests, verification,
and handoff**, and references the ADR rather than restating its rationale.

## Scope

Implement in this order.

### 1. Activate the workspace

- `apps/web/package.json` gains the dependencies in
  [Manifest and dependency changes](#manifest-and-dependency-changes) and the `dev`, `build`, `test`,
  `test:watch`, and `typecheck` scripts. Declaring them is what integrates the workspace into
  `pnpm check` and Turborepo: the generic `build`, `test`, `test:watch`, `typecheck`, and `dev` tasks
  already exist in `turbo.json`, and the root `dev:web` script already exists. The **only** expected
  `turbo.json` and root-`package.json` changes are the ones
  [Build and verification ordering](#build-and-verification-ordering) requires; any other change to
  either file needs a stated reason in the handoff.
- `apps/web/tsconfig.json` extends `tsconfig.base.json`, mirroring `packages/ui/tsconfig.json`, with
  `jsx: react-jsx` and the DOM libraries. Strict stays strict.
- `apps/web/index.html` uses [the closed source template](#the-html-entry-has-a-closed-source-shell),
  with the Vite entry settings and their mandatory assertions specified there. It declares
  **`<html lang="de">`**. Every user-visible string this application
  renders is German, so the document language must say so: a screen reader otherwise pronounces
  German copy with the user-agent's default voice and locale, and `lang` is what drives
  pronunciation, hyphenation, and quotation rendering. This is an application-foundation requirement,
  not a detail of any one surface — English identifiers and comments in the source do not change the
  document's language.
- **`apps/web/index.html` declares the mobile viewport**, in the document `<head>`, exactly:

  ```html
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ```

  Without it a mobile browser lays the page out in a ~980 px virtual viewport and scales the result
  down, so the media queries this milestone is built on never match and the 320 px layout is never the
  one a person sees. It belongs beside `lang="de"` as an application-foundation requirement for the
  same reason: it is a property of the served document, not of any one surface.

  **Exactly one** viewport `<meta>` may exist — a second, or a conflicting `content`, is a defect,
  because the browser's handling of duplicates is not something to depend on. The `content` value adds
  **no** zoom restriction: `maximum-scale`, `minimum-scale`, and `user-scalable=no` are prohibited,
  since disabling pinch zoom removes the magnification some people need to read the page at all.

  The existing **320 CSS-pixel** responsive floor and **44 by 44 CSS-pixel** target minimum are
  unchanged and are interpreted **in that device-width viewport** — they are what this declaration
  makes meaningful.

  **Declaring the viewport is not evidence of layout.** Asserting the tag proves the document carries
  it; it proves nothing about box sizes, overflow, or target dimensions, which jsdom cannot compute.
  The manual browser checks in [Verification scope](#verification-scope) remain the only evidence for
  those and are not downgraded here.
- `apps/web/vite.config.ts`, `apps/web/vitest.config.ts`. `vite.config.ts`
  declares the development `server.proxy` target `http://127.0.0.1:3000`, under the segment-aware
  context `^/api(?:/|$)` and nothing broader. That literal is **required there**, and permitted elsewhere
  only in tests and documentation that verify or describe the proxy, per
  [Absolute API origins](#absolute-api-origins-where-they-may-and-may-not-appear). `vite.config.ts`
  is build tooling, not production runtime application source.
- The production-resolved Vite configuration uses `publicDir: false` and the sole default HTML entry;
  the build script is `vite build`, as enforced by
  [the closed entry check](#the-html-entry-has-a-closed-source-shell).
- `apps/web/src/main.tsx` mounts the application; `apps/web/src/app/` owns composition.
- **The `@/` alias resolves to the `apps/web` workspace root**, declared identically in
  `apps/web/vite.config.ts` (`resolve.alias`), `apps/web/tsconfig.json` (`compilerOptions.paths`), and
  `apps/web/vitest.config.ts`, so the production build, the type checker, and the test runner agree.
  A source module is therefore imported as `@/src/app/…`, and
  `apps/web/src/test/build-output-fixtures/react.ts` is `@/src/test/build-output-fixtures/react`.

  **This preserves the repository's one established convention rather than inventing a second.**
  `apps/extension` already maps `@/` to its workspace root — its modules are imported as
  `@/src/background/gateway`, `@/src/messaging/contract`, and `@/src/storage/settings`, and
  `apps/extension/src/boundaries.test.ts` resolves the alias as `resolve(EXTENSION_ROOT, …)` where
  `EXTENSION_ROOT` is `src/..`. Two workspaces with the same alias prefix meaning different roots is
  a footgun this milestone does not introduce, and it is also what lets the guard's resolution logic
  be adapted rather than rewritten. **`@/test/…` is therefore wrong and resolves to
  `apps/web/test/…`, which does not exist.**
- `apps/web/src/app/styles.css` is the canonical web stylesheet and follows
  [Tailwind content discovery](#tailwind-content-discovery) exactly: `@import "tailwindcss"
  source(none);`, then `@abfall-radar/ui/styles.css`, then explicit positive `@source` registrations
  and `@source not` exclusions. **Do not copy the popup's `@import "tailwindcss";` or its
  `min-width: 392px` floor**: automatic discovery stays off, and the web shell is fluid from 320 px.
- Add no dependency beyond the table. Add no router, state-management library, query library, PWA
  plugin, component framework, second CSS framework, or browser test runner.

### 2. The data layer

`apps/web/src/adapters/` is the named web data layer and the only place an HTTP request exists.

- `browser-origin.ts` is the **named browser-origin resolver**: a pure function over two primitive
  strings — the **serialized global origin** (`window.origin` / `globalThis.origin`) and the
  **location origin** (`window.location.origin`). The serialized global origin is **authoritative**
  for whether the context has a usable tuple origin. It rejects `"null"`, empty, malformed,
  non-HTTP(S), and otherwise opaque global origins as a configuration failure **before any request**,
  and requires the usable global origin and the location origin to **agree after normalization**. A
  sandboxed frame reporting global `"null"` with location `https://sandbox.example.test` therefore
  fails configuration and issues nothing. **`location.origin` alone never proves a usable security origin**,
  **`document.domain` is never consulted**, and there is **no fallback** to loopback or anywhere else.
  Taking primitive strings is what makes every case testable without a real sandboxed iframe.
  A rejection **ends in the rendered `configuration_error` state** described in
  [step 5](#5-view-state-derivation-and-event-ordering), never merely in the absence of a request: on
  its own, "issue no request" is a blank page or a spinner that never resolves.
- `api-client.ts` takes the resolved origin, validates it through `parseApiBaseUrl`, and constructs one
  `ApiClient` with a browser `FetchLike` wrapper. A configuration failure is stated explicitly, never
  repaired and never defaulted. The wrapper preserves every supplied `RequestInit` member and
  overrides `cache` last to exactly `'no-store'`.
  `fetch` and `timeoutMs` stay injectable so no test reaches the network.
- `schedule-gateway.ts` exposes exactly the three reads the product needs, each accepting an
  `AbortSignal`, returning the client's `ApiResult` unchanged. It adds **no** product retry, **no**
  persisted schedule cache, and **no duplicate schema-validation pass**: the client already rejects a response that does not answer
  the request that was made, that is not official, or that carries a foreign or out-of-range event.
  The schedule lifecycle then applies only the web-owned response-wide and cross-request invariants
  specified below, because those need state the transport client deliberately does not own. It may
  expose the client's actual `ApiFailure` as a type-only app-facing export so `FailureContext` does not
  duplicate the union; modules outside `src/adapters/` still never import
  `@abfall-radar/api-client` directly.
- **The whole layer is injectable into the application**, so a test can drive any sequence of
  outcomes — including the complete provider → area → events reconciliation after a first exact
  range `422` — without a network, a real server, or a debug control in the product.

#### Browser HTTP cache policy and gateway tests

The web boundary constructs `@abfall-radar/api-client` with one browser `FetchLike` wrapper. Every
AbfallRadar request — `listProviders`, `listServiceAreas`, and `listCollectionEvents` — passes through
that same client and wrapper. The wrapper copies the caller's method, headers, abort signal, body,
credentials, mode, redirect, referrer, integrity, and every other `RequestInit` member, then sets
`cache: 'no-store'` last. A conflicting caller-supplied cache mode cannot override it.

Retry, reconfirmation, source-midnight refresh, focus/visibility revalidation, first-422 or metadata
mismatch reconciliation, and range recovery all reuse this gateway/client boundary. No raw `fetch`,
second client, or alternate gateway method is permitted for those paths. `cache: 'no-store'` prevents
the browser HTTP cache from answering or storing the web requests; it does not bypass the API's
deliberate server-side official-source cache. This browser policy is separate from the no-persistence
rule: the web stores no schedule in localStorage, IndexedDB, cookies, a service worker, or an offline
schedule cache, and it does not change extension transport or caching behavior.

The recording fake `FetchLike` tests make no real network request. They exercise all three reads and
assert exact `RequestInit.cache === 'no-store'`, preservation of method, headers, abort signal, and
other supplied members, rejection of a conflicting cache value, and reuse of the same wrapped gateway
boundary by Retry, reconciliation, and recovery.
- `collection-event.ts` maps a validated `CollectionEventTransport` onto the domain `CollectionEvent`,
  renaming `serviceAreaId` to `districtId` and `wasteType` to `type`, and **validating the result
  through `CollectionEventSchema`** rather than asserting it. Provide a non-throwing variant for use
  during React rendering, where an exception has no error boundary to catch it.
- No component, hook, or feature module calls `fetch` or constructs a URL, and **no module under
  `apps/web/src/**` hard-codes an absolute API origin**, per
  [Absolute API origins](#absolute-api-origins-where-they-may-and-may-not-appear).

### 3. Source-local calendar days

`apps/web/src/schedule/source-day.ts`, pure, every input explicit:

- **`deriveSourceToday(timeZone, now)`** takes the **validated capability `timeZone`** and the
  injected clock's current instant. It **owns the source-zone `Intl` formatter**, derives
  `YYYY-MM-DD` with `formatToParts`, `calendar: 'gregory'`, `numberingSystem: 'latn'`, reading the
  `year`, `month`, and `day` parts, and returns **either the date or a typed source-date/time-zone
  failure**. A formatted string is never parsed. It **never falls back to the device zone, never
  substitutes UTC, and never throws into React rendering**. Its result is **re-derived whenever the
  source-local date changes** — see [step 8b](#8b-the-source-day-lifecycle) — and is never held for
  the lifetime of the page.

  **Time-zone failure is owned here, not by `deriveTargetRange`.** Normally an unusable API-supplied
  zone never reaches this helper: `TimeZoneSchema` rejects it at the transport boundary and it becomes
  an `invalid_response` for the **service-area** operation. If `Intl` nevertheless fails after
  api-client success, `deriveSourceToday` returns its **typed derivation failure**, which the
  application represents as the web-owned `source_date_unavailable` — **no** fabricated transport
  operation, HTTP status, or `requestId`, and **no `RangeError` text**. Handling at each of the five
  checkpoints, and the precisely scoped no-events guarantee, are canonical in
  [step 3c](#3c-source-date-derivation-failure-at-every-checkpoint).
- **`isUpcoming(eventDate, sourceToday)`** compares two ISO calendar dates **as strings**. They sort
  lexicographically, so this is calendar comparison with no instant and no zone in it.
- **`relativeDayLabel(eventDate, sourceToday)`** returns `Heute`, `Morgen`, `In N Tagen`, or the
  absolute German fallback, computed by calendar-day arithmetic over the two ISO dates. The fallback
  is formatted with `Intl` pinned to `UTC`.
- **Every helper takes `(eventDate, sourceToday)` explicitly.** No parameter defaults to an ambient
  `new Date()`, and no helper reads the clock itself.
- **Never pass an ambient `new Date()` into a helper that interprets it in the device zone**, and
  **never construct a local-midnight `Date` from a `YYYY-MM-DD` string.** Those are the two ways a
  calendar day becomes a device day.
- Do **not** call `getUpcomingEvents` or `getRelativeDateLabel` from `@abfall-radar/domain`; both
  violate the rules above. `packages/domain` is not modified to accommodate this.

### 3b. The source-zone drop-off window formatter

`apps/web/src/schedule/collection-window.ts`, modelled on
`apps/extension/src/schedule/collection-window.ts`. Carrying `startsAt`, `endsAt`, and `timeZone` to
the surface is not the same as displaying them correctly:

A local clock time plus an IANA zone is **ambiguous during a daylight-saving overlap**: in Berlin on
2026-10-25 the instants `00:30Z` and `01:30Z` both render as `02:30`. And a window may legitimately
**end on a later source-local date** — that must be **rendered, not rejected**, but shown as
`23:30–01:00` it reads as inverted or same-day.

The formatter therefore derives, **per endpoint, in the explicit source zone**: local calendar date,
local clock time, UTC offset, and IANA zone. German date formatting, 24-hour time.

| Endpoints | Display model |
| --- | --- |
| Same source-local date | `start time + start offset – end time + end offset (IANA zone)` |
| Different source-local dates | `start date, start time + start offset – end date, end time + end offset (IANA zone)` |

| Case | Instants | Required output |
| --- | --- | --- |
| Summer | `2026-07-01T10:00:00Z` – `12:00:00Z` | `12:00 UTC+02:00–14:00 UTC+02:00 (Europe/Berlin)` |
| Winter | `2026-11-07T10:00:00Z` – `12:00:00Z` | `11:00 UTC+01:00–13:00 UTC+01:00 (Europe/Berlin)` |
| **DST overlap** | `2026-10-25T00:30:00Z` – `01:30:00Z` | `02:30 UTC+02:00–02:30 UTC+01:00 (Europe/Berlin)` |
| **Cross-midnight** | `2026-03-21T22:30:00Z` – `2026-03-22T00:00:00Z`, `event.date` `2026-03-21` | `21.03.2026, 23:30 UTC+01:00–22.03.2026, 01:00 UTC+01:00 (Europe/Berlin)` |
| Cross-midnight **+ offset change** | `2026-03-28T22:30:00Z` – `2026-03-29T01:30:00Z` | `28.03.2026, 23:30 UTC+01:00–29.03.2026, 03:30 UTC+02:00 (Europe/Berlin)` |

- format both ends with **`Intl.DateTimeFormat`**, **each endpoint independently**, **always passing
  the event's own `timing.timeZone`** — never the device default, and never a raw UTC value;
- **derive each endpoint's local date in the source zone**, and include **both dates** whenever they
  differ;
- render a **German 24-hour clock** and German date formatting;
- obtain each endpoint's offset from **`timeZoneName: 'longOffset'`** read via `formatToParts`. On
  `de-DE` that part serializes as `GMT+02:00`, so **normalize the prefix to `UTC`** for display;
- **display the source IANA zone identifier alongside the window**;
- let **`Intl` resolve each offset**; never apply a fixed or calculated Berlin offset, and **never
  reuse one offset for both endpoints** — that is exactly what breaks the overlap case;
- provide an **accessible label communicating both endpoint offsets unambiguously, and both endpoint
  dates when they differ**;
- one formatter, used by the first rendered drop-off and by every later list row alike, so a field
  cannot be omitted on one surface and present on another.

**Do not** render `02:30–02:30 (Europe/Berlin)` without offsets, **do not** render `23:30–01:00`
without both dates, **do not** reject a valid cross-date window, **do not** use the device zone, and
**do not** hide the IANA zone.

### 3c. Source-date derivation failure at every checkpoint

`deriveSourceToday` returns **either** a source-local `YYYY-MM-DD` **or** a typed derivation failure.
Every checkpoint that calls it therefore has **three** outcomes, and all three are handled. The
failure is a **web-owned local failure**, represented as `source_date_unavailable` in the canonical
failure context — it invents no api-client `Operation`, no HTTP response, no `status`, and no
`requestId`, and the shared `@abfall-radar/api-client` contract is unchanged.

**At the final publication gate** the three outcomes are:

| Derivation result | Outcome |
| --- | --- |
| Succeeds, **equal** to this request's captured `sourceToday` | Publish, per [the final source-date gate](#5d-the-final-source-date-gate-before-publication) — unchanged |
| Succeeds, **different** | Do not publish; supersede and restart — unchanged |
| **Typed failure** | Do not publish; enter the local schedule error below |

A derivation failure is **not** a changed date: it does **not** trigger the changed-date restart, does
**not** establish that the range is uncovered, does **not** consume the shared reconciliation budget,
and does **not** invalidate an otherwise confirmed provider/area.

**Ownership guards run first.** Apply the canonical token, phase-owner, confirmed-pair, and
cancellation checks **before** acting on any derivation result. A superseded or cancelled owner must
not publish a local error, remove a successor's schedule, stop a successor's lifecycle owner, or start
another request.

| Failure location | Resulting behaviour |
| --- | --- |
| **Schedule-pipeline preflight** | Retain the confirmed pair; enter the documented schedule error presentation with `source_date_unavailable` under `phase: 'schedule_pipeline'`; issue **no** events request for the failed derivation |
| **Initial or reconciled response publication gate** | Discard the candidate schedule; retain the confirmed pair; show the local schedule error; install **no** accepted-pair watchdog and **no** range-recovery coordinator. The events request for that attempt has **already occurred** |
| **Accepted-pair source-day watchdog** | Withdraw the accepted schedule from active display; retain the confirmed pair; **stop that watchdog**; show the local schedule error. **No current transport operation is invented** — the failure carries none |
| **Range-recovery preflight** | Remain in `range_not_covered`; retain the pair **and** the coordinator; store the local failure as the current nested `lastRecoveryFailure` with `phase: 'range_recovery'`; issue **no** events request for the failed derivation |
| **Recovered response publication gate** | Do not publish the candidate; remain in `range_not_covered`; retain the coordinator; store the local recovery diagnostic. The recovered events request has **already occurred** |

**Retry for a local schedule error** restarts the existing complete authoritative pipeline —

```text
fresh providers → fresh service areas → new clock read and source-date derivation
→ clamped range → events only when requestable
```

— as a **new attempt** under the existing ownership and reconciliation-budget rules. It never retries
publication of the failed candidate and never reuses provisional capability or range data.

**Retry and scheduling for a local recovery failure** are unchanged from the transport case: manual
`Erneut versuchen`, signal coalescing, and the periodic deadline all behave as documented, and the
next recovery deadline is scheduled **after the failed cycle settles**. A successful derivation is
**not** a precondition for the failure remaining retryable.

#### The no-events guarantee, precisely scoped

**A failed preflight derivation prevents the particular collection-events request whose range would
have been derived from that result.** It is not a claim that no events request has ever been issued
in this attempt, and no rule may state it that way.

Requests that **legitimately already completed** and are unaffected:

- the initial events request, issued before reconciliation;
- an events request issued before its own final publication gate;
- the request that produced the schedule the watchdog is currently monitoring.

A failure **at the publication gate** causes **no additional** events request from that failure
handling. A **watchdog** derivation failure starts **no** events request by itself. In both cases a
later explicit Retry is a **separate attempt** and follows the full authoritative pipeline above.

Acceptance criteria and test call counts use these scopes: assertions are on the request history of
**the attempt under test**, never on a global "zero events requests" count.

**Diagnostics stay truthful and separate.** `source_date_unavailable` shows its own German copy and
live-region announcement and **never** displays a `requestId`. A separately retained
`triggeringRangeProblem` keeps its existing lifetime and may remain independently labelled with its
own validated `requestId`; the local recovery failure **never borrows it**. A transport
`lastRecoveryFailure` keeps its truthful `operation`.

### 4. Source-zone range derivation

`apps/web/src/schedule/schedule-range.ts`. **`deriveTargetRange` takes `sourceToday` as an
already-derived ISO calendar date** plus validated `validity.from` and `validity.to` — no clock, no
zone. Its whole responsibility is calendar arithmetic:

- compute 90 calendar days forward from `sourceToday`;
- clamp into the declared window: `from` is the later of `sourceToday` and `validity.from`, `to` is
  the earlier of `sourceToday` plus 90 days and `validity.to`;
- return a named outcome for **`sourceToday` past `validity.to`** and for **an inverted clamp**, and
  issue no request for either.

**`deriveTargetRange` must not** accept a `timeZone`, construct an `Intl.DateTimeFormat`, derive
`sourceToday` again, return an unusable-zone result, or duplicate time-zone validation. Every
time-zone concern — including the unusable-zone failure — belongs to `deriveSourceToday` in
[step 3](#3-source-local-calendar-days). A source-date failure means `deriveTargetRange` is **never
called**.

### 4b. `range_not_covered` classification

**Exactly two entry paths into this state.** A `code` string on its own never selects it and never
starts range recovery — that conflation would let a provider-catalogue failure masquerade as a
calendar statement.

**Failing a `range_not_covered` predicate does not, by itself, mean `error`.** Classification answers
**two** questions in order, and only the second one is about content:

1. **Does this still belong to the current owner?** Evaluate the ownership guards — attempt token,
   phase owner, captured confirmed pair, and cancellation — **before** any processing that could
   consume reconciliation budget, issue another request, publish a failure, or install a lifecycle
   owner. A completion that fails these guards is **discarded**: it publishes nothing, announces
   nothing, and starts nothing. It does **not** become an `error`, and it does **not** trigger a
   selection transition.
2. **What does a current completion contain?** Only here do the two entry paths, the existing
   validation rules, and the phase-aware failure contract decide the outcome.

**Evaluating a current action and handling a completion are different questions.** A *current action*
that cannot start a confirmed-selection pipeline because no confirmed selection exists follows the
documented `needs_selection` transition — that is a statement about now. A *late completion* whose
selection was meanwhile cleared, replaced, or whose phase changed is discarded — it is a statement
about a moment that has passed, and it must never overwrite the state the newer action established or
push the surface back to `needs_selection`.

**A current response with invalid identity or payload data is not obsolete.** It belongs to the
current attempt, so the existing validation and failure rules apply in full. Calling it "superseded"
to avoid rendering its failure is prohibited.

**Path 1 — local, capability-derived.** All of these are required:

- a current `confirmedSelection`;
- a **fresh validated capability for that exact provider and area**;
- that capability's `availability === 'available'`;
- source-local today **and** the range derived from **that** capability;
- today is past `validity.to`, **or** the clamp yields no requestable intersection;
- **no collection-events request is issued for this decision** — the local no-range result prevents
  the request whose range would have come from it. A request that already completed earlier in the
  attempt, such as reconciliation's one retry, is unaffected and is not retroactively forbidden.

Path 1 enters with **no `triggeringRangeProblem`** — including when reconciliation ran first and the
refreshed capability turned out to have no requestable range. The earlier provisional 422 is not
attached: reconciliation answered it, and this state now describes the refreshed capability.

**Path 2 — Problem Details after the shared reconciliation budget is exhausted.** All of these are
required on the **one reconciled collection-events retry** for the latest attempt and current
confirmed pair:

```ts
failure.kind === 'problem'
failure.operation === 'listCollectionEvents'
failure.status === 422
failure.code === 'SCHEDULE_RANGE_NOT_COVERED'
```

The first exact result with this shape consumes the shared budget and runs
[the canonical reconciliation sequence](../decisions/0005-responsive-web-schedule.md#bounded-capabilityschedule-reconciliation);
it does **not** enter `range_not_covered` immediately. Path 2 is reached only when that sequence's one
events retry returns the exact result again, or when a metadata mismatch consumed the budget first and
the one retry returns it. If refreshed capability metadata yields no requestable range, Path 1 is used
and no events retry is issued.

Path 2 enters with **`triggeringRangeProblem` set to that terminal validated problem**, so its
`requestId` stays available for the initial range-response diagnostic. Both budget-exhausting orders
qualify — *first 422 → reconciliation → second 422* and *metadata mismatch → reconciliation → exact
422* — because **exhaustion of the shared budget is the condition, not a count of 422 responses**.
Ownership, lifetime, and display are in [step 8c](#8c-the-range-recovery-coordinator).

**None of the following enters this state. Their outcomes differ, and the table is authoritative over
any shorter summary.**

Checked **first**, before any processing — these are **not** `error`:

| Case | Precondition | Result |
| --- | --- | --- |
| **No** confirmed selection | A **current action** tries to start a confirmed-selection pipeline and no confirmed pair exists | `needs_selection` — there is no pair to be uncovered. No provider-specific request is issued and no API failure is fabricated |
| A **mismatched** selection — response pair ≠ confirmed pair | A **completion** whose captured provider/area pair is not the current confirmed pair | Canonical **no transition**: discarded, not rendered, no budget consumed, no reconciliation started |
| A **superseded** response | A completion whose attempt token or phase owner is no longer current — including one whose selection was cleared or replaced while it was in flight | Discarded; publishes nothing, announces nothing, installs nothing. The state established by the newer action stands |
| `cancelled` | The attempt was aborted | Control flow only: no failure copy, no failure announcement, no result-driven publication, and no lifecycle installation. Excluded from `RenderableApiFailure` |

Checked **second**, for a completion that **is** current — these keep the existing phase-aware failure
contract, with the real transport operation preserved:

| Case | Result |
| --- | --- |
| `listProviders` carrying the range code | `error` / `problem` for `listProviders` |
| `listServiceAreas` carrying the range code | `error` / `problem` for `listServiceAreas` |
| `listCollectionEvents` with the code but **not** status `422` | `error` / `problem` |
| Status `422` with **another** `code` | `error` / `problem` |
| A **first** exact range `422` while the shared budget remains | Not terminal and not this state: runs [the canonical reconciliation sequence](../decisions/0005-responsive-web-schedule.md#bounded-capabilityschedule-reconciliation) |
| Invalid identity or payload data on a **current** response | The established validation failure and its phase-aware presentation — never discarded as obsolete |
| `network`, `timeout`, `invalid_response` | their own `error` subtypes |
| A failure recorded with `phase: 'range_recovery'` | Stays a **nested** `lastRecoveryFailure` inside `range_not_covered`; never a top-level or selection-flow `error` |

**This rule must not be read as** "not `range_not_covered` means `error`", "every failed guard is
`invalid_response`", "every mismatched response is silently ignored" — a mismatched *current* response
is a validation failure, not a discard — or "every API failure replaces the current top-level state".

**Ordinary cancellation cleanup stays governed by the existing ownership rules.** It may not clear a
successor's `AbortController`, pending work, diagnostics, or lifecycle owner.

Success remains governed by the existing validation rules and
[the final source-date gate](#5d-the-final-source-date-gate-before-publication).

### 5. View-state derivation and event ordering

`apps/web/src/schedule/view-state.ts` owns the `FailureContext` and view-state types plus one pure
derivation function, so no component decides a state or reconstructs request phase on its own. The
selection, schedule, and recovery request owners attach the appropriate context when their attempts
start.

**The canonical state table.** Nine top-level members; every later section refers here rather than
restating. Rationale in
[ADR 0005](../decisions/0005-responsive-web-schedule.md#the-exhaustive-application-state-union).

| State | Reached when | Actions available | Focus destination | Deterministic test owner |
| --- | --- | --- | --- | --- |
| `configuration_error` | browser-origin resolver rejects the context, before any client exists | none — no retry can repair a browsing context | its stable heading | [configuration_error surface](#the-configuration_error-surface) |
| `needs_selection` | selection flow owns the surface; initially no confirmed pair, or `Auswahl ändern` is editing a draft while the previous confirmed pair remains retained but inactive. **Provider-catalogue and draft service-area reads happen here**, shown as a nested loading substate of their step | provider/area step controls, plus `Zurück` on the area step | selection heading | [selection loading tests](#selection-loading-and-back-navigation-tests) |
| `no_official_providers` | successful provider response empty, or all entries filtered as `demo` | catalogue refresh only | its heading | [successful empty catalogues](#successful-empty-catalogues) |
| `no_service_areas` | successful **empty** area list for an offered provider | area refresh, `Zurück` | its heading | [successful empty catalogues](#successful-empty-catalogues) |
| `loading` | **post-confirmation schedule-pipeline work** is in flight with nothing yet to show. Selection-flow catalogue reads stay in `needs_selection`; recovery cycles stay in `range_not_covered` | `Auswahl ändern` when a confirmed pair exists | main heading | [lifecycle and races](#lifecycle-and-races) |
| `live` (`fresh` \| `upstream_stale`) | matching schedule/capability pair accepted; subtype from `meta.freshness` | `Auswahl ändern` | schedule main heading | [paired-event rendering](#paired-event-rendering-tests) |
| `empty` | accepted response whose `data` is `[]` inside the covered period | `Auswahl ändern` | schedule main heading | [states and failures](#states-and-failures) |
| `range_not_covered` | exactly the two paths in [step 4b](#4b-range_not_covered-classification) | `Erneut versuchen`, `Auswahl ändern` | its heading | [range-recovery coordinator tests](#range-recovery-coordinator-tests) |
| `error` (`problem` \| `network` \| `timeout` \| `invalid_response` \| `source_date_unavailable`) | a reportable failure for the latest non-recovery `FailureContext`. The last subtype is the **web-owned local** failure and is admitted **only** in `schedule_pipeline` — never in a selection phase; a `range_recovery` local failure stays nested in `range_not_covered`. See [step 3c](#3c-source-date-derivation-failure-at-every-checkpoint) | phase-aware `Erneut versuchen` and the phase's navigation actions | its heading | [phase-aware Retry tests](#phase-aware-retry-tests) |

`cancelled` is **control flow, not a state** — a superseded attempt publishes nothing and renders no
error.

**Each member must carry dedicated German copy, a live-region announcement, and accessibility
treatment, enforced mechanically.** The copy and announcement lookups are exhaustive records keyed by
the union, so an unhandled member is a **TypeScript error**; a deterministic test additionally
iterates the union and asserts every member renders non-empty copy and announces itself. Adding a
state without both must fail the build or a test, never merely a review.

- **`no_official_providers`** follows a **successful** provider response whose `data` is empty **or**
  whose entries are all filtered out because `sourceKind` is `demo`. It is **not** loading and **not**
  an error, renders dedicated German copy, and issues **no** service-area and **no** collection-events
  request.
- **`no_service_areas`** follows a **successful** empty service-area response for an offered official
  provider. It is **not** loading and **not** an error, renders dedicated German copy, and issues
  **no** collection-events request.
- **An all-unavailable area list is not `no_service_areas`.** The returned areas stay visible with
  their explanations and native disabled semantics, no area can be confirmed, and no collection-events
  request is issued.

- **`configuration_error`** is reached when the browser-origin resolver rejects the context **before
  the client is constructed** — an opaque or `"null"` serialized global origin, an empty or malformed
  origin, a non-HTTP(S) scheme, a global/location disagreement after normalization, or any other
  browser-origin validation failure. It renders a **complete, accessible German surface inside the
  normal application shell**, with a stable heading and status or alert semantics, explaining in
  product language that AbfallRadar cannot securely reach the service from this page context. It
  **leaves no spinner active**, **issues no api-client call**, shows **no rejected origin, URL,
  scheme, exception, stack trace, or validator message**, and **fabricates no operation, HTTP status,
  or `requestId`**. It is **not** `network`, `invalid_response`, `timeout`, or Problem Details. Where
  recovery means opening the application in an ordinary HTTP(S) page, the copy **says so** rather than
  offering a retry that cannot repair a browsing context. See
  [ADR 0005](../decisions/0005-responsive-web-schedule.md#configuration_error-is-a-rendered-state-not-a-silent-refusal).

- `range_not_covered` is produced by **exactly the two paths** in
  [step 4b](#4b-range_not_covered-classification) and by nothing else — **a `code` string alone never
  selects it**;
- **`error` is one top-level state with an exhaustive phase-bearing failure context**, reusing the
  client's exported `ApiFailure` rather than inventing a parallel transport failure:

  ```ts
  /**
   * Web-owned and never from the wire: `deriveSourceToday` could not produce a source-local
   * date. It carries no `operation`, `status`, or `requestId`, because no HTTP request failed.
   */
  type SourceDateUnavailable = {
    readonly kind: 'source_date_unavailable';
    /** The validated capability zone that could not be used. Never `RangeError` text. */
    readonly timeZone: string;
  };

  /**
   * Only the two phases that derive a source date admit the local failure. `selection_providers`
   * and `selection_areas` never call `deriveSourceToday`, so their `failure` stays exactly
   * `ApiFailure` and a local date failure in a selection phase is a **compile error**.
   */
  type ScheduleFailure = ApiFailure | SourceDateUnavailable;

  /** Cancellation never reaches a surface, whatever the phase. */
  type Renderable<Failure> = Exclude<Failure, { kind: 'cancelled' }>;

  type RenderableApiFailure = Renderable<ApiFailure>;

  /**
   * Maps each context's own `failure`, so the phase constraint survives: a selection context
   * yields `RenderableApiFailure`; a schedule or recovery context yields
   * `RenderableApiFailure | SourceDateUnavailable`.
   */
  type WithRenderableFailure<Context> = Context extends { failure: infer Failure }
    ? Omit<Context, 'failure'> & { failure: Renderable<Failure> }
    : never;

  /** A narrowing of the exported `ProblemFailure`, not a new interface. */
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
    readonly triggeringRangeProblem?: ExactRangeProblem;
    readonly lastRecoveryFailure?: WithRenderableFailure<
      Extract<FailureContext, { phase: 'range_recovery' }>
    >;
  };
  ```

  `network` and `invalid_response` remain **failure subtypes**, not top-level states. Each subtype has
  **distinct German copy** wherever its phase contains it; only `problem` may expose a validated
  `requestId`, and an **unrecognized problem `code` renders generic copy while still showing that
  `requestId`**.
  **`source_date_unavailable` is a sixth renderable branch, not a top-level state and not a
  transport failure.** It has its own German copy and live-region announcement, never shows a
  `requestId`, never borrows one from a retained `triggeringRangeProblem`, and is routed by
  `FailureContext['phase']` exactly like the transport kinds — so a local date failure and a
  transport failure are distinguishable in both diagnostics and Retry routing. Its complete
  contract is [step 3c](#3c-source-date-derivation-failure-at-every-checkpoint).
  **`cancelled` is excluded by `RenderableApiFailure` at the transport-to-UI boundary** — handled
  before a stored UI failure is built, before copy is selected, and before anything is announced — so
  it needs no copy entry and no announcement to satisfy exhaustiveness.
  `configuration_error` and `range_not_covered` stay **top-level** states. **The `kind` of whatever
  failure the context actually carries** exhaustively controls copy, announcement, and `requestId` —
  the four transport kinds everywhere, plus `source_date_unavailable` in the two source-date-bearing
  phases, which is where the type admits it. `FailureContext['phase']`
  exhaustively controls Retry and actions through
  [the canonical phase table](../decisions/0005-responsive-web-schedule.md#erneut-versuchen-is-phase-aware-not-operation-routed).
  A missing renderable branch in either dimension is a compile error.
- `range_not_covered` may carry **two independent optional diagnostics** — the
  `triggeringRangeProblem` that caused entry and the current cycle's nested `lastRecoveryFailure`
  (`phase: 'range_recovery'`). It remains the same top-level product state and never promotes either
  diagnostic to `error`. Population, lifetime, and display are canonical in
  [ADR 0005](../decisions/0005-responsive-web-schedule.md#range_not_covered-carries-two-independent-diagnostics);
  the implementable summary is in [step 8c](#8c-the-range-recovery-coordinator).
- `network` means `fetch` itself rejected and no HTTP response existed; `invalid_response` means a
  response arrived that cannot be used as this contract — which is what a stopped `apps/api` behind
  the Vite proxy produces, as a `text/plain` error response (`502` on the pinned Vite 8.1.5). The rule
  is the media type and the not-ok status, not the specific number. See
  [ADR 0005](../decisions/0005-responsive-web-schedule.md#stopping-the-api-is-an-invalid-response-not-a-network-failure).
  Neither carries a `requestId`;
- a `cancelled` failure produces **no** error state;
- an unknown problem `code` degrades to generic product copy;
- `empty` is a **successful** response whose `data` is `[]`. It reads as "the source publishes
  no collections in the covered period", it is not an error, and the declared coverage stays visible
  alongside it. Coverage is never inferred from the empty array.

**The total event order, applied before the next collection is chosen:**

1. **event local date**, ascending — two `YYYY-MM-DD` strings, where lexical order *is* calendar
   order;
2. on the same date, **all-day curbside before timed mobile drop-off**;
3. timed events on the same date by **`timing.startsAt` compared as a full-precision instant**, per
   the comparator below;
4. **event `id`** ascending, **only when every preceding key is equal**, compared on the
   **original, unmodified** strings **by UTF-16 code unit** — which is exactly what JavaScript's `<`
   and `>` give: equal → `0`, `a < b` → `-1`, `a > b` → `1`. **Code-unit order, not byte order.**
   **Never `localeCompare` or `Intl.Collator`**, no case folding, no Unicode normalization, no derived
   key: a locale-aware comparison can call `"\u00E9"` and `"e\u0301"` equal, and a tie-break that
   reports equality for two distinct ids is no tie-break. The result must not vary with locale,
   collation, browser or device settings, or input order, and two ids are equal **only** when the
   original strings are exactly equal. Rationale in
   [ADR 0005](../decisions/0005-responsive-web-schedule.md#deterministic-event-ordering).

**The accepted timestamp grammar, read from `packages/api-client/src/contracts/collection-events.ts`
and exercised against the pinned `zod` build rather than assumed.** `TimeWindowTimingSchema` uses
`z.iso.datetime()`, which today accepts:

| Form | Accepted |
| --- | --- |
| `2026-11-07T10:00Z` | **yes — seconds are optional** |
| `2026-11-07T10:00:00Z` | yes |
| `2026-11-07T10:00:00.5Z`, `.0001Z`, `.123456789Z` | yes — fractional precision is unbounded |
| `2026-11-07T10Z` | no |
| `2026-11-07T10:00:00+01:00` | no — numeric offset rejected |
| `2026-11-07T10:00:00` | no — designator required |
| `2026-11-07T10:00:00,5Z` | no — comma separator rejected |

Confirm this against the schema at implementation time rather than trusting this table.
**Seconds are optional**, so a seconds-only regex would reject valid data — and **the transport
contract is not narrowed to require seconds.**

Two strategies are therefore **both forbidden**, each failing on a different input:

- **lexical string comparison**, and `String.localeCompare` — `...:00.500Z` sorts before `...:00Z`
  because `.` precedes `Z`, so the later window wins;
- **`Date.parse`, `Date#getTime`, or epoch milliseconds alone** — these **truncate below a
  millisecond**. `…10:00:00.0001Z` and `…10:00:00.0002Z` both yield `1794045600000`, so two different
  instants compare equal and the tie-breaker decides what time should have decided.

**The comparator preserves all accepted precision, with no new dependency and no narrowing of the
HTTP contract.** A permitted strategy:

1. split the already-validated timestamp into **whole-second part**, **optional fractional digits**,
   and **zone suffix**. The whole-second parser accepts **both minute-precision and second-precision
   forms**: an omitted `:ss` canonicalizes to `:00`, omitted fractional digits canonicalize to zero;
2. compare the whole-second instants **numerically, parsed as instants** — which normalizes an offset
   against `Z` automatically, should the schema ever accept one;
3. when those are equal, **right-pad the shorter fractional string with zeros** to equal width and
   compare the equal-width digit strings;
4. only then fall through to `id`.

Required consequences:

- `10:00Z`, `10:00:00Z`, and `10:00:00.000Z` are **the same instant**, and none is rejected for
  lacking an explicit field;
- `.1`, `.10`, and `.100` are **equal** fractional values;
- `.0001` sorts **before** `.0002`;
- equivalent instants fall through to the next ordering key;
- nothing is truncated, rounded, or coerced to milliseconds;
- a form the pinned schema does not accept is already an `invalid_response` and is **never repaired**;
- **no `Temporal` and no other dependency** is added, and the HTTP timestamp contract is **not**
  narrowed to simplify web sorting.

**This is the single timestamp comparator in the application.** Event ordering **and**
[the window-order invariant](#5c-drop-off-window-order) both call it. Do not write a second
timestamp algorithm.

**What the comparator requires of its inputs.** It is called at **two stages**, so
"already domain-validated" cannot be its precondition — one call happens before domain mapping exists:

| Stage | When | Validator that already ran |
| --- | --- | --- |
| Transport cross-field checks such as `endsAt >= startsAt` | immediately after api-client response validation, **before** transport-to-domain mapping | the **api-client** timestamp validator |
| Ordering rendered domain events | after domain mapping | the **domain** timestamp validator |

- the comparator accepts strings that have passed **either** the api-client **or** the domain
  timestamp validator;
- **api-client validation suffices** at the transport boundary; **domain validation suffices** during
  domain-event sorting;
- the parser supports **every form admitted at the transport boundary**, including omitted seconds
  and arbitrary accepted fractional precision — that boundary is the wider of the two;
- it compares **complete instants**, never via `Date.parse`, `Date#getTime`, or epoch milliseconds
  alone;
- **an invalid, unvalidated string never silently receives a sort position** — no `NaN` fallback, no
  zero, no silent drop; if the helper exposes a runtime failure result, that is what it returns.

**Transport window-order validation runs before caching, rendering, and domain mapping.**

Rule 3 must precede rule 4. An `id` is opaque, so ordering by date and `id` alone would put the later
window first whenever the ids happen to sort that way — a wrong "next collection" that looks entirely
ordinary. Rule 4 is only a total tie-breaker because
[step 5b](#5b-response-wide-identifier-uniqueness) has already established that ids are unique.

### 5b. Response-wide identifier uniqueness

**All three list responses have the same gap.** `ProviderSchema`, `ServiceAreaSchema`, and
`CollectionEventSchema` validate an `id` individually; none of `ProviderListResponseSchema`,
`ServiceAreaListResponseSchema`, or `CollectionEventListResponseSchema` compares one entry's id
against another's. Duplicates are schema-valid today in all three. React keys, selection lookup, and
the event tie-breaker all assume otherwise, so the assumption is checked rather than trusted.

Three named fail-closed invariant checks in the web data layer, each running **immediately after
api-client success**:

| Response | Checked before | Failure operation | Status | Downstream suppressed | Rendering |
| --- | --- | --- | --- | --- | --- |
| Provider catalogue | **demo filtering**, rendering, selection | `listProviders` | `0` | Service-area **and** collection-events | No provider rendered |
| Service areas | rendering available/unavailable choices, selection | `listServiceAreas` | `0` | Collection-events | No area rendered |
| Collection events | domain mapping, ordering, rendering, state publication | `listCollectionEvents` | `0` | — (terminal) | No event rendered |

- **Provider uniqueness is validated across the complete validated response, before demo providers
  are filtered.** Filtering first would let a duplicate hide behind an entry the surface never shows.
- `status: 0` for all three: `ApiSuccess` discarded the successful HTTP status, so any number would
  be fabricated. `0` is the established unknown/local-status sentinel, **not** a real HTTP status, and
  is never displayed.
- **No `requestId` is fabricated**, no rejected record is exposed in UI or logs, and nothing from a
  rejected response is partially rendered.

**Do not** filter demo providers before checking; **do not** silently keep the first or last
duplicate; **do not** append array indexes to React keys; **do not** deduplicate contradictory
records; **do not** add a comparator key to route around ambiguous identity; **do not** change the
OpenAPI or server contract; **do not** widen `ApiSuccess`/`ApiResult` to retain a status.

- The check runs **after `@abfall-radar/api-client` validation succeeds** and **before** domain
  mapping, ordering, rendering, or any state publication.
- A duplicate `id` makes the response an **`invalid_response`** for the collection-events operation.
  `operation` stays the real `listCollectionEvents`, because that much is known.
- **No event from that response is rendered** — no de-duplication, no partial schedule.
- **No server diagnostic text is shown and no `requestId` is invented.**
- Record **`status: 0`**, the established local/unknown-status sentinel. **Do not fabricate `200`.**
  `ApiResult`'s success branch is `{ ok: true, data }` and retains **no** status, so the web layer
  cannot know whether the accepted response was `200`, `201`, `206`, or another `response.ok` status.
  Do not infer or reconstruct it, and **do not widen `ApiSuccess`/`ApiResult`** for this web-local
  invariant. `0` is the convention already used in `apps/extension/src/background/gateway.ts`,
  `view-state.ts`, and `use-schedule.ts` for a failure no HTTP status describes, and
  `InvalidResponseFailureSchema` types `status` as `z.number().int()`, so it validates. **Introduce no
  second sentinel name for the same meaning.**
- **`0` is not an HTTP response status.** It is never rendered, never appears in product copy, and
  exists only so a log or a test can tell a locally raised failure from one a server answered.
- This is a **web consumer invariant** in `apps/web`. It adds **no** dependency from
  `@abfall-radar/api-client` to `@abfall-radar/domain`, and it changes **no** OpenAPI route contract
  and **no** server behaviour.
- **Do not add an extra comparator key to conceal duplicate identities.** Two exactly identical
  repeated events are rejected by the same rule rather than treated as interchangeable.

### 5bb. Schedule/capability consistency

The schedule lifecycle owns this web-local cross-request invariant and implements
[ADR 0005's single canonical reconciliation contract](../decisions/0005-responsive-web-schedule.md#bounded-capabilityschedule-reconciliation).
It has the requesting capability, the confirmed pair, the injected clock, every `ApiResult`, and the
attempt token/`AbortSignal`; no component has enough input to make this decision.

Each confirmed-selection schedule attempt carries **one shared**
`reconciliationRemaining: 1 | 0`, initially `1`. The first accepted-shape metadata mismatch **or** the
first exact `listCollectionEvents` / `422` / `SCHEDULE_RANGE_NOT_COVERED` problem consumes it. They
never receive separate retries. The response metadata is never promoted to capability metadata.

The lifecycle must follow the canonical provider → area → fresh clock → recomputed range → optional
single events-retry order and every terminal outcome stated in the ADR. In particular:

- the first exact range problem triggers reconciliation rather than immediately publishing
  `range_not_covered`;
- provider or area removal and demo/unavailable reclassification invalidate the confirmed selection
  and suppress every forbidden later call;
- provider and area request failures keep their real operations;
- the reconciled events retry runs every normal acceptance invariant **and the final source-date
  gate against its own newly derived snapshot** before publication;
- a matching retry owns exactly one watchdog; a second exact range problem owns the recovery
  coordinator; a mismatch after budget exhaustion is local `invalid_response` with `status: 0` and
  owns no lifecycle timer;
- a first mismatch followed by the exact range problem ends in `range_not_covered`, while a first
  exact range problem followed by a mismatch ends in `invalid_response`;
- cancellation or supersession at any awaited stage publishes nothing and starts no later call or
  lifecycle work.

Every failure raised inside the canonical refresh has `phase: 'schedule_pipeline'` and
`stage: 'reconciliation'`. A **transport** failure keeps its unchanged real `failure.operation`; a
`source_date_unavailable` raised here has none to keep and is given none, per
[step 3c](#3c-source-date-derivation-failure-at-every-checkpoint). Its Retry follows
[the canonical phase table](../decisions/0005-responsive-web-schedule.md#erneut-versuchen-is-phase-aware-not-operation-routed):
supersede the partially consumed attempt and start a new authoritative schedule attempt at fresh
providers with `stage: 'initial'` and `reconciliationRemaining: 1`. Do not resume the failed endpoint
or reuse provisional capability, range, or reconciliation state. The new user-requested attempt may
reconcile once again; every late result from the old attempt remains discarded.

When reconciliation's fresh capability yields no requestable range, or its one events retry returns
the exact range problem, its fresh provider/area reads are **one instance** of qualifying entry
evidence under [the entry-revalidation predicate](#entry-revalidation-is-evidence-based), which
decides reuse for **every** authoritative flow rather than for reconciliation by name. Do **not**
issue an immediate duplicate catalogue/capability read; schedule the next deadline while still
accepting a later Retry or lifecycle signal.

Feasible verification is the exact call-order, call-count, state, selection, and lifecycle-owner
matrix in [Schedule/capability reconciliation tests](#schedulecapability-reconciliation-tests), using
the injected gateway and deterministic supersession at every await.

### 5bc. Timed-event date and zone consistency

A `mobile_drop_off` carries `date`, `timing.startsAt`, and `timing.timeZone`, and **nothing
cross-checks them**. `date` drives every label and the sort key; `startsAt` is the instant a person
must actually attend. When they disagree the surface names one day and a time belonging to another.

Two checks, run after capability/schedule metadata consistency and **before** transport-to-domain
mapping, event publication, sorting, relative-date labels, window formatting, and rendering:

- **Zone consistency** — `event.timing.timeZone` must equal `response.meta.source.timeZone`, which
  [step 5bb](#5bb-schedulecapability-consistency) has already pinned to the authoritative capability
  zone.
- **Local-date consistency** — derive the local `YYYY-MM-DD` of `timing.startsAt` **in the
  authoritative source zone** with `Intl.DateTimeFormat`/`formatToParts`, `gregory`, `latn`, and
  require it to equal `event.date` exactly.

**Do not** compare the UTC date substring — `2026-03-20T23:30:00Z` is 20 March in UTC and **21 March**
in Berlin. **Do not** use the device zone. **Do not** silently rewrite `event.date` or
`timing.timeZone`. **Do not** display an event whose label date and appointment instant disagree.

Either mismatch is `invalid_response` for `listCollectionEvents` with **`status: 0`**, no partial
rendering, and no `requestId`.

**`event.date` is the local date the window *starts* on.** A window may end on a later source-local
date — see [step 3b](#3b-the-source-zone-drop-off-window-formatter) — and that is not a violation.

### 5c. Drop-off window order

Both `packages/api-client`'s `TimeWindowTimingSchema` and its `packages/domain` counterpart refuse an
inverted window using **`Date.parse`**, which truncates below a millisecond. A window from
`…10:00:00.0002Z` to `…10:00:00.0001Z` is inverted by a tenth of a millisecond, parses to two equal
epoch milliseconds, and **passes both schemas** — then reaches a surface telling somebody to arrive
inside a window that closed before it opened.

A named application-boundary invariant, running immediately after api-client success and **before**
transport-to-domain mapping, event-id uniqueness publication, sorting, state publication, and
rendering:

- for every `mobile_drop_off` event, compare `startsAt` and `endsAt` with **the same full-precision
  comparator** required for event ordering — never `Date.parse`, never a second implementation;
- **`endsAt` equal to `startsAt` is accepted**; the contract forbids only "before", and a zero-length
  window stays representable;
- **`endsAt` earlier than `startsAt` at any accepted fractional precision** produces
  `invalid_response` for `listCollectionEvents` with **`status: 0`**;
- **no partial schedule renders**, **no `requestId`** is exposed, and **no timestamp, payload, or
  parsing detail** reaches the UI or a log.

**Do not change the shared schemas in AR-005.** Correcting `TimeWindowTimingSchema` in
`packages/api-client` and `packages/domain` for every consumer is a **separate follow-up** with its
own review, because it is a shared-contract change affecting the extension too. The web boundary must
be safe in this milestone regardless.

### 5d. The final source-date gate before publication

Implements
[ADR 0005's canonical gate](../decisions/0005-responsive-web-schedule.md#the-final-source-date-gate-before-publication).
A request can outlive source midnight, so a candidate that passes every other check can still describe
**yesterday**. The watchdog cannot see this race — it governs changes *after* a valid acceptance — so
the gate closes it at publication.

**Each concrete `listCollectionEvents` request retains the `sourceToday` it was derived from**, beside
its existing identity, requested range, and capability/time-zone context. The snapshot belongs to the
**request**, not the attempt:

| Request | Snapshot used at the gate |
| --- | --- |
| Initial | the `sourceToday` that built that request |
| Reconciled retry | the **newly derived** `sourceToday` from the refreshed capability and reconciliation's own clock read — **never** the original attempt's earlier date |
| Recovered | the `sourceToday` derived by **that recovery cycle** |

**Apply to every otherwise-valid candidate** — initial success, matching success after reconciliation,
matching success during recovery, and a successful response with **zero events**:

1. complete existing parsing and validation (identity, requested range, official source, events,
   timestamps, capability/schedule consistency);
2. verify the request token, phase owner, and confirmed selection are still current;
3. **read the injected clock again**;
4. derive the current source-local date from the **validated matching capability's** time zone —
   this call has **three** outcomes, not two;
5. **typed derivation failure** → publish nothing; take the local-error transition in
   [step 3c](#3c-source-date-derivation-failure-at-every-checkpoint); issue **no** further events
   request from this handling. **Cleanup is ownership-specific**, and neither path installs an
   accepted-pair watchdog for the rejected candidate:

   | Failure owner | Required result |
   | --- | --- |
   | **Schedule pipeline** | Reject the candidate, retain the confirmed pair, show the local schedule error, and install **neither** an accepted-pair watchdog **nor a new** recovery coordinator |
   | **An existing recovery cycle** | Reject the candidate, retain `range_not_covered` and **the same coordinator**, record the nested local diagnostic, and continue `Erneut versuchen` and periodic scheduling under the existing settle-based rules |

   **"Install no new coordinator" never means "dispose of the existing one."** A recovery-owned gate
   failure must not run shared teardown that clears the coordinator, its token, its controller, or its
   next deadline — the episode continues and the coordinator that owned the cycle still owns it.
   Cancellation and supersession checks are unchanged: a superseded or cancelled owner publishes no
   local error and disposes of no successor's lifecycle owner;
6. otherwise compare with **this request's** snapshot;
7. **differ** → publish nothing; supersede and restart;
8. **match** → publish the accepted pair with its checked `sourceToday`, then install exactly the
   documented accepted-pair watchdog.

**Steps 2–8 are one synchronous decision path with no intervening `await`.** Do not place the only
clock read before an awaited body read, parse step, or other asynchronous work.

Compare by **inequality**, not "later than" — a backward change still counts. **Do not** compare range
bounds instead: clamping can leave `from`/`to` identical across two source days. **Do not** change the
time zone to make the check pass. Clock reads and restart side effects belong to the request owner,
**never** inside a reducer or React state-updater, which stay pure.

**A date-mismatched candidate never** enters accepted state even briefly, renders yesterday as
`Heute`, is relabelled with today while keeping the old range, installs a watchdog, or fabricates an
API error, cancellation message, or `requestId`. **A derivation-failed candidate is discarded on the
same terms**, and its local error likewise fabricates no transport operation, status, or `requestId`.

**Restart.** While owner and confirmed selection remain current: supersede the obsolete attempt,
retain the confirmed pair, discard the candidate, and start **exactly one** immediate replacement
through the existing request-owner/coalescing mechanism — **not** at the next watchdog tick, 15-minute
deadline, focus, or visibility event. It runs the established sequence — fresh `listProviders` →
validate provider → fresh `listServiceAreas` → validate area/capability → new clock read and
source-local today → newly clamped range → `listCollectionEvents` only if requestable → validation →
this gate — reusing the existing gateway with `cache: 'no-store'`.

**Not a second reconciliation.** The old attempt ends; the new attempt gets the normal single shared
budget, never reset or enlarged inside the old one. Initial and reconciled work restarts under
`schedule_pipeline`; recovery stays with the existing coordinator, **a stale recovered candidate does
not leave `range_not_covered`**, recovery diagnostics keep their episode/attempt lifetimes, and **no
second coordinator is created**. The finishing attempt's cleanup must not clear the replacement's
controller, ownership, or pending work. Concurrent Retry/timer/lifecycle requests **coalesce** to one
replacement; a selection or phase change or unmount supersedes the restart, and an obsolete completion
never restarts work for an old confirmed pair.

### 6. Needs-selection surface

- Starts in an explicit needs-selection state. **Automatic provider *discovery* is required;
  automatic *selection* and automatic schedule retrieval are prohibited.** The application does fetch
  on load — otherwise there is nothing to choose from — but it never decides which municipality a
  person is asking about.

  | Phase | Requested automatically | Never automatic |
  | --- | --- | --- |
  | **Bootstrap** | Validate the browser origin, construct the same-origin client, request the **provider catalogue** — exactly one request | Selecting a provider or municipality |
  | **Provider selected** | That provider's **service areas** | Preselecting the first or only provider; offering a `demo` provider |
  | **Area selected** | Nothing — only the **draft** selection changes | Preselecting the first or only area; requesting events |
  | **Confirmed** | Capability → range → **collection events** | Confirming on the person's behalf |

  **A single offered provider is still not preselected**, and neither is a single available area.
  **Reload returns to needs-selection**, because this milestone has no persistence.
- Reads `GET /api/v1/providers` on load — which **selects nothing**, it populates a picker — and
  **excludes every provider whose `sourceKind` is `demo`**.
- **`no_official_providers`**: a successful provider response that is `[]`, or that contains only
  demo providers, renders clear German product copy. It is **not** a loading state and **not** an
  error state, and it issues **no** service-area request and **no** collection-events request.
- Requests service areas **only after the selected provider is confirmed against the loaded catalogue
  as an offered, non-demo provider**. The gate is mechanical — one place issues the request and
  refuses an unverified provider — so no caller can bypass it.
- **`no_service_areas`**: a successful, empty service-area list for an offered provider renders clear
  German product copy. It is **not** an error state, and it issues **no** collection-events request.
- **An all-unavailable list is not `no_service_areas`.** Every area is rendered with its explanation
  and its disabled semantics; there is simply no confirmable choice.
- Requires **explicit confirmation** to select an area.
- **Changing the provider clears the area selection.**
- An `unavailable` area is a **native control carrying the native `disabled` attribute**. It is
  therefore skipped by sequential `Tab` navigation, exposes its disabled state through the
  accessibility tree, and dispatches no activation from click, Enter, or Space. Its explanatory
  German text stays visible and associated with the area. Do **not** substitute a focusable
  pseudo-disabled control or `aria-disabled` alone.
- A failed catalogue read and a failed area read each offer a deliberate retry, reachable only from
  the failed state — see [step 6b](#6b-navigation-zurück-auswahl-ändern-and-erneut-versuchen).

### 6b. Navigation: `Zurück`, `Auswahl ändern`, and `Erneut versuchen`

The authoritative contract is
[ADR 0005's navigation section](../decisions/0005-responsive-web-schedule.md#navigation-zurück-auswahl-ändern-and-erneut-versuchen).
Implement exactly it.

**Two selection values, never conflated:**

| Value | Meaning |
| --- | --- |
| `confirmedSelection` | The pair whose schedule pipeline is active, or whose accepted schedule is displayed |
| `draftSelection` | The pair currently shown in the selection flow |

Both `null` on first load. **Opening `Auswahl ändern` copies `confirmedSelection` into
`draftSelection`, so the current provider and area remain visible as the defaults.** Editing the draft
**never** touches `confirmedSelection` and **never** issues a collection-events request; only explicit
area confirmation replaces it and starts a schedule attempt. **Changing the draft provider clears the
draft area.** Reload clears both.

**The selection flow has two explicit steps.**

| Step | Shows | Starts |
| --- | --- | --- |
| **Provider** | the successfully loaded offered catalogue; **nothing preselected on first load** | choosing an official provider starts its service-area request |
| **Service area** | the chosen provider kept visible, plus the loading, failed, successful-empty, available, and unavailable outcomes | only an **available** area can be confirmed |

Unavailable areas stay **native-disabled** and are skipped by sequential keyboard navigation.

**Selection loading is nested inside `needs_selection`, never top-level `loading`.** The bootstrap
provider read, the draft provider's service-area read, and a selection-phase `Erneut versuchen` all
render as the **loading substate of their own step** while the top-level state stays
`needs_selection`. Top-level `loading` is reserved for post-confirmation schedule-pipeline work, and
range-recovery progress stays nested inside `range_not_covered` — see
[the canonical state table](#5-view-state-derivation-and-event-ordering) and
[ADR 0005](../decisions/0005-responsive-web-schedule.md#the-exhaustive-application-state-union).

**Request ownership assigns the phase.** A retained `confirmedSelection` during `Auswahl ändern` does
**not** turn a draft catalogue request into schedule-pipeline loading; the selection flow owns that
request, so it stays `needs_selection` with its `selection_providers` or `selection_areas` phase. No
selection-flow area request implicitly confirms an area or starts a collection-events request.

**`Zurück`** — visible on the service-area **loading, failure, empty, and list** states. It supersedes
and aborts the active service-area attempt (late completion discarded by the newest-attempt token),
returns to the provider step, **retains the loaded provider catalogue while it is still valid**, may
keep the provider as a draft highlight but **clears the draft area**, and **issues no
collection-events request**. A catalogue invalidated by `PROVIDER_NOT_FOUND` is **never** made
selectable again through `Zurück`.

**An invalidated draft provider** — implement
[ADR 0005's recovery transition](../decisions/0005-responsive-web-schedule.md#an-invalidated-draft-provider-is-recovered-not-retried)
without restating its rationale:

- **match exactly** `ProviderNotFoundProblem`: `kind: 'problem'`, `operation: 'listServiceAreas'`,
  `status: 404`, `code: 'PROVIDER_NOT_FOUND'`, confirmed against
  `apps/api/src/routes/v1/providers.ts` and `apps/api/src/http/problem-details.ts`. Any other `404`,
  code, operation, or failure kind — and any `detail` text — keeps ordinary area-failure behaviour;
- **check ownership first**: only a current `selection_areas` attempt acts; a stale completion after
  `Zurück`, a draft-provider change, or unmount does nothing;
- then **invalidate** the loaded catalogue as selection evidence, **clear** the draft provider, draft
  area, and obsolete area data, **supersede** the area attempt, return to the provider step, and start
  **exactly one** `listProviders` owned by **`selection_providers`**;
- the failed request **stays** a `selection_areas` / `listServiceAreas` failure — its phase and
  transport metadata are not rewritten;
- render **application-owned German recovery copy** — *"Dieser Anbieter ist nicht mehr verfügbar. Die
  Anbieterliste wird aktualisiert."* — never server text, announced through the polite live region,
  and move focus to the **provider step heading**, since the old provider control is gone;
- show the refreshed, validated, demo-filtered choices **with nothing selected**, even if the same id
  reappears; areas are requested again **only** after an explicit choice;
- an empty or all-demo refresh is `no_official_providers`; a failed refresh is a `selection_providers`
  failure with its real `listProviders` operation, retried under that phase;
- **no** outcome confirms an area or requests events, and a retained confirmed pair during
  `Auswahl ändern` stays inactive until reconfirmation.

**`Auswahl ändern`** — visible on **every** post-confirmation schedule surface with a confirmed
selection: `loading`, `live` (`fresh` and `upstream_stale`), `empty`, `range_not_covered`, and every
failure state. It supersedes and aborts any capability or collection-events attempt, **stops the
accepted-pair watchdog or range-recovery coordinator, whichever owns the current surface**, copies the
confirmed pair into the draft, opens the service-area step for that provider (restarting only the
reads needed if its catalogue data is no longer valid), **hides the schedule while editing**, and
issues **no** collection-events request until reconfirmation.
**Reconfirming the same area runs a new authoritative pipeline**, never a silent reuse.
**`configuration_error` carries no `Auswahl ändern`** — there is no trustworthy origin to select
against.

**`Erneut versuchen` is phase-aware.** Implement
[ADR 0005's one authoritative `FailureContext` and Retry table](../decisions/0005-responsive-web-schedule.md#erneut-versuchen-is-phase-aware-not-operation-routed)
without restating it here. The request owner assigns `selection_providers`, `selection_areas`,
`schedule_pipeline`, or `range_recovery` when the attempt starts. `failure.operation` stays the real
transport operation for diagnostics and **never** routes Retry.

In particular, a schedule or reconciliation failure on `listProviders` or `listServiceAreas`
restarts the whole schedule pipeline at fresh providers with a new schedule token, controller, and
reconciliation budget. The same operation under range recovery keeps `range_not_covered` and starts a
complete recovery cycle. A selection-flow failure remains scoped to its provider or area step.

Every Retry aborts or supersedes the older attempt for its owning phase, clears obsolete partial
state, discards late completions, and **remains retryable after another failure**. `cancelled` is never
rendered as an error. `no_official_providers` uses `selection_providers`; `no_service_areas` uses
`selection_areas` for its draft provider plus retaining `Zurück`.

**Focus destinations** — entering the area step → its heading or first appropriate control; `Zurück`
→ the provider choice that opened it; `Auswahl ändern` → the selection heading or current-area
control; `Erneut versuchen` while pending → stays on the retry action unless the surface is replaced;
successful confirmation → the schedule/loading main heading. **Never leave focus on an unmounted
element or on `document.body`**, and **never move focus onto a native-disabled unavailable area.** All
three actions carry accessible names, visible focus, and the 44 by 44 CSS pixel target.

### 7. Schedule surface

- Issues the collection-events request only for a **confirmed available area**, and only when the
  derived range exists.
- Shows **all three** provenance values, which are separate and never collapsed into one another:
  **`meta.source.name`** as the source name, **`meta.source.attribution`** as attribution text
  rendered verbatim, and **`meta.source.landingPageUrl`** as the public source link. Attribution is
  **never synthesized** from the name or the locality and **never replaced by the link's hostname**;
  **no upstream calendar or download URL is ever exposed**. If the link opens a new context it carries
  the appropriate `rel` protection.
- Shows `retrievedAt`, the freshness state, the **complete declared `coverage.wasteTypes`**, and the
  effective display range.
- **Renders all of the above whenever the response carries provenance, including a successful empty
  schedule.**
- Shows **every** event the source published for the period. There is **no waste-type selector and no
  filter** in this slice.
- **Represents every normalized `CollectionEvent` in the accepted response**, at **one event per
  rendered row or card**. One upstream appointment may normalize into several events — the verified
  combined appointment yields one `hazardous` and one `small_electronics` event sharing date, window,
  zone, and location — and they are **never deduplicated for sharing any of those**. Each keeps its own
  waste-type label and identity. If a future design groups events sharing a window and place, the
  grouping must still visibly represent **both** and discard no identity, waste type, or required
  drop-off detail.
- Shows **every** rendered `mobile_drop_off` event's own time window, that window's source time zone,
  and its location. A `curbside` event renders no window and no location.
- Labels each event's day with `relativeDayLabel(event.date, sourceToday)` from step 3.
- Renders `empty` as its own state, distinct from every failure, with the coverage declaration
  still shown.
- Renders every failure outcome distinctly and renders **no** server diagnostic string. A support
  `requestId` appears only for a validated Problem Details response that supplied one.

### 8. Request lifecycle

- Newest-selection-wins with **both** an attempt token and an `AbortSignal`: the token decides which
  reply may update state, the signal actually stops the superseded request.
- The request owner assigns a `FailureContext` phase **when each attempt starts**. Phase is not
  reconstructed later from `failure.operation`, an endpoint name, a provider id, or the presence of
  `confirmedSelection`.
- Selection-flow attempts cannot update schedule state; schedule attempts cannot update draft state;
  range-recovery attempts cannot repaint after `Auswahl ändern` or another pair's confirmation.
  Changing phase supersedes the previous phase token, aborts its controller, and clears its stale
  failure context.
- A cancellation caused by a newer selection is not an error and must not clear a schedule the newer
  selection is about to replace.
- Selection is **session-only React state**. No `localStorage`, `IndexedDB`, cookie, server
  persistence, account, or migration logic. Reloading returns to needs-selection.

### 8b. The source-day lifecycle

A web page can stay open for days, so `sourceToday` is a value with a lifetime rather than a constant.
Left anchored, the page labels yesterday's collection "Heute" after source midnight and requests a
range starting yesterday. Reasoning in
[ADR 0005](../decisions/0005-responsive-web-schedule.md#the-page-revalidates-when-the-source-local-calendar-date-changes).

#### Watchdog ownership

**A provisional capability does not own or start a watchdog.** A capability fetched but not yet
corroborated by a matching schedule is a hypothesis — the operator may have changed the zone between
the two requests — so a watchdog started from it would derive dates in a zone the accepted schedule
never confirmed.

- provider/area selection and a **successful capability alone** start **nothing**;
- fetch collection events and perform all identity, range, official-source, timestamp, validity, and
  capability-consistency checks;
- when the first metadata mismatch or exact range problem consumes the shared budget, perform
  [ADR 0005's bounded reconciliation](../decisions/0005-responsive-web-schedule.md#bounded-capabilityschedule-reconciliation);
- **start or replace the watchdog only after a matching schedule/capability pair has passed
  [the final source-date gate](#5d-the-final-source-date-gate-before-publication) and been
  published**;
- if reconciliation or schedule loading **fails**, render the appropriate state and leave **no**
  watchdog running;
- the watchdog uses **the accepted schedule's matching source-zone metadata**;
- **cancellation:** selection change, the selection becoming unavailable or removed, unmount, and
  **replacement by another accepted pair** each cancel the previous watchdog.

**`apps/web/src/schedule/source-date-watchdog.ts` — observe the date, never predict the transition.**

Predicting the next boundary is invalid, not merely awkward: the predicate
`formattedDate !== sourceToday` is **not monotonic**, so a binary search has nothing sound to
converge on. `America/Creston` shifted `GMT−06:00` → `GMT−07:00` at `1944-01-01T06:01:00Z`,
un-crossing midnight and repeating the previous date — the source date goes forward, **backward**,
then forward again. There is no "earliest changed millisecond" to find.

- while the document is **visible**, a **recursive `setTimeout`** — never overlapping `setInterval`
  callbacks — **requests** a source-date check every **`SOURCE_DATE_WATCH_INTERVAL_MS`**, a named
  exported constant of `1000`, referenced by the tests rather than duplicated as a literal.
  **Requesting is not running**: delivery timing belongs to the browser;
- each check derives `YYYY-MM-DD` from the **current injected clock** through the existing
  `Intl.DateTimeFormat`/`formatToParts` source-zone formatter. It **never increments the previous
  date and never predicts a transition**;
- a derived date differing from the last authoritative `sourceToday` **in either direction** —
  forward, backward, or a repeat — supersedes and reruns the pipeline;
- a **same-date** check — from polling, visibility return, `pageshow`, or focus — performs
  **no network refresh and no published view-state change; while visible and still owned by the current accepted pair, ensure exactly one pending watchdog timeout**. An existing pending timeout is **not duplicated**, and a hidden, stale, disposed,
  superseded, or failed owner arms nothing;
- a **typed derivation failure** on a check is the third outcome and is handled, not ignored: withdraw
  the accepted schedule from active display, retain the confirmed pair, **stop this watchdog**, and
  show the local schedule error from
  [step 3c](#3c-source-date-derivation-failure-at-every-checkpoint). It **invents no current
  transport operation**, **starts no collection-events request by itself**, and is **not** treated as
  a changed date. A later `Erneut versuchen` is a separate attempt running the full authoritative
  pipeline;
- **exactly one watchdog for the current accepted schedule/capability pair, and at most one for the
  current confirmed selection**;
- **adds no `Temporal` and no time-zone dependency**; `Intl` is the authority, as everywhere else.

**When the document becomes hidden, the pending polling timeout is cancelled.** On
**`visibilitychange` to visible**, **`pageshow`**, and **window focus**, derive the current source
date immediately and run the same change check. After throttling or machine sleep the next callback
derives the actual current date directly, so any number of elapsed dates is one comparison.

**Returning to visible on the same source date must rearm the watchdog.** Cancelling on hide and then
finding an unchanged date would otherwise leave the accepted pair with **no** pending timeout, so the
next source midnight would pass unobserved until some other signal happened to arrive. The
visibility-return branch is therefore:

1. **check ownership first** — the accepted pair is still current and this watchdog is neither
   superseded nor disposed. A stale, cancelled, or disposed owner **arms nothing** and returns;
2. derive the current source date;
3. **derivation failed** → take the accepted-pair local-error transition in
   [step 3c](#3c-source-date-derivation-failure-at-every-checkpoint) and **stop this watchdog**. It
   does not rearm;
4. **date unchanged** → **no network refresh and no published view-state change; while visible and
   still owned by the current accepted pair, ensure exactly one pending watchdog timeout** at the
   existing `SOURCE_DATE_WATCH_INTERVAL_MS` — scheduling one only if none is pending. Nothing has
   changed to refresh;
5. **date changed** → run the existing authoritative refresh path. The superseded watchdog **does not
   rearm itself**; the replacement pair installs its own.

**Concurrent signals coalesce.** `visibilitychange`, `pageshow`, and window focus arriving close
together produce **one** derivation and **one** pending timeout, never a duplicate timer — the same
at-most-one invariant that already governs the watchdog.

**Freshness is bounded by the next delivered callback or recovery signal, not by wall-clock
midnight.** A visible tab is not a running tab: browsers throttle and suspend foreground timers too,
and no lifecycle event is guaranteed to fire at source midnight. State this honestly:

- under normal foreground scheduling the watchdog **requests** a check every
  `SOURCE_DATE_WATCH_INTERVAL_MS`; **browser scheduling delay is outside the application's control**;
- **while a callback is delayed, the rendered schedule and its relative labels may temporarily remain
  based on the previous `sourceToday`** — including a stale `Heute`;
- **no hard-real-time midnight guarantee is made**;
- at the next delivered signal — watchdog callback, `visibilitychange` to visible, `pageshow`, or
  window focus — the **actual current source date is derived directly**, and if it changed the old
  attempt is superseded, the labels and schedule state that would read as current are removed or
  invalidated, and authoritative revalidation begins;
- the date is **never advanced by assumption**, and a replacement schedule is **never published from
  stale capability metadata**.

**The application is not constrained to `Europe/Berlin`** — the capability contract accepts any
validated IANA zone and the product stays city-neutral. The formatter supports whatever IANA data the
runtime exposes; the watchdog only observes it, and **AR-005 makes no claim to support historical
transitions through a search**.

**The lifecycle, owned by the schedule hook:**

1. once an available capability supplies `timeZone` **and a confirmed selection exists**, derive
   `sourceToday` from the **injected clock** in that zone. That capability is **provisional** —
   enough to build a request with, **not** enough to own a watchdog;
2. fetch collection events, run every acceptance check, and apply
   [the final source-date gate](#5d-the-final-source-date-gate-before-publication); **start the
   watchdog only once a gate-passing matching
   schedule/capability pair has been published**, per [Watchdog ownership](#watchdog-ownership)
   below;
3. on each check, **derive the date again from the actual current clock** — never by adding one day;
4. unchanged date → **no network refresh and no published view-state change; while visible and still owned by the current accepted pair, ensure exactly one pending watchdog timeout**. An existing pending timeout is not duplicated; a hidden, stale,
   disposed, superseded, or failed owner arms nothing;
5. changed date, **in either direction** → **supersede and abort the current attempt**, **clear any
   schedule that would otherwise be presented as current**, and create a new
   `phase: 'schedule_pipeline'`, `stage: 'initial'` attempt with a new token, controller, and shared
   reconciliation budget before rerunning the authoritative pipeline: selected provider → selected
   area capability → target range → collection events;
6. **recompute the 90-day range from the new `sourceToday` before requesting events**;
7. **continue watching only under the capability that matches the accepted schedule.**

Rules while the refresh runs:

- **once the change is observed**, yesterday's event is not left labelled "Heute": the stale schedule
  and labels are cleared **at that observation**, not when the replacement arrives. Before the
  observation, while a callback is delayed, the previous labels may still be on screen;
- **no coverage is claimed for the newly advanced tail** until the new response succeeds;
- **the confirmed selection is preserved** in memory;
- **an advanced range outside the validity window issues no collection-events request** and renders
  the no-calendar-for-this-period state;
- the refresh announces its state change through the existing polite live region.

**Cancellation and cleanup:** **selection change, `timeZone` change, configuration failure, and
unmount** each cancel the current watchdog; unmounting also removes **every lifecycle listener**; a
superseded date-change refresh **cannot publish state**, through the same attempt token and
`AbortSignal` as any other attempt.

**Visibility recovery**, because throttled timers and machine sleep are not hypothetical:

- when the document becomes **hidden**, the **pending polling timeout is cancelled**;
- on **`visibilitychange` to visible**, **`pageshow`**, and **window focus**, **check ownership
  first** — a stale, cancelled, or disposed owner arms nothing and returns — then derive the current
  source date from the current clock;
- a **different** date runs the same superseding refresh immediately, and the superseded watchdog does
  **not** rearm itself;
- the **same** date performs **no network refresh and no published view-state change; while visible and still owned by the current accepted pair, ensure exactly one pending watchdog timeout**, scheduling the replacement at
  `SOURCE_DATE_WATCH_INTERVAL_MS` only if none is pending. Cancelling on hide without rearming here would leave the accepted pair watching nothing, so
  the next source midnight would pass unobserved;
- a **derivation failure** takes the accepted-pair local-error transition in
  [step 3c](#3c-source-date-derivation-failure-at-every-checkpoint) and **stops** that watchdog, which
  does not rearm;
- **every signal coalesces into exactly one refresh attempt and one pending timeout**: a timer firing
  as a tab is restored, or several visibility events in a row, must not produce two concurrent
  refreshes racing to publish or two live timers.

### 8c. The range-recovery coordinator

The watchdog rule in [step 8b](#8b-the-source-day-lifecycle) is correct and leaves a hole: in
`range_not_covered` there is **no accepted pair**, so no watchdog runs and **nothing** watches for a
new validity window. A person who confirmed an area in March would sit on "no calendar for this
period" from 31 December **until they reload**. Reasoning in
[ADR 0005](../decisions/0005-responsive-web-schedule.md#range_not_covered-needs-its-own-lifecycle-or-a-confirmed-selection-is-stranded).

**`apps/web/src/schedule/range-recovery-coordinator.ts` — owned by `confirmedSelection`.** It is
**not** an accepted-schedule watchdog and **never authorizes rendering a schedule or a relative-date
label**. Its only job is to ask whether a requestable range exists yet.

**On entering `range_not_covered`** — because source-local today moved past `validity.to`, the clamped
range inverted, the capability declares no covered period, or
[bounded reconciliation](../decisions/0005-responsive-web-schedule.md#bounded-capabilityschedule-reconciliation)
ended in either documented range outcome:

- **remove the previously accepted schedule and relative-date labels *before* presenting the state**;
- **stop the accepted-pair source-day watchdog**;
- **retain `confirmedSelection`** — the validity window ended, the person's choice did not;
- retain the latest validated capability **only as last-observed metadata**, never as authority to
  render or to build a request;
- enter `range_not_covered`;
- **start the range-recovery coordinator**, whose entry behaviour follows
  [the entry-revalidation predicate](#entry-revalidation-is-evidence-based) — reuse the producing
  flow's completed authoritative reads when they qualify, otherwise run one immediate complete cycle.

**Polling policy — `RANGE_RECOVERY_INTERVAL_MS = 15 * 60 * 1000`**, a named exported constant
referenced by tests rather than duplicated. **Fifteen minutes is an AR-005 product/network trade-off,
not an API contract.** While `range_not_covered` and `confirmedSelection` both hold:

- on entry, **either reuse a completed authoritative revalidation or run one immediate full cycle**,
  decided by [the entry-revalidation predicate](#entry-revalidation-is-evidence-based) — never by the
  producing flow's name;
- while **visible**, schedule the next revalidation **after the previous attempt settles**,
  recursively — **never `setInterval`**, **never two identical attempts in flight**;
- **pause the timer while hidden**;
- revalidate **immediately** on `visibilitychange` to visible, `pageshow`, and window focus,
  **coalescing** concurrent signals into one attempt;
- expose **`Erneut versuchen`** for an immediate user-requested attempt;
- **reset the next periodic deadline** after any manual or lifecycle-triggered attempt;
- use an `AbortController` and a **monotonically increasing attempt token**;
- **abort and supersede** on selection change, `Auswahl ändern`, successful recovery, unmount, or
  configuration failure, and **discard every late completion**.

#### Entry revalidation is evidence-based

Whether the coordinator repeats the catalogue reads on entry is decided by **what has demonstrably
already completed**, not by which flow produced the entry. Rationale in
[ADR 0005](../decisions/0005-responsive-web-schedule.md#entry-revalidation-is-decided-by-evidence-not-by-the-flows-name).

**Qualifying entry evidence** requires **all** of:

| # | Condition |
| --- | --- |
| 1 | the required fresh `listProviders` read **completed successfully** |
| 2 | the confirmed provider was validated as **existing, official, and non-demo** |
| 3 | fresh `listServiceAreas` **completed successfully** for that provider |
| 4 | the confirmed area was validated as **belonging to that provider and still available** |
| 5 | its capability **passed the existing validation** |
| 6 | the results belong to the **current entry-producing request flow and confirmed pair** |
| 7 | the results were **not invalidated** by unrelated supersession or a selection change before handoff |

- an intervening collection-events retry **does not** disqualify the evidence; the existing rule for
  reconciliation followed by a terminal exact range problem is unchanged;
- **"fresh"** means the required authoritative gateway reads newly completed in that flow. It makes
  **no** claim about the server's official-source cache. Add **no** freshness TTL, client cache, or
  new periodic mechanism;
- a **fresh area-only draft-selection read does not qualify** — it proves nothing about the confirmed
  provider;
- **never infer** eligibility from a non-null `confirmedSelection`, from retained objects, or from the
  word "reconciliation". Carry the evidence in the **existing entry-producing request context**,
  extended with only the minimal internal handoff information the predicate needs. It is **not** a new
  product state, `ApiFailure` subtype, or rendered diagnostic.

**With qualifying evidence:**

- count that completed validation as the coordinator's **initial entry revalidation**;
- issue **no** immediate `listProviders` or `listServiceAreas`;
- establish **exactly one** coordinator;
- schedule the next periodic attempt by the existing 15-minute **settle-based** rule — the
  entry-producing flow's completion counts as the reused initial cycle's completion;
- keep later eligible Retry, focus, visibility, and periodic triggers available under the existing
  coalescing rules.

Qualifying paths include, and are not limited to, **the initial authoritative confirmed-selection
pipeline**; **a user-requested authoritative restart**; **bounded reconciliation producing a locally
uncovered capability**; **bounded reconciliation followed by a terminal exact range problem**; **a
source-date replacement pipeline** that obtains fresh provider/area data and then finds no requestable
range; and any other documented authoritative refresh path satisfying the predicate.

**Without qualifying evidence** — a legitimate entry resting only on retained or stale metadata — run
**one immediate complete cycle**:

```text
fresh providers
→ provider validation
→ fresh service areas
→ area/capability validation
→ current source-local date and range
→ collection events only when requestable
```

then follow the ordinary recovery outcomes and scheduling below.

**Ownership handoff.**

- validate the **producer** as current **before** the transfer; the transfer is a legitimate ownership
  change and must **not** invalidate the evidence it carries;
- **stale producer cleanup must not clear the new coordinator's ownership**;
- evidence from a **superseded** producer creates **no** entry, hands **nothing** over, and suppresses
  **none** of the current owner's required work;
- absence of evidence never **creates** an entry: an unrelated `schedule_pipeline` failure or an
  invalidated selection keeps its existing transition;
- an **already active** coordinator that completes fresh validation and remains uncovered keeps that
  coordinator and schedules its next attempt — an ordinary attempt, **not** a new entry repeating the
  initial cycle;
- **reuse suppresses only the duplicate initial cycle**; later attempts still perform authoritative
  reads;
- signals already **coalesced into** the completing flow are **not** replayed as a second entry cycle;
  genuinely later eligible signals remain actionable.

Every coordinator request is assigned `phase: 'range_recovery'`. Manual Retry, timer, focus,
`pageshow`, and visibility signals share one coalescing gate. Per
[the canonical Retry table](../decisions/0005-responsive-web-schedule.md#erneut-versuchen-is-phase-aware-not-operation-routed),
manual Retry retains the confirmed pair, coalesces with or supersedes active recovery, allocates a new
recovery token and controller, and starts a complete cycle at fresh providers. The next 15-minute
deadline resets after that cycle settles.

**Recovery happens on the next delivered callback or lifecycle signal, not at a hard real-time
deadline.** No 15-minute punctuality is claimed.

**Each attempt starts with fresh `listProviders`, then fresh `listServiceAreas`**, rereads the clock,
derives source-local today, and reclamps the range for the confirmed provider and area. It **never
builds a collection-events request from the expired capability snapshot**:

| Fresh capability says | Action |
| --- | --- |
| Provider removed, non-official, or `demo` | Invalidate the selection, **stop** the coordinator, return to the appropriate selection/catalogue state, **no** events request |
| Service area removed | Invalidate, **stop**, return to selection, **no** events request |
| Area now `unavailable` | Invalidate, **stop**, show needs-selection with the documented explanation, **no** events request |
| Available, fresh validity **still** yields no range | **Stay** in `range_not_covered`, render no schedule, schedule the next attempt |
| Yields a **requestable range** | Run the full capability → range → collection-events → cross-field and metadata-consistency pipeline |

On a requestable range, **show no schedule until a matching response passes
[the final source-date gate](#5d-the-final-source-date-gate-before-publication)** against that
recovery cycle's snapshot, in **all three** of its outcomes — a mismatched candidate stays
unpublished, the episode remains `range_not_covered`, and the **same single coordinator** starts one
immediate replacement cycle; a **typed derivation failure** also publishes nothing, keeps the episode
and **that same coordinator**, and stores the local failure as the nested `lastRecoveryFailure` with
Retry and the periodic deadline intact; on acceptance
**stop the coordinator and start exactly one accepted-pair watchdog**.

**A failed recovery never fabricates coverage or strands the pair.** A transient `network`,
`timeout`, `problem`, or `invalid_response` from providers, areas, recovered events, or a
recovery-owned consistency check keeps `range_not_covered`, `confirmedSelection`, and the coordinator;
stores its `phase: 'range_recovery'` and unchanged real operation as nested `lastRecoveryFailure`;
announces the failed refresh through the live region; keeps `Erneut versuchen` available; and
schedules the next periodic attempt after settlement. A `requestId` appears **only** for a validated
`problem`. Never replace the range state with a selection/schedule error or start a duplicate request.

**The two diagnostics are owned separately, and neither may borrow from the other.**

| Field | Written by | Rule |
| --- | --- | --- |
| `triggeringRangeProblem` | the schedule pipeline, at entry | Populated **only** by a **terminal** exact range problem once the shared reconciliation budget is exhausted. **Absent** for a local capability-derived entry — including *first exact 422 → reconciliation → refreshed capability yields no requestable range*, where the earlier provisional 422 is **not** attached |
| `lastRecoveryFailure` | `phase: 'range_recovery'` alone | **Cleared when a new recovery cycle begins**, then populated only with that cycle's **current** renderable failure. A successful revalidation that remains uncovered leaves it **absent**. A `schedule_pipeline` failure is **never** placed here |

Both terminal paths populate the triggering problem — *first 422 → reconciliation → second 422* and
*metadata mismatch → reconciliation → exact 422*. **Two HTTP 422 responses are not required;
exhaustion of the one shared budget is.** Before storing the problem or changing state, check the
**attempt token, owning phase, and confirmed selection**.

`triggeringRangeProblem` survives the **whole range episode**; later recovery failures update
`lastRecoveryFailure` only. Leaving the episode, starting a new confirmed schedule episode, changing
selection, and authoritative invalidation discard both as appropriate, and **a new episode for the
same provider/area inherits neither**. Unmount discards ownership without updating an unmounted state.
A cancelled or superseded completion can **neither install, replace, nor restore** either diagnostic.

**Display:** the triggering problem's `requestId` under an **initial range-response** label; a
recovery problem's `requestId` under a **separate recovery** label. A recovery `network`, `timeout`,
or `invalid_response` **never borrows** the triggering identifier or an earlier recovery identifier.
A retained initial diagnostic may stay visible alongside a recovery diagnostic, and **no empty
diagnostic label is rendered** when no validated identifier exists. This changes no reconciliation
budget, retry count, or lifecycle ownership.

Provider absence/non-official/demo and area absence/unavailability are authoritative invalidation
outcomes, not transient failures. They clear the confirmed pair and **both diagnostics**, stop
recovery, return to selection, and offer no Retry for the obsolete pair.

**Exactly one mechanism owns scheduled work per confirmed selection. The two never run concurrently:**

| Transition | Result |
| --- | --- |
| Accepted schedule | accepted-pair watchdog |
| Range becomes uncovered | **stop** watchdog → recovery coordinator |
| New matching schedule accepted | **stop** coordinator → accepted-pair watchdog |
| Selection editing, clearing, unmount | **stop both** |

**Provider and service-area selection loading owns neither.**

### 9. Boundary guards

`apps/web/src/boundaries.test.ts`, adapted from `apps/extension/src/boundaries.test.ts`:

- **`@abfall-radar/api-client` is imported only inside the named data layer, `src/adapters/`**, and
  HTTP ownership stays there. Application code **reaches** it through that adapter boundary — the
  intended `main.tsx` → hook → adapter → `api-client` path is **permitted**, because only the adapter
  module imports the package. What is forbidden is **bypassing** the boundary: a direct
  `@abfall-radar/api-client` import from outside `src/adapters/`, and any re-export that forwards its
  surface to a module outside it. "Reaching api-client transitively through the adapter" and
  "importing api-client" are different things, and the guard asserts the second;
- **no module anywhere calls `fetch` directly** outside the data layer;
- no module imports anything from `apps/extension`;
- no module imports `@abfall-radar/data-providers`, and the manifest declares no dependency on it;
- **no module imports `getUpcomingEvents` or `getRelativeDateLabel`** from `@abfall-radar/domain`, so
  the ambient-date rule holds mechanically rather than by memory;
- **no production entry reaches a protected test or fixture module**, per
  [the production dependency guard](#the-production-dependency-guard). **Import extraction is
  parser-based**: the extension walker's `specifiersOf` and `withoutCommentLines` are **not** reused —
  they drop whole comment lines and cannot tell an import from import-shaped text — and are replaced
  by TypeScript-compiler-API AST traversal, with syntax validity from a `Program`'s public
  `getSyntacticDiagnostics`, per
  [parser-based import extraction](#import-extraction-is-parser-based-not-regex-and-line-stripping).
  Only that file's resolution strategy, transitive walk, and fail-closed behaviour carry over. This
  assertion lives here
  because this file already owns the workspace's import-graph walk, and it therefore runs in
  `apps/web`'s ordinary Vitest suite — inside `pnpm check`, **mandatory**, never a manual step or an
  optional script;
- the checks scan a meaningful number of files, so none of them can pass vacuously.

A separate assertion in the **same `apps/web` test file** covers `packages/ui`: no module in that
package calls `fetch`, imports `@abfall-radar/api-client`, or performs transport mapping. It lives
here rather than in `packages/ui` because that package declares no test runner, and adding one would
be both a change to a workspace this task must not touch and a dependency addition outside
[the table](#manifest-and-dependency-changes).

### 10. Documentation

Update `apps/web/README.md` (the data layer, the same-origin assumption and the dev proxy, the states
including the successful-empty ones, the session-only trade-off, the manual-verification scope, and
the commands), and the root `README.md` milestone section. Link ADR 0005; do not restate it. Update
`docs/architecture/repository-structure.md` only where the implemented boundary reveals a gap.

## The one permitted extension edit: a comment correction

**Scope: exactly one doc comment, in exactly one file, during the AR-005 implementation session.**
This permission belongs to that future session. The current documentation session does **not** edit
the extension, and this section is the record of what will be allowed, not an instruction to act now.

**File:** `apps/extension/src/adapters/collection-event.ts` — the closing paragraph of the
`toDomainCollectionEvent` doc comment, which currently reads:

> It lives in the extension until a second consumer exists, per the rule that a shared abstraction
> waits for a real second consumer.

**Why it must change.** That sentence states the superseded consumer-count rule. The canonical rule is
[the two permitted grounds](../architecture/repository-structure.md#the-two-permitted-grounds), which
applies `docs/ai/shared-rules.md`'s mandatory wording — *create a new shared abstraction after a real
second consumer exists **or** when a stable domain boundary already requires it*. The web application
**is** that second consumer, and
[ADR 0005](../decisions/0005-responsive-web-schedule.md#transport-to-domain-mapping-stays-consumer-local-and-nothing-is-extracted)
records that the adapter still stays local — so the comment now promises a trigger that has already
fired and did not cause extraction. Left as it is, the next reader either extracts on the count or
concludes the documented rule is not followed.

**What the replacement must say**, in the file's existing voice:

- the adapter stays in the extension because **no permitted ground for extraction is met**, not
  because a consumer has yet to appear;
- **a second consumer alone does not require extraction** — its arrival triggers a comparison;
- extraction may be justified by **demonstrated duplicated behavior** **or** by an **already
  established stable domain boundary**, either one, not both;
- **speculative future reuse establishes no stable domain boundary**;
- a pointer to the canonical rule and ADR 0005 rather than a restatement of either.

**What must not change.** Runtime behaviour, imports, exports, types, declared dependencies, and the
adapter's logic stay exactly as they are. No renaming, reordering, reformatting, or unrelated comment
cleanup rides along: the diff for this file must consist solely of lines inside that doc comment, and
the extension's existing tests must pass unchanged without being edited.

**This is the only permitted `apps/extension` edit.** Every other prohibition on touching that
workspace — the non-goal, the boundary acceptance criteria, and the handoff instruction — stands, and
each now points here rather than contradicting this exception. Nothing here authorizes importing from
the extension, changing its product behavior, or extracting anything.

## Non-goals

- PWA manifest, service worker, install prompt, offline mode, persistent schedule cache, background
  sync, and push notifications.
- Accounts, authentication, saved addresses, cross-device synchronization, and server-side user state.
- Any persistence of the selection, including `localStorage`, `IndexedDB`, and cookies.
- **Waste-type filtering, waste-type preferences, a `visibleWasteTypes` setting, and the
  unpublished-selected-type state that only exists once a person can select a type.** A later
  milestone owns all four.
- **Playwright, any other browser test runner, screenshot tooling, and visual-regression tooling**,
  and with them any automated assertion about layout, viewport width, element dimensions, horizontal
  overflow, or rendered focus appearance.
- Web reminders and browser notifications.
- Maps, recycling points, geocoding, routing, and location permission.
- API deployment, hosting, DNS, TLS, a production domain, and production CORS.
- Any CORS configuration added to `apps/api`, including for local development.
- A manual fixture mechanism, a debug control, clock control, or browser automation — including
  anything added purely to make a conditional live scenario reachable.
- New providers or service areas added to make provider or area switching live-verifiable.
- Changes to official ICS ingestion, provider manifests, event identity, API routes, the problem
  catalogue, or Problem Details.
- New providers or new service areas.
- Any change to `apps/extension` product behavior, and any import from it. **One comment-only
  exception applies** — see
  [the extension comment correction](#the-one-permitted-extension-edit-a-comment-correction).
- Any new shared package, and specifically any `shared` or `common` package.
- Moving a component into `packages/ui`.
- Changes to `packages/domain` and `packages/api-client`, including re-signing the ambient-date
  schedule helpers.
- Mobile application implementation.
- SEO, SSR, and a marketing website.

## Manifest and dependency changes

Classified against the current manifests. `apps/web/package.json` today declares no `exports`, no
`scripts`, and no dependencies.

| Change | Where | Status |
| --- | --- | --- |
| `@abfall-radar/api-client` (`workspace:*`) | `apps/web` | Added |
| `@abfall-radar/domain` (`workspace:*`) | `apps/web` | Added |
| `@abfall-radar/ui` (`workspace:*`) | `apps/web` | Added |
| `react`, `react-dom` | `apps/web` | Added, `catalog:` |
| `lucide-react` | `apps/web` | Added, `catalog:` — the non-color status and provenance cues; already the repository's icon set |
| `vite`, `@vitejs/plugin-react` | `apps/web` | Added, `catalog:` devDependencies |
| `tailwindcss`, `@tailwindcss/vite` | `apps/web` | Added, `catalog:` devDependencies — required by `packages/ui`'s `@theme inline` block, not a new framework choice |
| `vitest`, `jsdom` | `apps/web` | Added, `catalog:` devDependencies; jsdom is also reused for inert emitted-HTML and JSX character-reference decoding |
| `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom` | `apps/web` | Added, `catalog:` devDependencies |
| `@types/react`, `@types/react-dom` | `apps/web` | Added, `catalog:` devDependencies |
| `@types/node` | `apps/web` | Added, `catalog:` devDependency — **tooling only**, for `vite.config.ts` and `vitest.config.ts`; no production module may import a `node:*` built-in |
| `typescript` | `apps/web` | Added, `catalog:` devDependency for `typecheck`; reused for both source-graph extraction and emitted-JavaScript AST/literal inspection with public syntax diagnostics and no emit |
| `postcss` **8.5.28** | `apps/web`, via a **new** catalogue entry | **Approved `catalog:` devDependency** — [owner approval recorded](#dependency-approval-record); not yet installed. Required by [CSS dependency extraction](#extracting-css-dependencies). A `postcss@8.5.22` exists in the pnpm store as a Vite/Tailwind transitive, but it is **not resolvable from a workspace** and is **not** the approved version |
| `postcss-value-parser` **4.2.0** | `apps/web`, via a **new** catalogue entry | **Approved `catalog:` devDependency** — [owner approval recorded](#dependency-approval-record); not yet installed. Parses CSS preludes/values for dependency traversal and emitted-URL inspection; escaped token values also require the contextual decoder. Not present in the store |
| `dev`, `build`, `test`, `test:watch`, `typecheck`, `test:build-output` scripts | `apps/web` | Added |
| `@abfall-radar/web#test:build-output` task | `turbo.json` | Added, `dependsOn: ["@abfall-radar/web#build"]` **and `cache: false`** |
| `verify:web-build-output-task` script, and `check` extended with it **after** `build` as a root shell step | root `package.json` | Modified |
| `scripts/verify-web-build-output-task.mjs` — the outer meta-verifier: Node 24 ESM, not typechecked, Biome-covered, outside `apps/web` and outside the Turbo graph | root | **New** |
| `pnpm-lock.yaml` | Root | Regenerated by `pnpm install` |

**Every other version already exists in `pnpm-workspace.yaml`'s catalogue. This task adds exactly two
catalogue entries and makes exactly two version decisions**, both approved by the owner:

| Approved catalogue entry | Approved version | Declared as |
| --- | --- | --- |
| `postcss` | `8.5.28` | `catalog:` devDependency of `apps/web` |
| `postcss-value-parser` | `4.2.0` | `catalog:` devDependency of `apps/web` |

**These are approved versions, not verified installations.** Neither package is in the catalogue
today. The store's `postcss@8.5.22` is a transitive of the build tooling, is not resolvable from a
workspace under pnpm isolation, and is not the approved version;
`postcss-value-parser` is not installed at all. No compatibility claim is made beyond what the
implementation's own checks will establish.

The scope is narrow: those **two** catalogue entries, both declared only in `apps/web`, with every
unrelated catalogue version unchanged and no other manifest gaining a dependency.

### Dependency approval record

**Approval status: recorded.** The condition for removing the dependency blocker was **owner approval
of both packages at both versions**, and it is met:

| Field | Record |
| --- | --- |
| Approved by | The repository owner |
| Date | 2026-09-15 |
| Packages and exact versions | `postcss` **8.5.28** and `postcss-value-parser` **4.2.0** — both packages, each at exactly that version |
| Declared as | `devDependencies` of `apps/web` only, each through `catalog:` |
| Catalogue change | Exactly two new `pnpm-workspace.yaml` catalogue entries — `postcss: 8.5.28` and `postcss-value-parser: 4.2.0` — with no other catalogue version changed |

**The approval is exactly that scope and nothing wider.** It does not cover another version of either
package, a runtime `dependencies` entry, a declaration in any other workspace or in the root manifest,
a PostCSS plugin, or any other package. If implementation finds that either exact version cannot be
used as specified — for example an installation or peer-resolution failure, or parse behaviour that
contradicts [CSS dependency extraction](#extracting-css-dependencies) — it stops, reports the
evidence, and asks again; the task returns to **Blocked** until a new decision is recorded here.

The approval was recorded by a documentation-only session. It performed **no** catalogue, manifest,
or lockfile change and no installation. That session confirmed only that both exact versions are
published on the npm registry; compatibility with this repository is established by the
implementation's own checks, not assumed.

**Any dependency discovered during implementation beyond this table requires stopping and asking for
approval.** That explicitly includes **Playwright or any other browser test runner**, screenshot or
visual-regression tooling, a router, a state-management library, a data-fetching library, a PWA
plugin, a component library, a date or time-zone library, a form library, and any additional test
utility. `strict-peer-dependencies` is enabled: an unmet peer must be declared explicitly rather than
by relaxing the setting.

### Documentation review record

| Field | Record |
| --- | --- |
| Reviewer | Codex, the independent reviewer per `AGENTS.md` |
| Date | 2026-09-15 |
| Scope | The documentation-only changes: this task, ADR 0005, and `docs/architecture/repository-structure.md` |
| Verdict, verbatim | "No actionable defects found in these documentation-only changes. Diff whitespace and 86 local file-link checks passed; runtime tests and manual UI verification were not run, so AR-005 implementation acceptance remains unverified." |

**What this record is and is not.** It closes the documentation review that
[`docs/ai/workflow.md` §4](../ai/workflow.md#4-codex-reviews) requires before implementation begins,
alongside committing these documents. It is **not** the implementation review, and it is **not**
the `APPROVE` that [§6](../ai/workflow.md#6-codex-performs-final-review) requires for human
acceptance: as the verdict itself states, no runtime test and no manual UI verification had run, so
**AR-005 implementation acceptance remains unverified** until the implemented change is reviewed.

## Expected files

**Modified — `apps/web`**

- `package.json`, `README.md` — the two tracked files.

**New — `apps/web`**

- `index.html`, `vite.config.ts`, `vitest.config.ts`, `vitest.build-output.config.ts`, `tsconfig.json`;
- `src/main.tsx`, `src/app/` (composition and the responsive shell), `src/app/styles.css`;
- `src/adapters/browser-origin.ts`, `src/adapters/api-client.ts`, `src/adapters/schedule-gateway.ts`,
  `src/adapters/collection-event.ts`;
- `src/schedule/source-day.ts`, `src/schedule/source-date-watchdog.ts`,
  `src/schedule/range-recovery-coordinator.ts`,
  `src/schedule/collection-window.ts`, `src/schedule/schedule-range.ts`, `src/schedule/view-state.ts`;
- zone-pinned sibling test files east and west of `Europe/Berlin`, each setting `process.env.TZ`
  before a dynamic import, mirroring `apps/extension/src/schedule/collection-window.*-of-utc.test.ts`;
- `src/hooks/` (the catalogue and schedule lifecycles);
- `src/features/selection/`, `src/features/schedule/`;
- `src/boundaries.test.ts`;
- `src/test/build-output-scanner.ts` and `src/test/build-output.verify.ts` — shared inert scanner and
  the sole dist-reading entry, respectively; the ordinary suite excludes the latter explicitly;
- `src/test/setup.ts` and `src/test/fixtures.ts`, including an offered non-demo provider whose area
  list mixes an `available` and an `unavailable` area; a **two-provider, two-areas-each** catalogue for
  the switching and supersession tests the live catalogue cannot reach; a schedule whose first event is
  curbside and whose later event is a mobile drop-off; and the empty-catalogue, all-unavailable, and
  same-day-drop-off fixtures the [test matrix](#test-matrix) needs. Every schedule fixture parses
  through the `@abfall-radar/api-client` response validator. Written for this repository, not derived
  from the demo provider, and not wired into any product surface. **API-origin fixtures here use
  reserved `*.example.test` origins**, per [Fixture URL policy](#fixture-url-policy);
- `src/test/build-output-fixtures/` — the artifact-verifier positive and negative fixtures. Inert
  data only, exercised through deterministic local transports; **positive** fixtures carry the exact
  sanctioned literals and **negative** fixtures carry real literals in forbidden contexts and their
  near-match variants. Test data by location and name, so the first-party source guard excludes it;
- tests alongside the modules they cover.

**Modified — root and docs**

- `pnpm-lock.yaml`, `README.md`.
- `apps/extension/src/adapters/collection-event.ts` — **the doc comment only**, per
  [the extension comment correction](#the-one-permitted-extension-edit-a-comment-correction). Record
  the before and after text in the handoff.
- `docs/architecture/repository-structure.md` **only if** the implemented boundary reveals a gap the
  document does not already describe. Report it in the handoff if it is touched.

**Modified — root tooling, precisely scoped**

- `turbo.json` — add `@abfall-radar/web#test:build-output` with
  `dependsOn: ["@abfall-radar/web#build"]` and **`cache: false`**. **No other task's caching changes**;
  the web `build` stays cacheable.
- `package.json` (root) — add `verify:web-build-output-task` running the new `scripts/` file, and
  extend `check` with it **after** `build` as a **root shell step outside the Turbo graph**. No other
  script is touched.
- `scripts/verify-web-build-output-task.mjs` — **new**, the outer meta-verifier. Node 24 ESM
  JavaScript, **not typechecked** (no `tsconfig` covers root `scripts/`), **covered by Biome**,
  validating Turbo JSON at runtime. Not a Turbo task, not a Vitest test, never invoked from inside a
  Turbo task.
- `pnpm-workspace.yaml` — **only** to add the two catalogue entries `postcss: 8.5.28` and
  `postcss-value-parser: 4.2.0`, which the owner approved per
  [Dependency approval record](#dependency-approval-record). No other catalogue version is touched.

Both are required by [Build and verification ordering](#build-and-verification-ordering) and are the
only permitted changes to either file.

**Not modified**

- `apps/api`, `packages/*`, `biome.json`. A change to any of these is outside this task and needs
  approval with a stated reason.
- `apps/extension`, with **exactly one** documented exception: the doc comment in
  `apps/extension/src/adapters/collection-event.ts` described in
  [the extension comment correction](#the-one-permitted-extension-edit-a-comment-correction). That
  edit is **comment-only** — no runtime behaviour, imports, exports, types, dependencies, or adapter
  logic — and every other file in that workspace stays untouched. Anything beyond it needs approval
  with a stated reason.

## Acceptance criteria

### Workspace and dependencies

- [ ] `apps/web` builds, typechecks, and tests through Turborepo, and `pnpm check` covers it.
- [ ] **Owner approval of `postcss` 8.5.28 and `postcss-value-parser` 4.2.0 is recorded before either
      is added.** Recorded on 2026-09-15 in [Dependency approval record](#dependency-approval-record);
      the handoff confirms that neither package was added at another version or outside that scope.
- [ ] Every added dependency resolves through `catalog:` or `workspace:*`. `pnpm-workspace.yaml`
      gains **exactly two** entries — `postcss: 8.5.28` and `postcss-value-parser: 4.2.0` — both
      declared as `apps/web` `catalog:` devDependencies. **Every unrelated catalogue version is
      unchanged**, asserted on the diff, and no other manifest gains either package.
- [ ] No router, state-management library, query library, PWA plugin, component framework, second CSS
      framework, browser test runner, or screenshot tooling is present.
- [ ] `biome.json` is unchanged, and `turbo.json` and the root `package.json` change **only** as
      [Build and verification ordering](#build-and-verification-ordering) requires.

### Boundaries

- [ ] Check 1b validates the entire [closed HTML source shell](#the-html-entry-has-a-closed-source-shell)
      before walking its one script edge. Additional HTML resources and build-entry/public-copy
      channels are rejected, including URL-free fixtures. The actual resolved Vite configuration and
      declared build command are checked; this assertion never compares emitted HTML to source bytes.
- [ ] Check 1 detects escaped JavaScript, JSX, and CSS literal origins using contextual decoding, without
      inheriting emitted-output exemptions.

- [ ] No module outside `src/adapters/` **imports or re-exports** `@abfall-radar/api-client`, proven by
      an import-graph test asserted on each module's **own specifiers**. The intended
      `main.tsx` → hook → adapter → `api-client` path is **permitted**: reaching the package through
      the adapter boundary is the architecture, and only bypassing that boundary is forbidden.
- [ ] No module outside `src/adapters/` calls `fetch`, proven by a source scan across the workspace.
- [ ] No module imports anything from `apps/extension`, and no browser-extension API is referenced.
- [ ] No module imports `@abfall-radar/data-providers`, and the manifest declares no dependency on it.
- [ ] No module imports `getUpcomingEvents` or `getRelativeDateLabel` from `@abfall-radar/domain`.
- [ ] `packages/ui` performs no data fetching and no transport mapping, asserted rather than assumed.
- [ ] `@abfall-radar/api-client` still does not depend on `@abfall-radar/domain`, and the
      transport-to-domain adapter lives in `apps/web`.
- [ ] No new package is created, and no `shared` or `common` package exists.
- [ ] `apps/api` and every `packages/*` workspace are unchanged. `apps/extension` is unchanged
      **except** for the single permitted comment correction in
      `apps/extension/src/adapters/collection-event.ts`, per
      [the extension comment correction](#the-one-permitted-extension-edit-a-comment-correction).
- [ ] **That edit is comment-only**: the extension's runtime behaviour, imports, exports, types,
      dependencies, and adapter logic are byte-for-byte unchanged, and no unrelated formatting or
      cleanup rides along. Asserted on the diff — the changed lines are inside the doc comment and
      nowhere else — and by the extension's own test suite passing unchanged.
- [ ] **The replacement comment agrees with
      [the canonical extraction rule](../architecture/repository-structure.md#the-two-permitted-grounds)**:
      a second consumer alone does not require extraction; extraction may be justified by
      demonstrated duplicated behavior **or** by an already established stable domain boundary; and
      speculative future reuse establishes no such boundary.

### Network boundary

- [ ] Runtime product code issues same-origin API requests, constructed from the document's own
      origin.
- [ ] `apps/web` constructs `@abfall-radar/api-client` with one browser `FetchLike` wrapper that
      overrides `RequestInit.cache` last to exactly **`'no-store'`** on every
      `listProviders`, `listServiceAreas`, and `listCollectionEvents` request.
- [ ] The wrapper preserves the API client's method, headers, abort signal, and every other supplied
      `RequestInit` member; a conflicting caller-supplied cache mode cannot override **`'no-store'`**.
- [ ] Retry, reconfirmation, source-midnight refresh, focus/visibility revalidation, 422
      reconciliation, and range recovery all use the same wrapped gateway/client boundary; no raw
      `fetch` or second client is used.
- [ ] Recording fake `FetchLike` tests exercise all three reads and these lifecycle paths without
      real network access, asserting exact **`cache: 'no-store'`** and preserved request options.
- [ ] Browser `cache: 'no-store'` is documented separately from the absence of persisted schedule,
      offline schedule, service-worker, IndexedDB, and local-storage caches, and from the API's
      deliberate server-side official-source cache.
- [ ] **`apps/web/src/**`, excluding test files and `src/test/` fixture data, contains no hard-coded
      absolute API origin**, proven by a source scan that does not read `vite.config.ts`, fixtures, or
      documentation. The fixture exclusion is what lets the sanctioned verifier fixtures exist, per
      [Fixture URL policy](#fixture-url-policy).
- [ ] **A correct `vite.config.ts` cannot fail the host scan**, because that file is build tooling
      rather than production runtime application source.
- [ ] **`apps/web/vite.config.ts` contains exactly the development proxy target
      `http://127.0.0.1:3000`**, asserted positively, and no other absolute API origin.
- [ ] **The proxy context is exactly `^/api(?:/|$)`**, segment-aware rather than a plain `/api`
      prefix key, asserted against the resolved configuration: it matches `/api`, `/api/`, and
      `/api/v1/providers`, and does **not** match `/apiary`, `/api-old`, `/apis`, or `/application`.
- [ ] **Every emitted production HTML, JavaScript, and CSS asset is inspected under
      [the canonical emitted-URL policy](#the-four-sanctioned-categories).** The only sanctioned
      cases are that table's four, and **every other detected absolute HTTP(S) URL occurrence is
      rejected.** Each keeps its own matching restriction — namespace identifiers by documented exact
      literal, Tailwind by genuine CSS-comment context with the verified banner, React by the complete
      decoded value `https://react.dev/errors/` of an ordinary string literal or a no-substitution
      template literal, and [the Zod IPv6 scaffold](#the-zod-ipv6-url-parsing-scaffold-exemption) by
      its exact shape, interpolation form, and enclosing `try`/`catch` context — and **none is
      broadened into a hostname, package, or URL-prefix allowlist**. Asserted by the **emitted-artifact verifier** against a **fresh** build,
      never by the ordinary test suite, which must not read `dist`.
- [ ] **Positive:** the **normal pinned React and Tailwind production build passes with its sanctioned
      dependency literals present** — Tailwind's real license banner and React DOM's exact
      `https://react.dev/errors/` prefix — provided the rest of its output satisfies the origin
      policy. Nothing is stripped, patched, rewritten, or downgraded to a development build to obtain
      a pass.
- [ ] **Negative:** an **additional prohibited URL fails through the same authoritative verifier the
      root check uses**, not a separate or weakened path. This includes `https://tailwindcss.com`
      outside its comment and `https://react.dev/errors/` outside a permitted complete JavaScript
      literal — in an HTML attribute, a CSS string, `url(...)`, `@import`, or a **substituted**
      template literal — and any `https://react.dev` value that is not exactly the sanctioned
      prefix.
- [ ] Neither `https://tailwindcss.com` nor `https://react.dev` is in any global URL or hostname
      allowlist, and neither is classified as a non-network namespace identifier.
- [ ] The React exemption **grants first-party code nothing**: using that address as an API base URL
      or fetch destination in `apps/web/src/**` is rejected by the first-party source scan, and the
      gateway's same-origin plus `cache: 'no-store'` contract is unchanged.
- [ ] `test:build-output` depends on `@abfall-radar/web#build` in `turbo.json`, is declared
      **`cache: false`**, and **every documented invocation goes through Turbo**.
- [ ] **The inner task inspects artifacts only.** It makes no claim about Turbo execution or cache
      replay, never invokes Turbo, never invokes itself, and never parses a parent run summary.
- [ ] **`pnpm verify:web-build-output-task` owns the Turbo-behaviour assertions** — resolved
      `cache: false`, the same-workspace build dependency, and two runs both observed as executed with
      caching bypassed — as a **root shell script outside the Turbo graph**, never a Turbo task and
      never a Vitest test.
- [ ] Root `check` invokes that script as a **sequential step after** the ordinary Turbo graph
      completes; **no Turbo task calls it, another `turbo run`, or itself**.
- [ ] The two-run proof reads **structured Turbo evidence** — `cache.status` and the `execution`
      block from `--summarize` — and **never** infers execution from replayed stdout.
- [ ] **Caching is disabled only for the verifier.** The web `build` remains cacheable and its output
      may be restored from cache; no unrelated task's caching changes.
- [ ] **No document presents `pnpm --filter @abfall-radar/web test:build-output` as authoritative**;
      `pnpm --filter` does not honour `turbo.json` dependencies.
- [ ] **No environment-dependent production host is invented**: no build-time or runtime environment
      variable supplies an API origin.
- [ ] No real or placeholder production API domain is committed anywhere in the workspace.
- [ ] **Absolute URLs in tests and documentation are scoped by
      [the canonical fixture policy](#fixture-url-policy), not banned outright:**
      - fixtures representing **API origins or API-base configuration** follow the existing
        loopback / reserved `*.example.test` rules, plus the documented development-proxy literal;
      - **artifact-verifier fixtures** follow that policy and **may contain the required real values
        of every category in [the canonical table](#the-four-sanctioned-categories)** — namespace,
        Tailwind, React, and the Zod IPv6 scaffold;
      - **negative verifier fixtures may also contain those literals in forbidden contexts** and the
        necessary near-match variants — modified paths, queries, fragments, or banner content;
      - **documentation may record** these literals, the rules, and rejection examples;
      - none of that fixture or documentation content **authorizes a production API destination or a
        real network request** — those fixtures stay inert data on deterministic local transports;
      - **source-attribution payload fixtures** remain governed by their data contract: source
        metadata inside payload data is **not** an API-origin setting.

      Permission to include a string in fixture data and the scanner's expected verdict are separate
      matters — a negative fixture must be able to contain the value it proves is rejected.
- [ ] `apps/api` gains no CORS configuration.
- [ ] The **serialized global origin** is authoritative for whether the context has a usable tuple
      origin; `location.origin` alone never proves one.
- [ ] `"null"`, empty, malformed, non-HTTP(S), and otherwise opaque global origins produce an explicit
      stated configuration failure **before** any request is issued.
- [ ] The usable global origin and the location origin must **agree after normalization**;
      disagreement is a configuration failure.
- [ ] A sandboxed frame with global origin `"null"` and location origin `https://sandbox.example.test`
      fails configuration and issues **no** request.
- [ ] `document.domain` is never read or assigned, and there is **no fallback** to loopback or any
      other origin.
- [ ] Every response is accepted only after `@abfall-radar/api-client`'s runtime validation.
- [ ] The data layer is injectable, so every product state below is reachable from a test with no
      network, no real server, and no debug control in the product.

### Product slice

- [ ] The application starts in the needs-selection state, and no schedule request is issued before an
      area is confirmed.
- [ ] A provider whose `sourceKind` is `demo` is never offered, and no service-area request is issued
      for one.
- [ ] No service-area request is issued before the provider is verified against a **successful**
      catalogue.
- [ ] An empty provider list, and a list containing only demo providers, both render the
      `no_official_providers` copy — neither as a loading state nor as an error — and issue no
      service-area and no collection-events request.
- [ ] An empty service-area list renders the `no_service_areas` copy, not an error, and issues no
      collection-events request.
- [ ] A list in which every area is `unavailable` renders all areas with their explanations and
      disabled semantics, and is **not** reported as an empty list.
- [ ] An `unavailable` area is visible with an explanatory German label while an `available` area in
      the same list stays selectable.
- [ ] An `unavailable` area is a native control with the native `disabled` attribute: it is skipped by
      sequential `Tab` navigation, exposes its disabled state through the accessibility tree, and
      cannot be selected or confirmed by click, Enter, or Space.
- [ ] No `aria-disabled`-only or focusable pseudo-disabled substitute is used.
- [ ] Selection requires explicit confirmation.
- [ ] Changing the provider clears the area selection.
- [ ] Selection is session-only: no `localStorage`, `IndexedDB`, cookie, or server write occurs, and
      reloading returns to needs-selection.

### Navigation actions

- [ ] `confirmedSelection` and `draftSelection` are **separate values**, both `null` on first load;
      editing the draft never mutates the confirmed pair and never issues a collection-events request.
- [ ] Changing the **draft provider clears the draft area**; no service-area id crosses providers.
- [ ] **`Zurück`** is visible on the service-area loading, failure, empty, and list states; it
      supersedes and aborts the active area attempt, returns to the provider step, **retains the
      loaded catalogue**, clears the draft area, and issues **no** collection-events request.
- [ ] **`Auswahl ändern`** is visible on **every** post-confirmation schedule surface with a confirmed
      selection — `loading`, `live` (`fresh` and `upstream_stale`), `empty`, `range_not_covered`, and every failure state —
      and **absent from `configuration_error`**.
- [ ] Activating it supersedes and aborts any capability or collection-events attempt, **stops the
      accepted-pair watchdog or range-recovery coordinator, whichever owns the current surface**,
      copies the confirmed pair into the draft, hides the schedule while editing, and issues no
      collection-events request before reconfirmation.
- [ ] **Reconfirming the same available area runs a new authoritative pipeline**, never a silent reuse
      of the previous result.
- [ ] **`Erneut versuchen` follows the request-owner-assigned phase** in
      [ADR 0005's canonical table](../decisions/0005-responsive-web-schedule.md#erneut-versuchen-is-phase-aware-not-operation-routed),
      never `failure.operation`, an endpoint name, provider-id presence, or
      `confirmedSelection` presence alone.
- [ ] Every retry aborts or supersedes the older attempt for its phase, allocates a **new
      monotonically increasing token**, discards late completions, and stays retryable after another
      failure.
- [ ] `no_official_providers` offers a catalogue refresh only; `no_service_areas` offers an area-list
      retry plus `Zurück`.
- [ ] **No superseded or aborted attempt updates UI state**, starts a watchdog, or replaces one.
- [ ] Focus lands on the documented destination for each transition, never on an unmounted element,
      never on `document.body`, and **never on a native-disabled unavailable area**.
- [ ] All three actions have accessible names, visible focus, and 44 by 44 CSS pixel targets.

### Failure context and phase-aware Retry

- [ ] The internal `FailureContext` is the exact four-member union from
      [ADR 0005](../decisions/0005-responsive-web-schedule.md#erneut-versuchen-is-phase-aware-not-operation-routed):
      `selection_providers`, `selection_areas` with `draftProviderId`, `schedule_pipeline` with
      `stage` and `confirmedSelection`, and `range_recovery` with `confirmedSelection`. Its `failure`
      is **phase-discriminated**, per
      [the canonical model](#5-view-state-derivation-and-event-ordering) — not one universal type:

      | Phase | Permitted failure |
      | --- | --- |
      | `selection_providers` | the real exported `ApiFailure` **only** |
      | `selection_areas` | the real exported `ApiFailure` **only** |
      | `schedule_pipeline` | `ScheduleFailure` — `ApiFailure` **or** `SourceDateUnavailable` |
      | `range_recovery` | `ScheduleFailure` — `ApiFailure` **or** `SourceDateUnavailable` |

      **A selection phase cannot carry a local source-date failure**, asserted at type level: the
      combination does not typecheck, because those phases never call `deriveSourceToday`.
      `RenderableApiFailure` and the rendered-state mapping are unchanged, so **`cancelled` still
      never reaches a rendered error state** in any phase.
- [ ] **The local branch uses the canonical `source_date_unavailable` discriminant** and carries
      **no** fabricated transport operation, HTTP status, or `requestId` — asserted positively, on the
      absence of those fields and on no `requestId` being rendered. It is **never** reinterpreted as
      `invalid_response`, and genuine API validation failures keep their existing
      `invalid_response` classification and `status: 0` rules untouched.
- [ ] **Phase ownership is explicit for a local failure even though no transport operation exists**:
      the request owner still assigns `schedule_pipeline` (with its `stage`) or `range_recovery` when
      the attempt starts, and that phase alone decides containment, actions, and Retry.
- [ ] **Schedule-owned** local failures follow
      [step 3c](#3c-source-date-derivation-failure-at-every-checkpoint)'s schedule error and Retry
      behaviour. **Recovery-owned** local failures stay nested in `range_not_covered` as
      `lastRecoveryFailure`, retaining the coordinator, `Erneut versuchen`, and periodic recovery, and
      never becoming a top-level `error`.
- [ ] The request owner assigns phase when an attempt starts. **For the API-failure branch**,
      `failure.operation` is never rewritten and remains `listProviders`, `listServiceAreas`, or
      `listCollectionEvents` according to the actual failed call, with the rest of its transport
      metadata exactly as that kind's existing type contract permits. This requirement is
      **branch-specific**: it does not apply to `source_date_unavailable`, which has no operation to
      preserve and must not be given one.
- [ ] `selection_providers` Retry creates a new selection-flow token and calls only `listProviders`;
      it invents no selection and starts no area or events request.
- [ ] For **ordinary area failures and `no_service_areas`**, `selection_areas` Retry retains only the
      draft provider, creates a new selection-flow token, calls only `listServiceAreas` for it,
      confirms no area, and starts no events request.
- [ ] **A current `ProviderNotFoundProblem` is recovered, not retried**: all four fields match
      exactly; ownership is checked before any effect; the loaded catalogue is invalidated as
      selection evidence; draft provider, draft area, and obsolete area data are cleared; the area
      attempt is superseded; and **exactly one** `listProviders` starts under `selection_providers`.
      The original failure keeps its `selection_areas` phase and `listServiceAreas` metadata. German
      recovery copy is announced and focus moves to the provider step heading. Refreshed choices show
      **nothing selected** — even for a reappearing provider — so areas are never re-requested
      automatically. An empty or demo-only refresh is `no_official_providers`; a failed refresh is
      retryable under `selection_providers`. **No** outcome confirms an area or requests events, and a
      catalogue invalidated this way is never re-offered through `Zurück`.
- [ ] `schedule_pipeline` Retry retains the confirmed pair; aborts/supersedes the old schedule
      attempt; creates a new token and controller; resets `reconciliationRemaining` to `1`; and runs
      fresh providers → fresh areas → new clock/source day → newly clamped range → conditional
      events → every acceptance check. This applies to failures on all three real operations.
- [ ] A reconciliation failure carries `phase: 'schedule_pipeline'`,
      `stage: 'reconciliation'`. Retry never continues its partial sequence: it begins a new attempt
      at providers with `stage: 'initial'`, a fresh budget, no provisional capability/range, and may
      reconcile once because it is a new attempt.
- [ ] `range_recovery` Retry retains the range state and confirmed pair, coalesces with or supersedes
      active recovery, creates a new recovery token/controller, and runs fresh providers → fresh areas
      → new clock/source day and range → conditional events. It resets the next 15-minute deadline
      after settlement and never strands periodic recovery after another transient failure.
- [ ] Failure kind controls German copy and `requestId`; phase controls Retry/actions. A validated
      `problem` may show its real `requestId` in any phase, and **no other failure kind does** —
      including `source_date_unavailable`, which renders its own German copy and live-region
      announcement in each phase that admits it while showing **no** identifier and never borrowing a
      retained `triggeringRangeProblem`'s.
- [ ] Changing phase supersedes and aborts the previous phase. Selection attempts cannot update
      schedule state; schedule attempts cannot update draft state; recovery cannot repaint after
      `Auswahl ändern` or another confirmation. Draft-provider change, confirmed-pair change, and
      unmount clear their owner's stale context, and late failures publish nothing.
- [ ] Every failed Retry remains retryable. No transient failure can permanently strand selection,
      a confirmed schedule attempt, or range recovery.

### The range-recovery coordinator

- [ ] Entering `range_not_covered` with a confirmed selection **removes the previously accepted
      schedule and relative-date labels before presenting the state**, **stops the accepted-pair
      watchdog**, **retains `confirmedSelection`**, and **starts the range-recovery coordinator**.
- [ ] The coordinator is **owned by `confirmedSelection`**, is **not** an accepted-schedule watchdog,
      and **never authorizes rendering a schedule or a relative-date label**.
- [ ] The expired capability is retained **only as last-observed metadata** and **never** builds a
      collection-events request.
- [ ] `RANGE_RECOVERY_INTERVAL_MS` is a named exported constant of `15 * 60 * 1000`, documented as an
      **AR-005 product/network trade-off, not an API contract**.
- [ ] Entry behaviour follows [the evidence predicate](#entry-revalidation-is-evidence-based), not the
      producing flow's name: entry **without** qualifying evidence performs one immediate complete
      cycle, while entry **with** it — from any authoritative flow — counts those completed
      provider/area reads as the initial entry revalidation and performs **no immediate duplicate
      read**. Both then schedule recursively **after the previous attempt settles**; never
      `setInterval`, never two identical attempts in flight, and paused while hidden.
- [ ] `visibilitychange` to visible, `pageshow`, window focus, and `Erneut versuchen` each trigger one
      **coalesced** immediate attempt, and each **resets the next periodic deadline**.
- [ ] Recovery uses an `AbortController` and a monotonically increasing token; selection change,
      `Auswahl ändern`, successful recovery, unmount, and configuration failure **abort and supersede**
      it; late completions are discarded.
- [ ] Every recovery outcome behaves as documented: provider removed / non-official / `demo`, area
      removed, and area `unavailable` each **invalidate the selection, stop the coordinator, and issue
      no collection-events request**; a still-uncovered fresh validity **stays** in
      `range_not_covered` and schedules the next attempt; a requestable range runs the **full**
      pipeline.
- [ ] On **gate-passing** acceptance, the coordinator **stops** and **exactly one** accepted-pair
      watchdog starts; a recovered response whose source date has moved is **not** published and the
      **same** coordinator runs one replacement cycle. On
      a transient provider, area, recovered-events, or recovery-owned consistency failure, recovery
      remains the lifecycle owner.
- [ ] A failed recovery attempt **fabricates no coverage**, keeps `range_not_covered` and
      `confirmedSelection`, stores `lastRecoveryFailure` with `phase: 'range_recovery'` and the real
      operation, announces it as nested diagnostic information, keeps Retry available, and schedules
      the next attempt. Only a validated `problem` shows a `requestId`.
- [ ] Provider/area absence or demo/unavailable reclassification is not stored as a transient failure:
      it invalidates the confirmed pair, clears nested recovery diagnostics, stops recovery, returns to
      selection, and offers no Retry for the obsolete pair.
- [ ] **At most one of the accepted-pair watchdog and the recovery coordinator owns scheduled work per
      confirmed selection; they never run concurrently.** Provider and service-area selection loading
      owns neither.
- [ ] Recovery is documented as happening on the **next delivered callback or lifecycle signal**, with
      **no 15-minute punctuality claim**.

### Source-local calendar days

- [ ] `sourceToday` is derived in the capability's declared zone with `formatToParts`, `gregory`, and
      `latn`, and is identical regardless of the device time zone.
- [ ] Upcoming events are selected by comparing `event.date` against `sourceToday` as ISO strings.
- [ ] Relative-day labels are computed from `event.date` and `sourceToday` by calendar-day arithmetic,
      and the absolute fallback is formatted with `Intl` pinned to `UTC`.
- [ ] No helper defaults a date parameter to an ambient `new Date()`, and no code constructs a
      local-midnight `Date` from a `YYYY-MM-DD` string.
- [ ] An event that is today in the source zone is neither filtered out nor labelled `Morgen` because
      of the device zone.

### The source-day lifecycle

- [ ] `sourceToday` is **not treated as immutable for the lifetime of the page**: one cancellable
      source-date watchdog runs per **accepted schedule/capability pair**.
- [ ] **A provisional capability never starts a watchdog.** Provider/area selection and a successful
      capability alone start none; only an accepted matching schedule/capability pair does.
- [ ] The first metadata mismatch or exact range problem starts no watchdog while the shared-budget
      reconciliation is in flight; a successfully reconciled matching pair starts exactly one; every
      terminal reconciliation or schedule failure leaves none running.
- [ ] The watchdog derives dates in **the accepted schedule's** matching source zone, never a
      provisional capability's.
- [ ] Selection change, the selection becoming unavailable or removed, unmount, and **replacement by
      another accepted pair** each cancel the previous watchdog.
- [ ] The watchdog **observes** the formatted source date and **never predicts a transition**: no
      binary search, no expanding horizon, no fixed hour bound, no adding a day, no offset
      arithmetic, and **no assumption that `formattedDate !== sourceToday` is monotonic**.
- [ ] Polling uses a **recursive `setTimeout`** at the exported `SOURCE_DATE_WATCH_INTERVAL_MS`
      (`1000`), never overlapping `setInterval` callbacks, and the constant is referenced rather than
      duplicated.
- [ ] Dates are derived only through the existing `Intl` source-zone formatter, and **no time-zone
      dependency is added**.
- [ ] The application is **not narrowed to `Europe/Berlin`**; the formatter supports whatever IANA
      data the runtime exposes, and AR-005 claims **no** historical-transition support via search.
- [ ] Polling is **suspended when the document is hidden** — the pending timeout is cancelled — and
      `visibilitychange` to visible, `pageshow`, and window focus each check ownership, derive the
      current date, and run the same change check.
- [ ] **Returning to visible on the same source date rearms the watchdog**: with the accepted pair
      still current, the replacement timeout is scheduled at the existing interval so **exactly one**
      pending watchdog timeout remains, and that branch issues **no** schedule network refresh. A
      **changed** date runs the authoritative refresh path instead and the superseded watchdog does
      **not** rearm itself; a **derivation failure** takes the accepted-pair local-error transition and
      **stops** that watchdog. A **stale, cancelled, or disposed** owner arms nothing, and closely
      spaced focus/visibility signals coalesce into **one** derivation and **one** timeout.
- [ ] Freshness is documented as bounded by **the next delivered callback or recovery signal**, not
      by wall-clock midnight, with browser scheduling delay named as outside the application's
      control. No document claims a visible tab necessarily runs on schedule, that the page always
      refreshes within one second, that nothing stale is ever shown, or that `Heute` can never
      briefly outlive midnight.
- [ ] On each check, the date is **derived from the actual current clock**, never by incrementing the
      previous value, and a change **in either direction** triggers the refresh.
- [ ] **The rearm regression, end to end, on fake timers with the injected clock**: accept a schedule →
      hide the document and assert the pending timeout is cancelled → return to visible **on the same
      source date** and assert **exactly one** pending timeout with **zero** schedule requests → then,
      with **no further focus or visibility event**, advance the clock through source midnight and the
      next polling deadline and assert the authoritative refresh path runs. Without the rearm the final
      step observes nothing, which is precisely what this case exists to catch.
- [ ] A changed `sourceToday` **supersedes and aborts** the current attempt, **clears any schedule
      that would otherwise read as current**, and starts a new `phase: 'schedule_pipeline'`,
      `stage: 'initial'` attempt with a new token, controller, and shared reconciliation budget before
      rerunning provider → area capability → target range → collection events.
- [ ] The 90-day range is **recomputed from the new `sourceToday` before** any events request.
- [ ] **Once the date change is observed**, yesterday's event is not left labelled `Heute` while the
      refresh is in flight, and no coverage is claimed for the advanced tail until the new response
      succeeds. The criterion is about behaviour **after** observation; it makes no claim about
      browser scheduler punctuality before it.
- [ ] The confirmed selection is preserved across the refresh.
- [ ] An advanced range outside the validity window issues **no** collection-events request and
      renders the no-calendar-for-this-period state.
- [ ] The next watchdog is scheduled **only after** the new capability and `timeZone` are
      corroborated by an accepted matching schedule.
- [ ] Changing selection or source zone cancels the previous timer; unmounting cancels the timer and
      every lifecycle listener; a superseded midnight refresh publishes no state.
- [ ] `visibilitychange`, `pageshow`, and focus re-derive `sourceToday`; a different date refreshes
      immediately, and the same date performs **no network refresh and no published view-state change; while visible and still owned by the current accepted pair, ensure exactly one pending watchdog timeout** — never a duplicate timer, and nothing armed
      for a hidden, stale, disposed, superseded, or failed owner.
- [ ] Concurrent timer and visibility signals **coalesce into exactly one refresh attempt**.
- [ ] The lifecycle is verified by **deterministic fake-clock and fake-timer tests**. No manual
      scenario requires waiting for real midnight or changing the operating-system clock.

### Range and accuracy

- [ ] The requested range is 90 calendar days forward from `sourceToday`, clamped into the declared
      validity window at both ends.
- [ ] A `sourceToday` past `validity.to`, and an inverted clamp, issue **no** request and show the
      no-calendar-for-this-period state.
- [ ] `SCHEDULE_RANGE_NOT_COVERED` enters its own product state only through the two exact paths in
      [step 4b](#4b-range_not_covered-classification): a first exact result consumes the shared
      reconciliation budget, and only the reconciled retry's exact result can use the Problem Details
      path.
- [ ] Waste-type coverage is never inferred from the returned events, and the declared coverage stays
      visible when the event array is empty.
- [ ] A successful response with `data: []` renders as "the source publishes no collections in this
      period" and not as an error.
- [ ] Events are ordered by **date, then all-day curbside before timed drop-off, then `startsAt` as a
      full-precision instant, then `id`** — **before** the next collection is chosen.
- [ ] The `startsAt` comparison **preserves every fractional digit the validator accepts**: `.0001`
      sorts before `.0002`, and `.1`, `.10`, and `.100` are equal.
- [ ] The comparator **accepts minute-precision timestamps** such as `2026-11-07T10:00Z`, treating
      them as identical to `10:00:00Z` and `10:00:00.000Z`. No accepted form is rejected for lacking
      an explicit seconds field, and the transport contract is not narrowed to require seconds.
- [ ] **One comparator** serves both event ordering and the window-order invariant; no second
      timestamp algorithm exists.

### Bounded reconciliation acceptance

- [ ] Each confirmed-selection schedule attempt starts with one shared
      `reconciliationRemaining: 1 | 0` budget at `1`; the first metadata mismatch **or** first exact
      `listCollectionEvents` / `422` / `SCHEDULE_RANGE_NOT_COVERED` problem consumes it, and the two
      triggers never receive separate retries.
- [ ] Metadata equality compares `meta.source.timeZone`, `meta.validFrom`, and `meta.validTo` with the
      requesting capability after api-client success and **before** mapping, invariant publication,
      sorting, rendering, or lifecycle scheduling. A mismatch discards the complete response, and
      response metadata is never used as substitute capability metadata.
- [ ] Reconciliation follows exactly: fresh providers → verify current official/non-demo provider →
      fresh areas → verify current available area → read the clock again → derive source-local today →
      recompute and clamp the range → issue zero or one events retry.
- [ ] Provider missing/demo and area missing/unavailable invalidate `confirmedSelection` and suppress
      every later provider-specific call documented by the canonical sequence; provider and area
      request failures retain their real operations inside `schedule_pipeline` / `reconciliation`
      context, and Retry starts a new complete schedule attempt rather than resuming that endpoint.
- [ ] **Every schedule acceptance passes the final source-date gate**: after all other validation and
      with token, phase owner, and confirmed selection still current, the injected clock is **read
      again**, the current source-local date is derived from the **validated matching capability's**
      zone and compared by **inequality** with **that specific request's** `sourceToday` snapshot —
      initial, reconciled retry, or recovery cycle. Steps from the ownership check through publication
      are **one synchronous path with no intervening `await`**, and the comparison is never made
      against range bounds or a different attempt's date.
- [ ] **Derivation has three handled outcomes at every checkpoint** — equal date, different date, and
      **typed failure** — per [step 3c](#3c-source-date-derivation-failure-at-every-checkpoint). The
      failure is the web-owned `source_date_unavailable` with **no** api-client `operation`, `status`,
      or `requestId`; `@abfall-radar/api-client` is unchanged. It does **not** trigger the changed-date
      restart, consume the shared reconciliation budget, establish an uncovered range, or invalidate
      the confirmed pair, and ownership guards are applied **before** any derivation result is acted
      on.
- [ ] **Each of the five checkpoints takes its documented transition, with ownership-specific
      cleanup.** Schedule-pipeline preflight and the **schedule-owned** publication gates enter the
      local schedule error while retaining the confirmed pair and installing **neither** an
      accepted-pair watchdog **nor a new** coordinator. A **recovery-owned** publication-gate failure
      instead retains `range_not_covered` and **the same coordinator**: shared cleanup must not
      dispose of that coordinator, its token, its controller, or its next settle-based deadline.
      Neither path installs a watchdog for the rejected candidate. The **accepted-pair watchdog**
      withdraws the
      accepted schedule from active display, retains the pair, **stops that watchdog**, and invents no
      current transport operation; **range-recovery preflight** and the **recovered-response gate**
      stay in `range_not_covered`, retain the pair **and** coordinator, and store the local failure as
      the current nested `lastRecoveryFailure`.
- [ ] **Retry routing distinguishes local from transport failures.** A local schedule error's Retry
      runs the complete authoritative pipeline — fresh providers → fresh areas → new clock read and
      derivation → clamped range → events only when requestable — as a new attempt under the existing
      ownership and budget rules, never republishing the failed candidate or reusing provisional
      capability or range data. A local recovery failure keeps the existing manual Retry, coalescing,
      and periodic behaviour, with the next deadline scheduled after the failed cycle settles; a
      successful derivation is **not** required to keep it retryable.
- [ ] **`source_date_unavailable` has its own German copy and live-region announcement**, shows **no**
      `requestId`, and **never borrows** a retained `triggeringRangeProblem`'s `requestId`, which keeps
      its existing lifetime and may stay independently labelled.
- [ ] **The no-events guarantee is scoped to one request**: a failed preflight derivation prevents the
      particular events request whose range would have come from it. Requests that already completed —
      the initial one before reconciliation, one issued before its own gate, and the one behind the
      schedule the watchdog monitors — are unaffected. Gate-failure handling adds **no** further
      request; a watchdog failure starts **none** by itself. Every call-count assertion is scoped to
      the attempt under test, never to a global zero.
- [ ] **A date-mismatched candidate is never published** — no accepted state even briefly, no
      yesterday-as-`Heute`, no relabelling with today over the old range, no accepted-pair watchdog,
      and no fabricated API error, cancellation message, or `requestId`. It supersedes the obsolete
      attempt, retains the confirmed pair, and starts **exactly one** immediate replacement through
      the existing coalescing mechanism — not at the next watchdog tick, recovery deadline, focus, or
      visibility event.
- [ ] **The restart is a new attempt, not another reconciliation**: it receives the normal single
      shared budget, which is never reset or enlarged inside the old attempt. Phase ownership holds —
      `schedule_pipeline` work restarts there; recovery stays with the **same** coordinator without
      leaving `range_not_covered`, without clearing episode diagnostics, and without creating a second
      coordinator.
- [ ] A refreshed capability with no requestable range issues no events retry and enters the local
      `range_not_covered` path. A requestable range issues exactly one events retry, which must pass
      every identity, official-source, range, coverage, identifier, timestamp, timing, source-zone,
      validity, and capability-consistency check before acceptance.
- [ ] Matching success starts exactly one accepted-pair watchdog and no recovery coordinator. A second
      exact range problem retains the selection, renders no schedule, starts recovery, and does not
      reconcile again.
- [ ] Metadata mismatch after budget exhaustion becomes local `invalid_response` for
      `listCollectionEvents` with `status: 0`, no `requestId`, no range state, and no lifecycle timer.
      It and other ordinary failures preserve `schedule_pipeline` / `reconciliation` context and the
      real operation; cancellation or supersession publishes nothing.
- [ ] A mismatch followed by the exact range problem ends in `range_not_covered`; the exact range
      problem followed by a mismatch ends in local `invalid_response`.
- [ ] Reconciliation's fresh provider/area reads are evaluated by
      [the entry-revalidation predicate](#entry-revalidation-is-evidence-based) like any other flow's:
      when they qualify, the transition into `range_not_covered` schedules the next recovery deadline
      without an immediate duplicate provider/area read. Later Retry and lifecycle signals remain
      available and coalesced.
- [ ] Newest-selection-wins is enforced during every awaited reconciliation stage, and no superseded
      stage updates state, starts a forbidden later call, or changes lifecycle ownership.

### Timed-event date and zone consistency

- [ ] `event.timing.timeZone` is required to equal `response.meta.source.timeZone`, which the
      capability check has already pinned to the authoritative capability zone.
- [ ] The local `YYYY-MM-DD` of `timing.startsAt` is derived **in the authoritative source zone** with
      `formatToParts`, `gregory`, and `latn`, and must equal `event.date` exactly.
- [ ] The check **never** compares the UTC date substring, **never** uses the device zone, and
      **never** rewrites `event.date` or `timing.timeZone`.
- [ ] It runs after capability/schedule metadata consistency and **before** mapping, publication,
      sorting, relative-date labels, window formatting, and rendering.
- [ ] Either mismatch produces `invalid_response` for `listCollectionEvents` with `status: 0`, no
      partial rendering, and no `requestId`.
- [ ] A window ending on a **later** source-local date is **not** a violation: `event.date` is the
      local date the window starts on.

### Helper ownership

- [ ] `deriveSourceToday` owns the source-zone `Intl` formatter and returns **either** the date **or**
      a typed source-date/time-zone failure — never a device-zone fallback, never UTC, never a throw
      into rendering.
- [ ] An `Intl` failure after api-client success yields the **web-owned `source_date_unavailable`**
      defined in [step 3c](#3c-source-date-derivation-failure-at-every-checkpoint) — **no** fabricated
      api-client `operation`, **no** HTTP `status`, **no** `requestId`, and no `RangeError` text. That
      canonical section governs every checkpoint; this criterion does not restate its matrix, and the
      matrix is not rewritten to match older acceptance text.
- [ ] **The no-events requirement is checkpoint- and request-scoped**, per
      [step 3c](#3c-source-date-derivation-failure-at-every-checkpoint): a failed derivation prevents
      only the events request that would have been built from **that** result. A **publication-gate**
      failure happens *after* its events request completed, so it rejects the candidate, shows the
      local schedule error, and **installs no accepted-pair watchdog and starts no range recovery
      because of this failure** — but it never implies that the completed request did not happen, and
      no assertion may count it as zero.
- [ ] **The type model expresses the allowed phase/failure combinations**, rather than a broad union
      applied everywhere: `selection_providers` and `selection_areas` keep `failure: ApiFailure`;
      `schedule_pipeline` and `range_recovery` carry `ScheduleFailure = ApiFailure |
      SourceDateUnavailable`; and `WithRenderableFailure` maps **each context's own** failure type so
      the constraint survives. `cancelled` is excluded in every phase. **A recovery-phase local
      failure never becomes the top-level `error` state** — it stays the nested `lastRecoveryFailure`
      inside `range_not_covered`, which retains the coordinator, `Erneut versuchen`, and periodic
      recovery.
- [ ] **Each checkpoint keeps its documented transition**: schedule preflight retains the confirmed
      pair and produces the local schedule error; the **accepted-pair watchdog** failure removes the
      accepted schedule from active display, stops that watchdog, and retains the pair; **recovery
      preflight and the recovered-response gate** retain `range_not_covered` and its coordinator,
      record the nested local diagnostic, and preserve manual Retry and periodic recovery. Schedule
      Retry starts a fresh authoritative providers → areas → clock read → range → conditional events
      pipeline.
- [ ] **A cancelled or superseded owner publishes this failure for nobody**: it does not render the
      local error, remove a successor's schedule, stop a successor's lifecycle owner, or start a
      request. The failure **consumes no reconciliation budget, establishes no uncovered range, and
      never triggers the changed-date restart**.
- [ ] **Genuine API validation failures keep `invalid_response`** with their real operation and
      documented `status: 0` — duplicate identifiers, metadata mismatch after budget exhaustion, and
      the cross-field timing invariants are unchanged by this criterion.
- [ ] `deriveTargetRange` takes **`sourceToday` as an already-derived ISO date** plus validated
      `validity.from`/`validity.to`, and does calendar addition, clamping, and the
      outside-current-period result **only**.
- [ ] `deriveTargetRange` **does not** accept a `timeZone`, construct `Intl.DateTimeFormat`, derive
      `sourceToday` again, return an unusable-zone result, or duplicate time-zone validation.

### Drop-off window order

- [ ] A named application-boundary invariant validates every `mobile_drop_off` window **after
      api-client success** and **before** transport-to-domain mapping, event-id uniqueness
      publication, sorting, state publication, and rendering.
- [ ] It uses **the same full-precision comparator** as ordering — never `Date.parse`, and never
      relying on `CollectionEventSchema`'s millisecond-level refinement as the only check.
- [ ] `endsAt` **equal to** `startsAt` is accepted.
- [ ] `endsAt` **earlier than** `startsAt` at any accepted fractional precision produces
      `invalid_response` for `listCollectionEvents` with `status: 0`.
- [ ] An inverted window renders **no partial schedule**, exposes **no `requestId`**, and leaks **no
      timestamp, payload, or parsing detail** into the UI or a log.
- [ ] **No shared schema is changed**: `packages/api-client` and `packages/domain` are untouched, and
      the follow-up to correct them for every consumer is recorded rather than performed here.
- [ ] **The final `id` tie-break compares the original strings by UTF-16 code unit**, ascending, via
      JavaScript string equality and `<`/`>` — **not** byte order, and **never** `localeCompare`,
      `Intl.Collator`, case folding, Unicode normalization, or a derived key. It is independent of
      locale, collation, browser and device settings, and input order, and returns `0` **only** for
      exactly equal original strings. Schema-valid ids are not rewritten and the uniqueness policy is
      not loosened to avoid the comparison.
- [ ] No comparator compares `startsAt` lexically, with `String.localeCompare`, or **through
      `Date.parse`/`getTime`/epoch milliseconds alone**, and none assigns a sort position to an
      unparseable instant.
- [ ] No `Temporal` or other dependency is added for this, and the HTTP timestamp contract is not
      narrowed.

### Response-wide identifier uniqueness

- [ ] **Provider ids are checked for response-wide uniqueness across the complete validated response,
      before demo filtering**, rendering, or selection. A duplicate produces `invalid_response` for
      `listProviders` with `status: 0`, renders no provider, and issues no service-area and no
      collection-events request.
- [ ] **Service-area ids are checked for response-wide uniqueness before rendering available or
      unavailable choices.** A duplicate produces `invalid_response` for `listServiceAreas` with
      `status: 0`, renders no area, and issues no collection-events request.
- [ ] Event `id` uniqueness is checked **after api-client validation and before** domain
      mapping, ordering, rendering, or state publication.
- [ ] No check filters, deduplicates, keeps a first or last duplicate, or appends an array index to a
      React key, and no rejected record appears in the UI or a log.
- [ ] A duplicate `id` produces `invalid_response` for the real `listCollectionEvents` operation with
      **`status: 0`**, the established local/unknown-status sentinel — never a fabricated `200` and
      never the discarded success status.
- [ ] `ApiSuccess`/`ApiResult` is **unchanged**: no status is added to the success envelope for this
      invariant, and the web layer never infers or reconstructs the discarded status.
- [ ] `status: 0` never appears in user-visible copy.
- [ ] **No event from a duplicate-id response is rendered**, no server diagnostic text is shown, and
      no `requestId` is invented.
- [ ] The check lives in `apps/web`; `@abfall-radar/api-client` gains no `@abfall-radar/domain`
      dependency, and no OpenAPI route contract or server behaviour changes.
- [ ] No extra comparator key was added to work around duplicate identities.

### States, failures, and races

- [ ] The view-state union has all nine members as **top-level** states — `configuration_error`,
      `needs_selection`, `no_official_providers`, `no_service_areas`, `loading`, `live` (fresh and
      stale), `empty`, `range_not_covered`, `error` — and each renders distinctly. None is
      modelled as an informal outcome nested inside another state.
- [ ] **Top-level `loading` is post-confirmation schedule-pipeline work only.** Bootstrap provider
      loading, draft service-area loading, and selection-phase Retry loading stay in
      `needs_selection` as the nested loading substate of their step; range-recovery progress stays
      nested inside `range_not_covered`. **Request ownership assigns the phase** — a retained
      `confirmedSelection` during `Auswahl ändern` does not convert a draft catalogue request into
      schedule-pipeline loading.
- [ ] **Service-area loading exposes `Zurück`**, which supersedes and aborts that attempt and returns
      to the documented provider-selection state with the catalogue retained and the draft area
      cleared. A late area result after `Zurück` or a draft-provider change repaints nothing, and no
      selection-flow area request implicitly confirms an area or starts a collection-events request.
      `configuration_error` behaviour and accepted-schedule refresh behaviour are unchanged.
- [ ] **Every member has dedicated German copy, a live-region announcement, and accessibility
      treatment**, enforced by an exhaustive record keyed by the union so an unhandled member is a
      **TypeScript error**, plus a test that iterates the union and asserts non-empty copy and an
      announcement for each.
- [ ] `no_official_providers` and `no_service_areas` are neither loading nor error states.
- [ ] A browser-origin rejection renders `configuration_error` — a complete accessible German surface
      in the normal shell with a stable heading and status or alert semantics — rather than throwing,
      blanking the page, or leaving a spinner running.
- [ ] `configuration_error` is never classified as `network`, `invalid_response`, `timeout`, or
      Problem Details, and carries no operation, HTTP status, or `requestId`.
- [ ] `configuration_error` displays no rejected origin, URL, scheme, exception, stack trace, or
      validator message.
- [ ] Where recovery requires an ordinary HTTP(S) page, the copy states that instead of offering a
      retry action that cannot repair the browsing context.
- [ ] `network`, `timeout`, `invalid_response`, and `problem` are **exhaustively handled failure
      subtypes**, never top-level states, each with its own German copy; non-recovery contexts contain
      them in top-level `error`, while recovery contains them under `range_not_covered`. The subtype
      union reuses the client's exported failure types rather than duplicating them.
- [ ] Only `problem` exposes a `requestId`; an **unrecognized `code` renders generic copy and still
      shows the validated `requestId`**.
- [ ] **`cancelled` is excluded by `RenderableApiFailure` at the transport-to-UI boundary** — handled
      before a stored UI failure is constructed, before copy is selected, and before anything is
      announced. It produces no error state, diagnostic, `requestId`, or announcement, and starts no
      further work; `configuration_error` and `range_not_covered` remain top-level states.
- [ ] A cancelled attempt **does not clear a successor's state, diagnostics, or lifecycle owner**, and
      an already-visible valid diagnostic remaining on screen is **not** a cancellation-derived error.
- [ ] An exhaustive map keyed by the **renderable failure `kind`** — the four transport kinds, plus
      `source_date_unavailable` **only where the phase admits it** — supplies **German copy,
      live-region behaviour, and a `requestId` policy** in each documented phase/state context; an
      exhaustive phase handler supplies Retry/actions. A missing **renderable** branch in either
      dimension is a **compile error**, and no operation-only fallback exists.
- [ ] **`range_not_covered` retains both diagnostics.** `triggeringRangeProblem` is populated **only**
      by a terminal exact range problem after the shared reconciliation budget is exhausted — never by
      a local capability-derived entry — and its validated `requestId` is displayed under an
      **initial range-response** label. `lastRecoveryFailure` is owned by `phase: 'range_recovery'`
      alone, cleared at the start of each recovery cycle, and displayed under a **separate recovery**
      label. Neither borrows the other's identifier, no empty label renders, and a new episode for the
      same pair inherits neither.
- [ ] **A rejected `fetch` produces `network`; any non-ok HTTP response whose media type is not
      `application/problem+json` produces `invalid_response` carrying the status that arrived.** The
      two are never collapsed, and stopping `apps/api` behind the Vite proxy is understood to be the
      second, not the first.
- [ ] A `network` failure carries **no HTTP status** and no `requestId`, because no response existed.
- [ ] Neither `network` nor `invalid_response` renders a `requestId`, fabricated or otherwise.
- [ ] No server diagnostic string — `detail`, `instance`, `errors`, or any server message — is
      rendered anywhere.
- [ ] A support `requestId` is shown only for a validated Problem Details response that supplied one;
      every other state shows no identifier and no placeholder.
- [ ] An unknown problem `code` degrades to generic product copy rather than failing.
- [ ] Rapid provider, area, and range changes always render the newest selection, and a superseded
      request is actually aborted — satisfied by the two-provider fixture tests, because the live
      catalogue offers one provider and one area and cannot be switched.
- [ ] A cancellation caused by a newer selection produces no error state and clears no newer schedule.
- [ ] A range-recovery failure remains nested as `lastRecoveryFailure` under
      `range_not_covered`; its live-region announcement does not replace the truthful top-level state.

### Provenance and events

- [ ] **All three provenance values are rendered separately**: `meta.source.name` as the source name,
      `meta.source.attribution` as attribution text, and `meta.source.landingPageUrl` as the public
      source link. None is collapsed into another.
- [ ] Attribution is **never synthesized** from the source name or locality and **never replaced by
      the link's hostname**.
- [ ] **No upstream calendar or download URL is exposed**; the only rendered link is the validated
      `landingPageUrl`, with the appropriate `rel` protection if it opens a new context.
- [ ] `retrievedAt`, the freshness state, the complete declared coverage, and the effective display
      range are all shown.
- [ ] **All provenance, including attribution, is rendered for a successful empty schedule** — it is
      not conditional on the event array being non-empty.
- [ ] **Every** rendered `mobile_drop_off` event shows its own window, that window's source time zone,
      and its location — not only the first one — satisfied by the validated-fixture test, because
      whether the live source has a timed drop-off in range depends on the verification date.
- [ ] A `curbside` event renders no window and no location.
- [ ] Both `CollectionEvent` variants are mapped through `CollectionEventSchema` rather than asserted.
- [ ] Every event the source published for the period is shown; no waste-type filter or selector
      exists.
- [ ] **Every normalized `CollectionEvent` in the accepted response is represented**, one per rendered
      row or card, and events are **not deduplicated** for sharing a date, window, zone, or location.
- [ ] Paired `hazardous` and `small_electronics` events remain **distinct**, with distinct waste-type
      labels and distinct identities.
- [ ] **`apps/web` never receives an appointment or a two-waste-type record**, imports no provider
      code, parses no ICS, and claims to verify **no** provider normalization — that proof is owned by
      `packages/data-providers/src/node/normalize.test.ts`.
- [ ] Demo data is never presented as official data on any surface.

### Accessibility — automated

- [ ] Semantic HTML is used before ARIA, and every control has an accessible name.
- [ ] Focus order is preserved and focus is moved to the appropriate heading when one surface replaces
      another.
- [ ] Sequential keyboard navigation reaches every operable control and **skips** every disabled one.
- [ ] `Zurück`, `Auswahl ändern`, and `Erneut versuchen` each have an accessible name, and focus lands
      on the destination [step 6b](#6b-navigation-zurück-auswahl-ändern-and-erneut-versuchen)
      documents for their transition.
- [ ] State transitions are announced through a polite live region.
- [ ] A failed range refresh announces its nested diagnostic without replacing the
      `range_not_covered` heading or state; the Retry control keeps its accessible name while its
      action is derived from `phase`, not from `failure.operation`.
- [ ] Provenance, freshness, and status are conveyed by text, not by color alone.
- [ ] Only semantic tokens are used; no arbitrary color, spacing, radius, or shadow is added.

### Responsive and accessibility manual browser verification

Each of these is verified by a person in a real browser and recorded as manual. **No automated test
claims any of them.**

- [ ] The layout is usable with no horizontal page scrolling at **320, 390, 768, and 1280 CSS px**.
- [ ] The relevant phone, tablet, and desktop flows are repeated at **200% browser zoom**, explicitly
      including **768 px at 200%**, with **effective reflow** verified rather than only a changed
      DevTools width.
- [ ] The [long-content fixtures](#long-content-fixtures-for-manual-verification) are verified at
      every width and at 200% zoom: no horizontal scrolling, no clipping or overlap, text wraps, cards
      and controls grow vertically, attribution and source link stay readable, focus indicators stay
      visible and unobscured, keyboard order stays logical, controls stay operable, nothing
      disappears, and **long unbroken content cannot force the page wider**.
- [ ] **Browser, viewport, and zoom level are recorded in the handoff** for every check above.
- [ ] Keyboard focus is visibly indicated on **every operable control that exists in the current live
      flow**.
- [ ] Keyboard focus order is verified through provider selection, available-area selection,
      confirmation, the schedule, and the retry, back, and change-selection actions. **No mandatory
      step depends on an unavailable area**, which the live catalogue does not expose.
- [ ] Primary touch targets measure at least 44 by 44 CSS pixels.
- [ ] A reduced-motion preference leaves no animation running.
- [ ] The Tailwind pipeline produced the token utilities the shared primitives name, so `BrandMark`
      and `WasteIcon` render styled.

### Language and documentation

- [ ] User-visible copy is German; code, identifiers, comments, tests, and documentation are English.
- [ ] **`apps/web/index.html` declares `<html lang="de">`**, asserted deterministically against the
      document element, so German copy is announced with the correct pronunciation and locale rules.
- [ ] **`apps/web/index.html` declares `<meta name="viewport" content="width=device-width,
      initial-scale=1">`**, asserted deterministically in the same document check as `lang="de"`:
      **exactly one** viewport `<meta>` exists, its `content` is that value, and it contains **no**
      `maximum-scale`, `minimum-scale`, or `user-scalable` restriction. The assertion covers the
      document's presence of the tag only — **not** layout, box sizes, overflow, or target
      dimensions, which stay manual.
- [ ] **The viewport declaration survives into emitted production HTML**, asserted by the
      emitted-artifact verifier against a fresh build rather than by reading the source template, so
      a build step that rewrote or dropped the `<head>` would fail.
- [ ] The **320 CSS-pixel** responsive floor and the **44 by 44 CSS-pixel** target minimum are
      unchanged and are evaluated in that device-width viewport during the manual browser checks.
- [ ] `apps/web/README.md` and the root `README.md` describe the data layer, the same-origin
      assumption and the dev proxy, the states including the successful-empty ones, the session-only
      trade-off, and the manual-verification scope, and link ADR 0005.
- [ ] No test performs network access.
- [ ] Every command in [Verification](#verification) passes.

## Test matrix

Deterministic Vitest and jsdom tests are required for each entry. **No entry here asserts layout,
viewport width, element dimensions, horizontal overflow, or rendered focus appearance** — those are
manual, per [Verification scope](#verification-scope).

### Bootstrap and shell

- [ ] the application mounts and renders the needs-selection surface;
- [ ] **the document declares `lang="de"` and the mobile viewport together**, read from
      `apps/web/index.html`: the document element's `lang` is `de`; **exactly one**
      `<meta name="viewport">` exists; its `content` is exactly
      `width=device-width, initial-scale=1`; and it declares no `maximum-scale`, `minimum-scale`, or
      `user-scalable`. This asserts the **declaration** only — it is explicitly **not** evidence of
      layout, overflow, or target dimensions, which this matrix never asserts;
- [ ] the shell selects its responsive classes and semantic tokens for each supported breakpoint
      bucket, asserted on the emitted class list rather than on any measured size;
- [ ] the document structure is semantic: one `main`, an ordered heading hierarchy, and named
      landmarks.

### Browser transport cache tests

- [ ] a recording fake `FetchLike` constructs the web API gateway/client without real network access;
- [ ] providers, service areas, and collection events each issue a request whose effective
      `RequestInit.cache` is exactly **`'no-store'`**;
- [ ] the wrapper preserves method, headers, abort signal, body, credentials, mode, redirect,
      referrer, integrity, and every other supplied `RequestInit` member;
- [ ] a caller-supplied conflicting cache mode is overridden by **`'no-store'`**;
- [ ] Retry, reconfirmation, source-midnight refresh, focus/visibility revalidation, first-422 or
      metadata-mismatch reconciliation, and range recovery are proven to reuse the same wrapped
      gateway/client boundary and never call raw `fetch` or construct another client;
- [ ] the assertions inspect every captured request and perform no real network access.

### Provider filtering and verification

- [ ] a catalogue fixture containing a demo provider renders no demo provider on the selection
      surface;
- [ ] no service-area request is issued for a demo provider;
- [ ] **no service-area request is issued before the provider is verified** against a successful
      catalogue, asserted on the request spy rather than on the rendered output;
- [ ] a provider the catalogue does not offer produces no request and a stated outcome rather than a
      silent nothing;
- [ ] a failed catalogue read is distinguishable from a catalogue that has not answered; its
      `selection_providers` Retry re-reads only the catalogue.

### Successful empty catalogues

- [ ] a provider response of `data: []` renders `no_official_providers`, is neither a loading nor an
      error state, and issues **no** service-area and **no** collection-events request;
- [ ] a provider response containing **only** demo providers renders the same state and suppresses the
      same two requests;
- [ ] a service-area response of `data: []` for an offered provider renders `no_service_areas`, is not
      an error state, and issues **no** collection-events request;
- [ ] a service-area response in which **every** area is `unavailable` renders every area with its
      explanation and disabled semantics, is **not** reported as an empty list, offers no confirmable
      choice, and issues no collection-events request;
- [ ] each of the four cases above is asserted on the request spy, so downstream suppression is proven
      rather than inferred from the rendered output;
- [ ] `no_official_providers` and `no_service_areas` each render as **their own top-level state** with
      dedicated German copy, distinguishable from `loading`, from `error`, and from each other;
- [ ] **the union is exhaustive**: a test iterates every member of the view-state union and asserts
      each renders non-empty German copy and produces a live-region announcement, so adding a state
      without both fails deterministically. The copy and announcement lookups are exhaustive records
      keyed by the union, so an unhandled member is additionally a `typecheck` failure.

### Unavailable areas

**These are the standing evidence for unavailable-area behaviour**, because the live catalogue exposes
none. Nothing here is deferred to a manual check.

- [ ] the fixture's `unavailable` area **remains visible with its explanatory German copy** while the
      `available` area in the same fixture stays selectable, so the test cannot pass by disabling
      everything or by hiding the area;
- [ ] the explanatory text is associated with the unavailable area through the accessibility tree;
- [ ] it uses **native disabled semantics** — the native `disabled` attribute on a native control —
      exposed through the accessibility tree, asserted there rather than on a class name;
- [ ] **sequential `Tab` navigation skips it**: starting from the control before it, one `Tab` reaches
      the **next operable control**, and the disabled area never becomes `document.activeElement`;
- [ ] **click, Enter, and Space each fail to select or confirm it**, asserted per interaction so a
      pointer-only test cannot pass a keyboard-operable control;
- [ ] it produces **no selection confirmation and no application-state change**, asserted on the
      confirmed-selection state rather than only on the rendered output;
- [ ] it triggers **no collection-events request**, asserted on the request spy.

### Selection loading and Back navigation tests

Each case asserts **four things together**: the **top-level state**, the **nested loading state**, the
**navigation actions available**, and the **request phase** — plus the absence of the calls that case
forbids.

| Scenario | Top-level | Nested | Actions | Phase | Forbidden |
| --- | --- | --- | --- | --- | --- |
| Bootstrap provider load | `needs_selection` | provider step loading | none beyond the step itself | `selection_providers` | no area request, no events request, **not** top-level `loading` |
| Initial draft service-area load | `needs_selection` | area step loading | **`Zurück`** | `selection_areas` | no events request, no implicit area confirmation, **not** top-level `loading` |
| Selection-phase `Erneut versuchen` | `needs_selection` | the substate of the read it repeats | that step's actions | the same selection phase | no phase change to `schedule_pipeline` |
| **`Zurück` during** service-area loading | `needs_selection`, provider step | no area loading | provider step controls | the area attempt is superseded and aborted | no events request; the provider catalogue is **retained**, the draft area cleared |
| Late area result **after** `Zurück` or a draft-provider change | unchanged | unchanged | unchanged | — | the late result repaints nothing and starts nothing |
| `Auswahl ändern` with a retained confirmed pair | `needs_selection` | the step being edited | that step's controls | `selection_providers` / `selection_areas` | the retained pair does **not** make it `schedule_pipeline` or top-level `loading`; no events request before reconfirmation |
| **Explicit confirmation** of an available pair | top-level **`loading`** | — | `Auswahl ändern` | `schedule_pipeline` | — |
| Range-recovery cycle in progress | **`range_not_covered`** | its nested progress/diagnostic | `Erneut versuchen`, `Auswahl ändern` | `range_recovery` | never top-level `loading` |

`configuration_error` behaviour and accepted-schedule refresh behaviour are **unchanged** by this
row's correction and are not re-specified here.

### Request gating and bootstrap request counts

Asserted on request **counts and order**, not on rendered output:

- [ ] **bootstrap performs exactly one provider request** — one, not zero and not two;
- [ ] **bootstrap performs no service-area and no collection-events request**;
- [ ] **a successful provider response auto-selects nothing**, including when the catalogue offers
      exactly **one** provider;
- [ ] **explicitly selecting an offered provider triggers exactly one service-area request**, for
      that provider;
- [ ] no service-area request before provider verification against a **successful** catalogue;
- [ ] **a successful area response auto-selects nothing and fetches no events**, including when
      exactly **one** available area is returned;
- [ ] **selecting an available area changes only the draft** — still no collection-events request;
- [ ] **explicit confirmation of an available provider/area pair** triggers the capability → range →
      collection-events pipeline;
- [ ] **no schedule request before a confirmed available area**;
- [ ] no schedule request while the derived range is outside the declared validity window;
- [ ] **demo-only, missing, duplicate, empty, and all-unavailable** catalogue states each suppress
      exactly the downstream requests their state documents.

### Source-local calendar day tests

- [ ] `sourceToday` is identical with the process time zone pinned to a zone **east of UTC** and to a
      zone **west of UTC**, using the forked isolated pool pattern so `process.env.TZ` is safe to pin;
- [ ] **the primary three-date fixture**, proving derivation depends on the source zone and not on the
      device, with every expected value stated explicitly:

      | Instant | Source zone | Expected `sourceToday` |
      | --- | --- | --- |
      | `2026-08-02T10:30:00Z` | `Pacific/Kiritimati` | `2026-08-03` |
      | `2026-08-02T10:30:00Z` | `Europe/Berlin` | `2026-08-02` |
      | `2026-08-02T10:30:00Z` | `Pacific/Pago_Pago` | `2026-08-01` |

      Three genuinely different calendar dates at one instant. **Do not assert that Tokyo, Berlin, and
      New York hold three dates simultaneously** — they span thirteen hours, so no instant does that,
      and the claim is unsatisfiable;
- [ ] **realistic east and west boundary coverage, as two separate instants**, each with its expected
      values stated:

      | Instant | `Europe/Berlin` | Other zone |
      | --- | --- | --- |
      | `2026-08-02T02:00:00Z` | `2026-08-02` | `America/New_York` → `2026-08-01`, the previous date |
      | `2026-08-02T16:00:00Z` | `2026-08-02` | `Asia/Tokyo` → `2026-08-03`, the next date |

- [ ] **a runtime missing any required IANA zone makes the test skip or fail visibly**; it must never
      silently substitute a fixed offset, which would leave the strongest evidence here passing
      without exercising anything;
- [ ] an event whose date **is** the source day is neither filtered out nor labelled `Morgen`, with
      the device zone set to a zone where that instant is already the next day;
- [ ] an event one source-calendar day later is labelled `Morgen`, and events two to six days later
      are labelled `In N Tagen`, computed from the two ISO dates;
- [ ] an event seven or more days later uses the absolute fallback, formatted identically regardless
      of the device zone;
- [ ] no helper under `src/schedule/` has a date parameter with a default value, asserted by reading
      the source.

### Navigation action tests

Driven through the **real documented controls**, using a fixture catalogue with **multiple official
providers and areas** — deterministic component tests may exceed what the live API exposes.

- [ ] **choose provider A, then `Zurück` before A's area request resolves**: the attempt is
      superseded, the provider step renders, the catalogue is **not** refetched, the draft area is
      clear, and **no collection-events request** is issued;
- [ ] **choose provider A, then change to provider B before A's area request resolves**: B's areas
      render and A's late reply changes nothing;
- [ ] **confirm area A, activate `Auswahl ändern` while its schedule request is pending, then confirm
      area B**: the schedule hides on activation, A's attempt aborts, and B's schedule renders;
- [ ] **A's requests resolve *after* B's**: A cannot repaint the UI, and **cannot start or replace B's
      watchdog** — asserted on both the rendered output and the active-timer count;
- [ ] **`selection_providers` Retry invokes exactly `listProviders`** — no area or events request;
- [ ] **for ordinary area failures, `selection_areas` Retry invokes exactly `listServiceAreas` for
      `draftProviderId`**, confirms nothing, and issues no events request — the
      `PROVIDER_NOT_FOUND` recovery is covered separately below and offers **no** area Retry;
- [ ] **`schedule_pipeline` Retry preserves `confirmedSelection`** and reruns fresh providers → fresh
      areas → clock/source day → range → conditional events → acceptance checks → the final
      source-date gate, asserted on
      call order with a new token, controller, and reconciliation budget;
- [ ] **`selection_areas` Retry preserves only the draft provider** — no confirmed pair is created;
- [ ] **`Zurück` never issues a collection-events request**, asserted on the request spy;
- [ ] **`Auswahl ändern` issues no collection-events request before reconfirmation**;
- [ ] **reconfirming the same area issues a new pipeline**, asserted on the request spy showing a
      second capability and events read;
- [ ] **`Auswahl ändern` stops the active lifecycle owner**: separately from an accepted schedule it
      stops the watchdog, and from `range_not_covered` it stops the recovery coordinator; both are
      asserted by the active-timer count dropping to zero before reconfirmation;
- [ ] **`Auswahl ändern` is absent on `configuration_error`** and present on each of the six
      post-confirmation surfaces, asserted per surface;
- [ ] **a second failed Retry remains retryable under the same owner-assigned phase**;
- [ ] focus destinations are asserted for each transition — area-step entry, `Zurück`, `Auswahl
      ändern`, pending retry, and successful confirmation — and no transition leaves focus on
      `document.body` or an unmounted element.

### Invalidated draft provider tests

**Future implementation tests; none has run.** Driven through the injected gateway with deterministic
fixtures. Every case asserts **bounded request counts per operation** and **zero
`listCollectionEvents` requests**. Rule in
[the recovery transition](../decisions/0005-responsive-web-schedule.md#an-invalidated-draft-provider-is-recovered-not-retried).

| Scenario | Required result |
| --- | --- |
| **The single offered provider is removed** — area request returns `ProviderNotFoundProblem`, refresh returns an empty or demo-only catalogue | Exactly **1** `listServiceAreas` and **1** `listProviders` after the failure; `no_official_providers`; draft cleared; recovery copy announced; focus on the provider step heading |
| **A replacement provider appears** — refresh returns a different official provider | Exactly **1** refresh; the new provider is offered with **nothing selected**; **0** further `listServiceAreas` until explicitly chosen |
| **The same provider id reappears** in the refresh | Offered with **nothing selected**; **0** automatic `listServiceAreas` — choosing it explicitly issues exactly **1**. No loop |
| **The refresh itself fails** | A `selection_providers` failure with its real `listProviders` operation; `Erneut versuchen` issues exactly **1** further `listProviders` and **no** area request |
| **The original failure's metadata** | Recorded as `selection_areas` / `listServiceAreas` / `404` / `PROVIDER_NOT_FOUND` with its `requestId`, **unchanged** by the refresh starting |
| **Unrelated area failures** — a `404` with another code, `invalid_response`, `network`, `timeout` — and `no_service_areas` | **No** catalogue invalidation and **no** provider refresh; ordinary area Retry calls exactly `listServiceAreas` for the draft provider |
| **Stale completion after `Zurück`** | The late `ProviderNotFoundProblem` does nothing: **0** `listProviders`, no copy, no focus move, catalogue unchanged |
| **Stale completion after a draft-provider change** | Does nothing to the newer draft or its area request |
| **Stale completion after unmount** | No state update, no request, no timer |
| **During `Auswahl ändern` with a retained confirmed pair** | The pair stays inactive; **no** schedule request and **no** lifecycle owner resumes without reconfirmation |
| **`Zurück` after recovery** | The invalidated catalogue is **not** re-offered; only the refreshed catalogue is selectable |

### Phase-aware Retry tests

Table-driven tests use the **same `ApiFailure` fixture object where the operation is meant to be
identical** and vary only the owner-assigned `FailureContext`. Every row asserts context `phase`,
unchanged real `failure.operation`, retained confirmed/draft values, exact next call order and counts,
lifecycle owner, and absence of forbidden calls. Final copy alone is insufficient.

| Identical transport failure | Contexts exercised | Required Retry evidence |
| --- | --- | --- |
| `listProviders` failure | `selection_providers`; `schedule_pipeline` / `reconciliation`; `range_recovery` | Selection calls only providers. Schedule retains the confirmed pair and restarts providers → areas → fresh range → conditional events with a new budget. Recovery keeps `range_not_covered`, restarts providers → areas → conditional events, and retains periodic ownership |
| `listServiceAreas` failure | `selection_areas`; `schedule_pipeline` (initial and reconciliation); `range_recovery` | Selection retains only the draft provider and calls only areas with no events. Schedule retains the confirmed pair and restarts at providers, never directly at areas. Recovery restarts its full cycle at providers |
| `listCollectionEvents` failure | `schedule_pipeline`; `range_recovery` | Schedule starts a new complete authoritative attempt. Recovery keeps the range state and coordinator, stores the nested diagnostic, and starts the complete recovery cycle on Retry |

Required cases around that table:

- [ ] a reconciliation provider or area failure carries `stage: 'reconciliation'`; Retry creates a
      new `stage: 'initial'` schedule attempt, resets `reconciliationRemaining` to `1`, and never
      consumes or resumes the old partial sequence;
- [ ] the new schedule Retry can encounter one metadata mismatch or exact first 422 and reconcile
      once, proving the budget belongs to the new attempt;
- [ ] a recovered-events failure remains `phase: 'range_recovery'` with operation
      `listCollectionEvents`, nested under `range_not_covered`; it does not become a schedule error;
- [ ] manual Retry racing with the 15-minute timer, focus, `pageshow`, and visibility signals produces
      exactly one recovery cycle and resets the next deadline after settlement;
- [ ] changing from selection to schedule, schedule to change-selection, or range recovery to a newly
      confirmed pair before a failure resolves aborts the previous controller, changes the owner token,
      clears stale context, and prevents the late failure from replacing current state or actions;
- [ ] changing the **confirmed selection**, changing the **draft provider**, and unmounting are separate
      supersession cases, each proving its old phase cannot publish or issue a forbidden later call;
- [ ] provider removed/non-official/demo and area removed/unavailable during authoritative schedule or
      recovery refresh follow invalidation, issue no events request, clear the obsolete failure
      context, and offer no Retry for the obsolete confirmed pair;
- [ ] after a second transient failed Retry, each phase still exposes the correct phase-aware Retry;
      range recovery also retains its next periodic attempt, so no phase is permanently stranded;
- [ ] `requestId` visibility is table-driven across every phase: a validated `problem` shows its real
      identifier, while `network`, `timeout`, and `invalid_response` never do;
- [ ] diagnostics preserve the actual operation in every phase — including `listProviders` and
      `listServiceAreas` during schedule reconciliation and recovery — and no test accepts a rewritten
      operation chosen to match product state;
- [ ] selection-flow attempts never update schedule state, schedule attempts never mutate
      `draftSelection`, and recovery never repaints after `Auswahl ändern` or another confirmation.

### Source-date publication-gate tests

Driven with the **injected clock**, **deferred fake responses**, and the **gateway boundary**. Every
rollover fixture must otherwise **pass existing validation** — valid timestamps, identity, and
capability metadata — so the test exercises **this gate** rather than failing earlier for an unrelated
reason.

Assertions inspect the **state-publication history or the acceptance boundary**, not only the settled
DOM: a correct final screen must not hide an earlier stale acceptance.

| Scenario | Required result |
| --- | --- |
| Initial request begins before source midnight, resolves after | Candidate **never accepted**; **one** immediate authoritative restart |
| Matching **reconciled retry** crosses source midnight | Compared against **that retry's** snapshot; discarded and restarted |
| **Recovered** response crosses source midnight | Stay in `range_not_covered`; **one** coordinator retained; **one** replacement recovery cycle |
| Successful **empty** response crosses source midnight | Same rejection-before-publication behaviour |
| Response resolves **within the same source day** | Accepted **once**; **one** watchdog installed |
| **Source-local** midnight passes while the UTC/browser calendar date does **not** change | Restart |
| **UTC/browser** midnight passes while the source-local date is unchanged | Accept normally |
| Midnight passes while **timers and lifecycle events are not delivered** | The **response completion itself** causes the immediate restart |
| Replacement capability has **no requestable range** | Canonical local uncovered-range path; **no** events request; the replacement's fresh provider/area reads satisfy [the entry-evidence predicate](#entry-revalidation-is-evidence-based), so **no** extra provider/area reads on entry |
| Selection change or unmount before completion | No stale acceptance, restart, diagnostic, or lifecycle installation |
| Rollover restart races with Retry/timer/focus | **One** current replacement pipeline; no duplicate owner |

**Derivation-failure cases**, driven with **controlled derivation results** through the existing
clock and test boundaries — no live clock change, no network, and no real waiting. Each asserts the
**precise request history of the attempt under test**, the top-level state, the retained confirmed
selection, the copy and announcement, the diagnostics, and lifecycle ownership:

| Scenario | Required result |
| --- | --- |
| **Preflight** failure **before** the initial events request | Local schedule error; **zero** events requests in this attempt; pair retained; no watchdog, no coordinator |
| **Reconciliation preflight** failure **after** an initial events request | Local schedule error; events-request count stays at **one** — the completed initial request is not retroactively forbidden; budget **not** consumed by the failure |
| **Final-gate** failure after an **initial** response | Candidate discarded; local schedule error; events count stays at **one**; **no additional** request from this handling; no watchdog, no coordinator |
| **Final-gate** failure after a **reconciled** response | Same, with the events count at **two** — initial plus the one reconciled retry |
| **Watchdog** derivation failure while an accepted pair is current | Accepted schedule withdrawn from active display; pair retained; **that** watchdog stopped; local schedule error; **no** events request from the failure itself; no invented transport operation |
| **Recovery preflight** failure | Stays `range_not_covered`; pair **and** coordinator retained; local failure stored as the current nested `lastRecoveryFailure`; **no** events request for the failed derivation; next deadline scheduled after the cycle settles |
| **Final-gate** failure after a **recovered** response | Not published; stays `range_not_covered`; coordinator retained; local recovery diagnostic stored; the recovered request already counted and no further one issued |
| **Successful Retry after each applicable local error** | The full authoritative pipeline runs in order with a new attempt and a fresh shared budget, and the previously failed candidate is never republished |
| **Supersession before failure handling** | The superseded owner publishes **no** local error, removes **no** successor schedule, stops **no** successor lifecycle owner, and starts **no** request |

Equal-date and changed-date cases above remain in force alongside these; the failure cases do not
replace them.

- [ ] **identical clamped bounds across two source days** — a fixture where clamping against the
      validity window leaves `from`/`to` unchanged — still **fails** the gate, proving the comparison
      is source-date inequality and **not** a range-bounds comparison;
- [ ] if an asynchronous response-processing stage already exists, cover **crossing midnight during
      the last relevant awaited stage**; **no asynchronous stage is invented** solely for a test.

Every case asserts: **absence of acceptance** for the obsolete candidate; **absence of a watchdog**
installed for it; **exact replacement call order and count**; the **freshly derived** `sourceToday`
and range; the **preserved confirmed selection** and correct **phase**; correct
**coordinator/watchdog ownership**; and **no stale cleanup affecting a valid successor**.

### Range-recovery entry-revalidation tests

Driven with the injected clock, deferred fake responses, and the gateway boundary. Rule in
[Entry revalidation is evidence-based](#entry-revalidation-is-evidence-based).

**Specify the observation window for every exact call-count assertion.** Counting starts when the
entry-producing flow's final authoritative read settles and the range state is produced; setup calls —
fixture priming, the selection flow's own catalogue reads, and any earlier attempt — sit **before**
that boundary and are never attributed to the entry cycle. State the window in the test name or a
comment; a bare "called twice" is not a record anyone can re-check.

| Entry-producing scenario | Required behavior |
| --- | --- |
| Initial authoritative provider/area reads produce no range | Enter the range state **without repeating** those reads |
| Reconciliation reads produce no range | **No** events retry and **no** duplicate entry reads |
| Reconciliation reads followed by a terminal exact 422 | Retain the proper **triggering** diagnostic; **no** duplicate provider/area reads |
| Final source-date replacement reads produce expired/uncovered validity | **No** events request from the replacement and **no** extra provider/area reads on entry |
| Legitimate entry using **retained metadata only** | **One** immediate complete recovery cycle |
| An **existing** recovery cycle freshly confirms the range is still uncovered | **Same** coordinator; next deadline scheduled; **no** immediate second cycle |
| Evidence arrives from a **superseded** producer | **No** stale entry, **no** evidence handoff, and **no** suppression of the current owner's required work |
| A later Retry or lifecycle signal after a reused entry | Normal **new** recovery cycle, under the existing coalescing rules |

The source-date case asserts exactly this sequence, in order:

```text
old candidate discarded
→ replacement listProviders
→ replacement listServiceAreas
→ local uncovered decision
→ range state
→ no additional immediate provider/area reads
```

Every case asserts: **call order and count** within the declared window; the preserved
**`confirmedSelection`**; **evidence ownership** — which flow produced it and that it was not
invalidated by the legitimate handoff; **exactly one** coordinator; **no** accepted-pair watchdog; and
the **next recovery deadline**, scheduled from the reused cycle's settlement rather than from a fresh
immediate attempt.

Also asserted: a signal **already coalesced into** the completing flow is not replayed as a second
entry cycle; stale producer cleanup does **not** clear the new coordinator's ownership; and a fresh
**area-only draft-selection read** does not satisfy the predicate.

### Range-recovery coordinator tests

Fake-timer and lifecycle tests, all asserted on request spies and active-timer counts.

**Range-state diagnostic scenarios.** Each asserts the data source, phase, operation, retained
selection, request order and count, diagnostic ownership, and lifecycle ownership:

- [ ] **local uncovered capability** — Path 1 — enters with **no `triggeringRangeProblem`**, no
      `lastRecoveryFailure`, and **no fabricated `requestId`**;
- [ ] **first exact 422 → reconciliation → refreshed capability still uncovered**: **no** events
      retry is issued, entry is Path 1, and the **provisional 422 is not retained**;
- [ ] **first exact 422 → reconciliation → terminal 422**: `triggeringRangeProblem` holds the
      **terminal** problem, and the displayed `requestId` is the **terminal** one, not the first;
- [ ] **metadata mismatch → reconciliation → exact 422**: the same exhausted-budget rule populates
      `triggeringRangeProblem`, proving **two 422 responses are not required**;
- [ ] **initial range diagnostic then a recovery `problem`**: both are shown under **separate labels**
      with **different `requestId`s**, and neither overwrites the other;
- [ ] **initial range diagnostic then a recovery `network` failure**: the network failure shows **no
      `requestId`**, and **does not borrow** the triggering one; the initial diagnostic may remain
      visible under its own label;
- [ ] **a successful still-uncovered revalidation clears `lastRecoveryFailure`**, leaving it absent
      while `triggeringRangeProblem` survives the episode;
- [ ] **an accepted schedule after recovery clears both diagnostics** and installs **exactly one**
      accepted-pair watchdog and no coordinator;
- [ ] **a new range episode for the same provider/area inherits neither diagnostic**, and a new
      episode for a **different** pair likewise starts clean;
- [ ] **stale or cancelled reconciliation/recovery replies** neither install, replace, nor restore
      either diagnostic, and **preserve valid successor state**;
- [ ] **no empty diagnostic label renders** when no validated `requestId` exists;
- [ ] a `schedule_pipeline` failure is **never** stored in `lastRecoveryFailure`, and a
      `range_recovery` failure is never promoted to top-level `error`.

- [ ] **crossing beyond `validity.to`** removes the old schedule and its labels **before** the state
      renders, and starts **exactly one** recovery coordinator;
- [ ] **no accepted-pair watchdog remains** while `range_not_covered` is displayed, asserted on the
      timer count;
- [ ] **entry without qualifying evidence** — resting only on retained or stale metadata — performs
      exactly one immediate complete cycle: fresh providers → provider validation → fresh areas →
      area/capability validation → current date and range → events only when requestable;
- [ ] **entry with qualifying evidence**, from *any* producing flow, performs no immediate duplicate
      provider/area read: the completed validation counts as the initial entry revalidation, the next
      periodic deadline is scheduled from that flow's settlement, and a later Retry or lifecycle
      signal can still start one coalesced attempt;
- [ ] the reuse decision is asserted against
      [the evidence predicate](#entry-revalidation-is-evidence-based), **never** against the producing
      flow's name, a non-null `confirmedSelection`, or a retained catalogue object;
- [ ] **a fresh extended capability** triggers a collection-events request and, after a **matching**
      response, **replaces recovery with exactly one accepted-pair watchdog** — never both;
- [ ] **a still-expired fresh capability** causes **no** collection-events request and schedules the
      next recovery attempt;
- [ ] **provider removal**, **area removal**, **demo reclassification**, and **`unavailable`** each
      invalidate the confirmed selection, stop recovery, and issue no collection-events request —
      asserted per outcome;
- [ ] **a hidden document does not poll**, asserted on the absence of further attempts;
- [ ] **becoming visible, `pageshow`, window focus, and `Erneut versuchen`** each trigger **one
      coalesced complete `range_recovery` attempt from fresh providers**, and each resets the next
      periodic deadline after settlement;
- [ ] **timer, focus, and Retry racing together never cause duplicate requests** — exactly one attempt
      results;
- [ ] **selection change and unmount abort recovery** and **discard late replies**, which publish
      nothing;
- [ ] **provider-, area-, and recovered-events failures** each retain truthful `range_not_covered`, the
      confirmed pair, coordinator ownership, and their unchanged real operation inside
      `lastRecoveryFailure`; each announces the refresh failure, remains retryable, and schedules the
      next attempt;
- [ ] **the expired capability never builds a collection-events request** — asserted on the request
      spy across a full recovery cycle;
- [ ] **browser timer delay is simulated**: the callback is withheld past the interval, recovery occurs
      **when it is delivered**, and the test asserts no claim of punctual wall-clock execution.

### Source-day lifecycle tests

Driven with a fake clock and fake timers. **No test waits for real time and none mutates the
operating-system clock.**

- [ ] **a continuously visible page crossing `Europe/Berlin` midnight** refreshes: the timer fires at
      the boundary and the authoritative pipeline reruns;
- [ ] **yesterday's `Heute` label disappears at the boundary**, asserted before the replacement
      response resolves, so a page that clears only on success fails;
- [ ] **the requested range advances by exactly one calendar day**, asserted on the events request;
- [ ] **exactly one authoritative refresh** occurs for one date change, asserted on the request spy;
- [ ] **a throttled or sleeping page becoming visible after one or more source dates have elapsed**
      refreshes on `visibilitychange`;
- [ ] **the new date is derived directly from the clock, not by incrementing yesterday** — a fixture
      advancing the clock by **two** source days produces the date two days on, not one;
- [ ] **a visibility event on the same source date causes no refresh** and no request;
- [ ] **a timer firing and a visibility event arriving together coalesce into one refresh attempt**,
      asserted on the request spy;
- [ ] **provider and area capability are reverified before collection events** on a midnight refresh,
      asserted on call order;
- [ ] **no collection-events request is issued when the advanced date falls outside validity**, and
      the no-calendar-for-this-period state renders;
- [ ] **changing the selection cancels the previous zone's watchdog**, so it never fires again;
- [ ] **an old midnight response arriving after a selection change is discarded** and publishes no
      state;
- [ ] **unmounting cancels the timer and removes every lifecycle listener**, asserted on the removal
      rather than on the absence of a later effect;
- [ ] **the polling cadence uses the exported `SOURCE_DATE_WATCH_INTERVAL_MS`**, referenced by the
      test rather than duplicated as a literal, and **once the fake timer delivers the callback** the
      change is detected. The test proves behaviour **on delivery**; it must not be written or
      described as proving browser scheduler punctuality;
- [ ] **repeated same-date ticks issue no request and publish no state**, asserted across many ticks
      on the request spy;
- [ ] **a delayed callback** — source midnight passes while the watchdog callback is intentionally
      withheld:

      1. the old schedule and its `Heute` label **may remain** while execution is withheld, and the
         test asserts this is tolerated rather than treated as a defect;
      2. on the **next delivered callback or recovery signal**, the helper derives the **actual
         current source date** — not the withheld tick's date, and not yesterday plus one;
      3. the old schedule and `Heute` label are **removed before** the authoritative replacement is
         published;
      4. **exactly one** refresh runs, however many ticks were withheld;
      5. **no intermediate stale response republishes** — a late reply from the superseded attempt
         publishes nothing.

      This test proves what happens **once code runs**. It asserts nothing about when the browser
      chooses to run it;
- [ ] **window focus** delivers the same recovery as `visibilitychange` and `pageshow`, asserted
      independently, since it is a documented signal;
- [ ] **a forward source-date change** supersedes and refreshes;
- [ ] **a backward source-date change** supersedes and refreshes — a monotonic search would miss it;
- [ ] **a non-monotonic sequence**, using `America/Creston`, whose offset moved `GMT−06:00` →
      `GMT−07:00` at `1944-01-01T06:01:00Z`:

      | Instant | Source date |
      | --- | --- |
      | `1944-01-01T05:30:00Z` | `1943-12-31` |
      | `1944-01-01T06:00:00Z` | `1944-01-01` |
      | `1944-01-01T06:01:00Z` | `1943-12-31` |
      | `1944-01-01T07:00:00Z` | `1944-01-01` |

      Every one of the three observed changes must supersede and revalidate. This is the fixture a
      binary search cannot handle, because the predicate reverses;
- [ ] **if the pinned ICU lacks the historical Creston data**, the test **reports that prerequisite
      explicitly** and fails or skips visibly — **never** substituting a fixed offset or another
      zone, and never marking an unexecuted assertion passed;
- [ ] **a hidden document suspends polling**, asserted on the absence of further timer callbacks;
- [ ] **`visibilitychange` to visible, `pageshow`, and window focus** each derive the current date and
      run the same change check;
- [ ] **sleep advancing across multiple source dates** is handled by one direct derivation;
- [ ] **a `timeZone` change cancels the previous watchdog**, as does a configuration failure;
- [ ] **only one watchdog exists per accepted schedule/capability pair**, asserted by counting active
      timers;
- [ ] **a successful capability with no accepted schedule yet starts no watchdog** — asserted after
      the capability resolves and before the events response, by counting active timers;
- [ ] **a first metadata mismatch and a first exact range problem each start no watchdog**, asserted
      while the same shared-budget reconciliation is in flight;
- [ ] **a successfully reconciled matching pair starts exactly one watchdog**;
- [ ] **a mismatch after budget exhaustion**, **a non-range schedule failure**, and **a cancelled or
      superseded reconciliation** each leave **no** watchdog running;
- [ ] **a newer accepted selection replaces the previous watchdog**, so the old one never fires again
      and the count stays at one;
- [ ] recursive `setTimeout` is used, not `setInterval`: no two callbacks overlap;
- [ ] cleanup and coalescing remain intact across all of the above.

### Range derivation

- [ ] the 90-day window is identical with the process time zone pinned on both sides of UTC;
- [ ] clamping produces `from` and `to` inside the declared window at both boundaries;
- [ ] a `sourceToday` past `validity.to` issues no request;
- [ ] an inverted clamp issues no request;
- [ ] `deriveTargetRange` has **no** unusable-zone case to test: it accepts no `timeZone`, so an
      unresolvable zone is `deriveSourceToday`'s failure and is covered in
      [Helper ownership tests](#helper-ownership-tests).

### States and failures

- [ ] **the range-not-covered race** (Path 2): the initial capability and events request yield the
      first exact range problem; fresh providers and fresh areas then yield a requestable refreshed
      range; the one reconciled events retry yields the exact problem again. Only then does the
      dedicated German state render, showing the **second** problem's validated `requestId`; the first
      exact problem alone must not render it;
- [ ] **Path 1** — a fresh `available` capability whose `validity.to` is past, or whose clamp yields no
      intersection — renders the state and issues **no** collection-events request;
- [ ] **each excluded combination in [step 4b](#4b-range_not_covered-classification) produces its own
      documented outcome**, asserted case by case rather than by one blanket "error" expectation. Every
      negative assertion is **scoped to effects attributable to the attempt under test**: a stale or
      cancelled attempt must create no diagnostic and no timer, while an already-valid diagnostic or a
      successor's lifecycle owner may legitimately be present and must not be asserted absent.

  1. **A current action without the required confirmed selection** follows the documented
     `needs_selection` transition; **no** provider-specific request is issued; **no** API failure is
     fabricated — no failure copy, `requestId`, or announcement.
  2. **A late completion after the selection was cleared or replaced** leaves the current state
     **unchanged by that completion**: no stale failure copy, no announcement, no `requestId`, no
     follow-up request, and no lifecycle installation attributable to it.
  3. **A stale attempt token or a request pair that is no longer the confirmed pair** takes the
     canonical **no-transition** path, and the stale result consumes **no** reconciliation budget and
     starts **no** reconciliation.
  4. **Cancellation** produces no error presentation and no failure announcement attributable to the
     cancelled attempt, and does **not** interfere with a valid successor's controller, pending work,
     diagnostics, or lifecycle owner.
  5. **A current response with invalid identity or payload data** takes the established validation
     failure and its phase-aware presentation, and is **not** treated as an obsolete response.
  6. **A first exact `422` with budget remaining** runs the established fresh providers → fresh areas
     → recomputed range → conditional events retry sequence, with **no** premature terminal range
     state and no premature `error`.
  7. **Each legitimate terminal range-entry path** — Path 1 and both budget-exhausting orders of
     Path 2 — produces the correct state, the correct `triggeringRangeProblem` presence or absence,
     and the correct lifecycle ownership, with
     [the fresh-read reuse requirements](#entry-revalidation-is-evidence-based) still satisfied.
  8. **Other current failures** follow normal schedule-pipeline error behaviour **or** nested
     range-recovery failure behaviour **according to the recorded phase**, with the truthful transport
     operation retained: the range code on `listProviders`; the range code on `listServiceAreas`; the
     code on `listCollectionEvents` with a non-`422` status; `422` with another code; `network`;
     `timeout`; and `invalid_response`.
- [ ] **a `code` string alone never selects the state and never starts range recovery**, asserted on
      the recovery coordinator not being created for any excluded case;
- [ ] a successful response with `data: []` renders the empty-period copy with the declared coverage
      still visible, and is not an error;
- [ ] in a non-recovery context, a `network`, a `timeout`, an `invalid_response`, and a `problem`
      failure each render their own **subtype surface**, and each test asserts the top-level state is
      `error` **and** that the subtype's own copy is shown — so a renderer collapsing them into one
      message fails; recovery containment is covered by the phase-aware matrix;
- [ ] an **unrecognized problem `code`** renders generic copy **and** the validated `requestId`;
- [ ] a **`cancelled`** failure renders **no** error surface at all;
- [ ] the copy map is **exhaustive over each phase's renderable failure type** — `problem`,
      `network`, `timeout`, and `invalid_response` in every phase, plus the web-owned
      `source_date_unavailable` in `schedule_pipeline` and `range_recovery` — parameterized over those
      types in their documented phase/state contexts, each asserting non-empty German copy, a
      live-region announcement, and the documented `requestId` policy, with `source_date_unavailable`
      asserting **no** `requestId` and no fabricated transport operation;
- [ ] **a selection phase cannot carry `source_date_unavailable`**, asserted as a **type-level**
      expectation over `FailureContext` rather than a runtime branch: `selection_providers` and
      `selection_areas` keep `failure: ApiFailure`, so the combination does not typecheck and needs no
      copy entry. **`cancelled` is not a case**: it is excluded by the type, so the test neither requires
      copy for it nor asserts an announcement for it. Phase/action exhaustiveness is proven separately
      by [Phase-aware Retry tests](#phase-aware-retry-tests);

**Cancellation cases — scoped to the cancelled attempt's own effects.** Each asserts what the
cancelled attempt did *not* do, never that the whole UI is empty:

- [ ] a cancelled attempt produces **no error state, no diagnostic, no `requestId`, and no error
      announcement**;
- [ ] the cancelled attempt **starts no further work** — no follow-on request, no reconciliation, no
      recovery cycle;
- [ ] it **installs no lifecycle owner**, so no stale watchdog or coordinator survives it;
- [ ] **normal owned cleanup remains possible** — cancellation does not block the owner's own teardown;
- [ ] a **successor attempt's state, diagnostics, and lifecycle owner are not cleared** by the
      cancelled attempt's late completion;
- [ ] where a valid `triggeringRangeProblem` or a successor's watchdog already exists, the assertions
      **allow them to remain** — an existing diagnostic still on screen is not a cancellation-derived
      error, and the test must not demand a globally empty UI;
- [ ] **no stale non-cancelled failure is announced after supersession**;

Three of these are injected at the transport boundary rather than at the result boundary, so the
client's own classification is what the test exercises:

- [ ] **a rejected `fetch`** — the injected `fetch` returns a rejected promise, no HTTP response ever
      exists — produces `network`, and the network state renders with **no** `requestId`;
- [ ] **an HTTP `502` with a `text/plain` body** — verified as what Vite 8.1.5's default proxy error
      handler returns when `apps/api` is stopped — produces `invalid_response` carrying
      `status: 502`, renders the invalid-response state, and shows **no** `requestId`; asserted on the
      key set so a fabricated identifier fails;
- [ ] **an HTTP `500` with a `text/plain` body** produces `invalid_response` carrying `status: 500`
      through the same path. The classification rule — any non-ok response whose media type is not
      `application/problem+json` — is what is under test, so a different proxy or a future Vite major
      answering a different status needs no code change and no doc change;
- [ ] **a validated Problem Details response** — `application/problem+json` with a well-formed body —
      produces `problem` and renders the server-supplied `requestId`;
- [ ] the three render as three **different** states, so a test cannot pass by collapsing the
      upstream-down cases into one message;
- [ ] a `requestId` is rendered for a `problem` failure whose validated body supplied one;
- [ ] **no other failure renders an identifier**, asserted on the absence of the value rather than on
      a placeholder string;
- [ ] an unknown problem `code` degrades to generic copy;
- [ ] no rendered output contains `detail`, `instance`, `errors`, or any server-supplied message.

### Lifecycle and races

These use a fixture catalogue offering **two** non-demo providers, each with **two** available areas.
The live catalogue offers one of each, so switching and supersession exist **only** as automated
tests — that is the whole reason the fixture has to provide the second choice.

- [ ] **superseded provider response**: switch to the second provider while the first provider's
      service-area reply is still in flight; the late reply does not update state and the newer
      provider's areas are rendered;
- [ ] **superseded area response**: switch to the second area while the first area's
      collection-events reply is still in flight; the late reply does not update state and the newer
      area's schedule is rendered;
- [ ] **same-provider rapid area changes**: three area changes in quick succession within one
      provider render the last one, and no intermediate reply overwrites it;
- [ ] a superseded request is **aborted**, asserted on the signal rather than only on the discarded
      reply;
- [ ] **newest-selection-wins holds when replies resolve out of order**: the older attempt's reply
      resolves *after* the newer one and still does not win;
- [ ] a caller cancellation renders no error state and does not clear the newer schedule;
- [ ] changing the provider clears the area selection;
- [ ] a reload — a fresh mount with no persisted value — renders needs-selection, and no storage API
      was written to.

### Mapping and ordering

- [ ] both `CollectionEvent` variants round-trip through `CollectionEventSchema`;
- [ ] a malformed transport event yields a stated failure rather than a throw during rendering;
- [ ] **all three drop-off fields — window, source zone, and location — render for the first event
      and for a later event alike**, asserted on a fixture containing a drop-off in the first position
      *and* a drop-off further down the list, so a renderer that only decorates the hero event fails.
      **These are the proof of drop-off rendering**, because the live source publishes only two timed
      **appointments** a year and whether either falls inside the rolling 90-day range depends on the
      verification date;
- [ ] **the window is formatted in the source zone, not in the device's**, proven with explicit
      synthetic values in two files that pin `process.env.TZ` **east** and **west** of
      `Europe/Berlin` — `Asia/Tokyo` and `America/New_York` — and assert **byte-identical** output
      from both:

      | Fixture | `startsAt` | `endsAt` | Source zone | Required output |
      | --- | --- | --- | --- | --- |
      | summer | `2026-07-01T10:00:00Z` | `2026-07-01T12:00:00Z` | `Europe/Berlin` | `12:00 UTC+02:00–14:00 UTC+02:00 (Europe/Berlin)` |
      | winter | `2026-11-07T10:00:00Z` | `2026-11-07T12:00:00Z` | `Europe/Berlin` | `11:00 UTC+01:00–13:00 UTC+01:00 (Europe/Berlin)` |
      | **DST overlap** | `2026-10-25T00:30:00Z` | `2026-10-25T01:30:00Z` | `Europe/Berlin` | `02:30 UTC+02:00–02:30 UTC+01:00 (Europe/Berlin)` |

      The summer/winter pair proves the offset comes from `Intl` rather than a constant: the same UTC
      wall time renders an hour apart across the two dates. **A device-default formatter fails all
      three** — in Tokyo the summer window would read `19:00`–`21:00`, in New York `06:00`–`08:00`;
- [ ] **the DST-overlap fixture is unambiguous**: both endpoints render the identical clock value
      `02:30` with **different** offsets, so a formatter that stamps one shared offset on both ends
      fails, and `02:30–02:30 (Europe/Berlin)` without offsets fails;
### Paired-event rendering tests

**Ownership first.** `apps/web` **never receives an ICS appointment** and never receives a record
carrying two waste types: `CollectionEventSchema` in `@abfall-radar/api-client` types `wasteType` as a
**single** enum value, so every transport record the web sees is already one normalized event. Web
tests therefore **must not** import provider code, parse ICS, reconstruct upstream appointments, or
claim to verify provider normalization.

| Invariant | Owning evidence |
| --- | --- |
| Two verified source `VEVENT` appointments normalize into four events | **`packages/data-providers/src/node/normalize.test.ts`** — "splits one combined entry into a hazardous and a small-electronics event", "gives the pair identical timing and location but different identifiers", and "turns two combined entries into four events, so entry count is never the event count"; plus [AR-003's ingestion acceptance criteria](AR-003-official-ics-provider.md) |
| Four accepted normalized transport events are all displayed | **`apps/web`** data-boundary and component tests, below |

AR-005 adds **no** provider work and duplicates none of that proof. It starts where the transport
boundary starts.

The web fixture begins with **four already-normalized transport events**, each with exactly one
`wasteType`: two `hazardous` and two `small_electronics`, across **two dates**, one event of each waste
type per date. Paired events may share date, timing, source zone, and location.

- [ ] **all four accepted transport events remain represented** and **none is deduplicated**, asserted
      on the rendered output. This proves representation, **not** how the four records were produced;
- [ ] **the pair on one date keeps both waste-type labels and both distinct event ids**, so a renderer
      that collapses records sharing a window and place fails;
- [ ] **a single-date fixture — two already-normalized transport records — renders both**, not one;
- [ ] **a fixture with no mobile-drop-off records** renders `empty` or the remaining all-day
      events as applicable, **without** implying the source publishes nothing;
- [ ] **window, source zone, offsets where required, cross-date information where applicable, and
      location remain visible for each represented event** — not merely for the first of a pair sharing
      a window;
- [ ] one event per rendered row or card, asserted by counting rendered rows against the **transport
      record count**;
- [ ] a boundary guard asserts **no `apps/web` module imports `@abfall-radar/data-providers`** and no
      web test parses ICS — covered by the existing import-graph guard, reasserted here because this is
      where the temptation would arise.

- [ ] **the cross-midnight fixture renders both endpoint dates**: exactly
      `21.03.2026, 23:30 UTC+01:00–22.03.2026, 01:00 UTC+01:00 (Europe/Berlin)`, so an output of
      `23:30–01:00` — which reads as inverted or same-day — fails;
- [ ] **the cross-midnight window is accepted and rendered**, never rejected;
- [ ] **cross-midnight with an offset change** renders
      `28.03.2026, 23:30 UTC+01:00–29.03.2026, 03:30 UTC+02:00 (Europe/Berlin)`, proving both dates
      **and** both offsets vary independently;
- [ ] **a same-date window renders no dates**, so the date is added only when the endpoints differ;
- [ ] **the accessible text includes both dates when they differ**, asserted through the
      accessibility tree;
- [ ] exact endpoint **dates**, clock values, offsets, and IANA zone are asserted for every fixture,
      in both zone-pinned files, for the **first-event row and a later row**;
- [ ] **the exact local clock value, both endpoint offsets, and the IANA zone** are each asserted
      independently for all three fixtures, in **both** zone-pinned files;
- [ ] the **accessible label** communicates both endpoint offsets unambiguously, asserted through the
      accessibility tree;
- [ ] each zone-pinned file asserts the pinned zone is actually in effect, so the comparison cannot
      pass vacuously;
- [ ] **both the first displayed drop-off and a later list row** are asserted with these fixtures, so
      a hero-only formatter fails;
- [ ] the fixture is a **validated** one: it parses through the same `@abfall-radar/api-client`
      response validator the real boundary uses, so it cannot assert a shape the API could not produce;
- [ ] a curbside event renders no window and no location;
- [ ] an unsorted response is ordered before the next collection is chosen, asserted with a fixture
      whose first array element is not the earliest event;
- [ ] on one date, an all-day curbside event sorts **before** a timed drop-off;
- [ ] **two mobile drop-offs on the same date with *different* windows, whose opaque `id` order
      contradicts their `startsAt` order** — the later window carrying the lexically smaller `id` —
      resolve with the **earlier window first**, so a date-plus-`id` ordering fails this test. This is
      a **synthetic** fixture: it is not the verified source's shape, where the two same-date events
      come from one appointment and share a window;
- [ ] **lexical ordering is wrong and instant ordering is right**, proven with the millisecond pair on
      one date:

      | Event | `startsAt` | `id` |
      | --- | --- | --- |
      | earlier instant | `2026-11-07T10:00:00Z` | the lexically **larger** id |
      | later instant | `2026-11-07T10:00:00.500Z` | the lexically **smaller** id |

      As strings, `...:00.500Z` sorts before `...:00Z` because `.` precedes `Z`, and the ids point the
      same wrong way — so both a lexical `startsAt` comparison **and** a date-plus-`id` comparison put
      the later instant first. The test asserts the **earlier instant** is chosen as the next
      collection;
- [ ] **sub-millisecond precision is preserved**, which `Date.parse` cannot express:

      | Event | `startsAt` | `id` |
      | --- | --- | --- |
      | earlier instant | `2026-11-07T10:00:00.0001Z` | the lexically **larger** id |
      | later instant | `2026-11-07T10:00:00.0002Z` | the lexically **smaller** id |

      Both truncate to the same epoch millisecond, so an epoch-millisecond comparator ties and the
      contradicting ids then decide — putting the later instant first. The test asserts the **earlier
      instant** wins;
- [ ] **the source-specific paired-event fixture** uses the **actual normalized whole-second
      representation** recorded by AR-003 and provider normalization — `2026-03-21T10:00:00Z` to
      `2026-03-21T12:00:00Z` — where the two waste-type events of one appointment carry **identical**
      `startsAt` and `endsAt`. Ordering therefore proceeds to the documented later tie-breakers, and
      **both normalized events remain rendered** whichever sorts first;
- [ ] **the synthetic comparator-equivalence fixture** uses `.1Z` and `.100Z`. These are **synthetic
      schema-valid RFC 3339 spellings of the same instant**, written to exercise the comparator — they
      are **not** attributed to the municipal source, the ICS file, the provider, or AR-003
      verification, which all record whole seconds. The test proves the full-precision comparator
      treats them as **equal instants despite different lexical representations**, and then that the
      documented next ordering key — stable event identity — resolves their order;
- [ ] `.1`, `.10`, and `.100` are asserted equal to one another as fractional values;
- [ ] **`2026-11-07T10:00Z` equals `2026-11-07T10:00:00Z`** and two same-date events carrying those
      two forms fall through to `id`, with swapped ids swapping their order;
- [ ] **`2026-11-07T10:00Z` precedes `2026-11-07T10:00:00.0001Z`** even when the ids point the
      opposite way, so a seconds-only parser or an epoch-millisecond comparison fails;
- [ ] **ordering accepts minute-precision input** without rejecting or repairing it;
- [ ] **the comparator is exercised at the transport boundary**, on api-client-validated strings
      **before** domain mapping — the `endsAt >= startsAt` call — proving domain validation is not a
      precondition;
- [ ] **the comparator is exercised during domain-event ordering**, on domain-validated strings;
- [ ] both call sites accept **minute precision** and distinguish **sub-millisecond** differences;
- [ ] an **offset-bearing** form is handled per the pinned schema: rejected upstream today, and
      normalized as an instant if the schema ever accepts one;
- [ ] **invalid direct input** returns the helper's runtime failure result rather than a sort
      position, if the helper exposes one;
- [ ] **offset-equivalent representations**: `z.iso.datetime()` currently **rejects** numeric offsets,
      confirmed against the pinned `zod` build, so no such fixture is valid input today and this case
      is recorded as **not applicable with that reason**. The whole-second comparison parses instants,
      so it already normalizes offsets if the schema ever accepts them;
- [ ] the order is total and stable across runs: sorting the same set twice, and sorting a shuffled
      copy, produce the identical sequence;
- [ ] **the opaque-`id` tie-break is locale-independent and never equates distinct ids.** Two events
      with **`"\u00E9"`** and **`"e\u0301"`** as their ids — distinct, schema-valid strings — and
      **every earlier sort key equal** (same local date, same all-day/timed kind, same
      full-precision `startsAt`) so the tie-break is the only thing deciding:

      - the comparison is **nonzero** for the two ids, and yields **opposite signs** when the
        comparison order is reversed;
      - both input permutations produce the **same explicit output order**, stated in the test rather
        than inferred from the input;
      - both ids appear in the result **unchanged** — no case folding, normalization, or trimming;
      - the outcome is identical with the process locale and any `Intl` defaults varied, and no
        `localeCompare` or `Intl.Collator` appears in the comparator, asserted by reading the source.

      A comparator using `localeCompare` returns `0` for this pair in common locales and fails this
      test, which is exactly what it exists to catch.

### Schedule/capability reconciliation tests

Every case below asserts the **exact operation order and arguments**, per-operation call counts,
`confirmedSelection`, rendered state, active lifecycle owner, and the absence of every forbidden later
call. A test that checks only the final copy is insufficient. The initial matching case remains the
counterweight: matching metadata publishes normally and starts exactly one accepted-pair watchdog, so
the group cannot pass by rejecting everything.

- [ ] **first exact 422 → fresh providers → fresh areas → recomputed events retry → matching
      success**: order is exactly `listCollectionEvents`, `listProviders`, `listServiceAreas`,
      `listCollectionEvents`; the retry uses the refreshed range; the confirmed selection remains;
      exactly one watchdog starts; no recovery coordinator and no further reconciliation call starts;
- [ ] **first exact 422 → fresh providers → fresh areas → refreshed capability has no requestable
      range**: no second events request occurs; Path 1 `range_not_covered` renders; the confirmed
      selection remains; the recovery coordinator owns scheduled work; the completed refresh satisfies
      [the entry-evidence predicate](#entry-revalidation-is-evidence-based), so no immediate duplicate
      provider or area request occurs;
- [ ] **first exact 422 → fresh providers → fresh areas → events retry → second exact 422**: Path 2
      `range_not_covered` renders with the second problem's validated `requestId`; the selection remains;
      the coordinator owns scheduled work; there is no second reconciliation, third events request, or
      immediate duplicate recovery read;
- [ ] **provider removed** and **provider reclassified as `demo`** are separate cases: reconciliation
      stops after fresh `listProviders`, invalidates the confirmed selection, starts no
      `listServiceAreas` or events request, and owns neither lifecycle mechanism;
- [ ] **provider refresh failure** preserves its real `listProviders` operation and real failure
      subtype/code/status, records `phase: 'schedule_pipeline'` and `stage: 'reconciliation'`, starts
      no area or events request in the failed attempt, and owns neither lifecycle mechanism; its Retry
      starts a new full schedule attempt at providers with a fresh budget;
- [ ] **area removed** and **area now `unavailable`** are separate cases: reconciliation stops after
      fresh `listServiceAreas`, invalidates the confirmed selection, starts no events retry, and owns
      neither lifecycle mechanism;
- [ ] **area refresh failure** preserves its real `listServiceAreas` operation and real failure
      subtype/code/status, records `phase: 'schedule_pipeline'` and `stage: 'reconciliation'`, starts
      no events retry in the failed attempt, and owns neither lifecycle mechanism; its Retry starts a
      new full schedule attempt at providers rather than resuming at areas;
- [ ] **metadata mismatch → fresh providers → fresh areas → recomputed events retry → exact 422**:
      the mismatch consumes the shared budget, the exact retry problem enters `range_not_covered`, the
      selection remains, recovery owns scheduled work, and no second reconciliation or immediate
      duplicate recovery read occurs;
- [ ] **first exact 422 → fresh providers → fresh areas → recomputed events retry → metadata
      mismatch**: the 422 consumed the shared budget, so the mismatch becomes `invalid_response` for
      `listCollectionEvents` with `status: 0`, no `requestId`, no range state, no watchdog, no recovery
      coordinator, and no further request;
- [ ] **changed `timeZone`, `validFrom`, and `validTo`** each exercise the metadata-mismatch trigger,
      discard the first response completely, refresh in canonical order, recompute the range, and accept
      a matching replacement; only the final matching zone may own the single watchdog;
- [ ] **a second metadata mismatch** produces local `invalid_response` for
      `listCollectionEvents` with `status: 0`, no `requestId`, no third events request, no range state,
      and no lifecycle timer;
- [ ] **other Problem Details**, `network`, `timeout`, and `invalid_response` on the reconciled events
      retry each retain their normal schedule classification and start no lifecycle timer;
- [ ] **supersession while awaiting fresh providers**, **while awaiting fresh areas**, and **while
      awaiting the one events retry** are separate tests: abort is observed, the late result publishes
      no state, starts no later call, and starts or replaces neither lifecycle mechanism; the newer
      selection alone wins;
- [ ] the distinctive events and provenance of every discarded first response are absent from the
      rendered output, and no fail-closed path fabricates a `requestId`.

Remove the older expectation that one capability read followed by the first exact 422 immediately
enters `range_not_covered`; that sequence is now incomplete and must fail the test if no provider and
area refresh follows it.

### Timed-event date and zone consistency tests

- [ ] `startsAt` `2026-03-20T23:30:00Z`, source zone `Europe/Berlin`, `event.date` `2026-03-21` →
      **accepted**. The instant is 20 March in UTC and 21 March in Berlin, so a UTC-substring
      comparison fails this test;
- [ ] the same `startsAt` with `event.date` `2026-03-20` → `invalid_response` for
      `listCollectionEvents` with `status` exactly `0`;
- [ ] an event whose `timing.timeZone` differs from the capability and `meta.source.timeZone` →
      `invalid_response` with `status: 0`;
- [ ] **device/process zones pinned east and west of Berlin produce identical results** for both
      cases, so a device-zone derivation fails;
- [ ] the **first invalid event rejects the complete response**: a fixture whose second event is
      inconsistent renders no event at all, including the valid first one;
- [ ] the rejection renders **no partial event, no `requestId`, no raw timestamp, and no rejected
      payload**, asserted by searching the rendered output for the offending values;
- [ ] a window **ending on a later source-local date** with a correct `event.date` is **accepted**,
      so the invariant cannot pass by rejecting every cross-date window.

### Helper ownership tests

- [ ] **an unusable zone fails before range derivation**: `deriveSourceToday` returns its typed
      failure and `deriveTargetRange` is **never called**, asserted on a spy;
- [ ] the resulting failure is the web-owned `source_date_unavailable` — **no** api-client
      `operation`, **no** `status`, **no** `requestId`, and **no** `RangeError` text — and **the
      particular events request whose range would have come from that derivation is not issued**,
      asserted on the request spy for that attempt only;
- [ ] **a valid `sourceToday` produces identical ranges regardless of device zone**, asserted with the
      process zone pinned east and west;
- [ ] **no duplicate source-date derivation occurs in the range helper**: `deriveTargetRange` accepts
      no `timeZone`, and a source scan confirms it constructs no `Intl.DateTimeFormat`.

### Drop-off window-order tests

All on `mobile_drop_off` events, driven through the injected boundary:

- [ ] `startsAt` `2026-11-07T10:00:00.0002Z`, `endsAt` `2026-11-07T10:00:00.0001Z` →
      `invalid_response` for `listCollectionEvents` with `status` exactly `0`. Both parse to the same
      epoch millisecond, so a `Date.parse` check — including the shared schemas' own — accepts this;
- [ ] `startsAt` `.0001Z`, `endsAt` `.0002Z` → **accepted** and rendered;
- [ ] `startsAt` `…10:00:00.1Z`, `endsAt` `…10:00:00.100Z` → **equal, accepted** — a **synthetic**
      equal-instant pair, not a source representation;
- [ ] the **source-specific** whole-second window `2026-03-21T10:00:00Z` to `2026-03-21T12:00:00Z` →
      accepted, matching what AR-003 and provider normalization actually record;
- [ ] exactly equal `startsAt` and `endsAt` → **accepted**, because the contract forbids only
      "before";
- [ ] a **minute-precision** `startsAt` with a valid later `endsAt` → accepted;
- [ ] **minute-precision equal endpoints** → accepted;
- [ ] the inverted case renders **no partial schedule** — no event content at all — and exposes **no
      `requestId`**, asserted on the key set;
- [ ] the inverted case leaks **no timestamp string** into the DOM, asserted by searching the rendered
      output for both offending values.

### Provider identifier uniqueness tests

- [ ] **duplicate provider ids with otherwise different records** produce `invalid_response` for
      `listProviders` with `status` exactly `0`;
- [ ] **identical repeated provider records** produce the same failure;
- [ ] **a duplicate where one record is `demo` and the other `official_ics`** produces the same
      failure — proving the check runs **before** demo filtering, which is the case a filter-first
      implementation would silently accept;
- [ ] **unique provider ids pass** and the catalogue renders normally, so the group cannot pass by
      rejecting everything;
- [ ] a duplicate renders **no provider at all**, asserted on the absence of every entry's content;
- [ ] a duplicate issues **no service-area request** and **no collection-events request**, asserted on
      the request spy;
- [ ] the failure carries **no `requestId`**, asserted on the key set.

### Service-area identifier uniqueness tests

- [ ] **duplicate area ids across different availability branches** — one `available`, one
      `unavailable`, same id — produce `invalid_response` for `listServiceAreas` with `status` exactly
      `0`;
- [ ] **identical repeated areas** produce the same failure;
- [ ] **unique area ids pass** and the areas render normally;
- [ ] a duplicate renders **no area at all**, neither available nor unavailable;
- [ ] a duplicate issues **no collection-events request**, asserted on the request spy;
- [ ] the failure carries **no `requestId`**.

### Event identifier uniqueness tests

- [ ] **duplicate ids on otherwise different events** — same `id`, different dates and waste types —
      produce `invalid_response` for the collection-events operation with **`status` exactly `0`**,
      asserted on the value;
- [ ] **a schema-valid duplicate-id body returned with a non-200 `response.ok` status, such as `206`,
      also produces `status: 0`** — neither a fabricated `200` nor the real `206`, because the success
      envelope never carried it to the web layer;
- [ ] **`status: 0` is absent from every user-visible string**, asserted against the rendered output
      rather than against the failure object;
- [ ] **two identical repeated events sharing one id** produce the same `invalid_response`, rather
      than being treated as interchangeable or silently de-duplicated;
- [ ] **a response whose ids are all unique passes** the check and renders normally, so the test
      cannot pass by rejecting everything;
- [ ] a duplicate-id response renders **no partial schedule**: no event from it reaches the surface,
      asserted on the absence of every event's rendered content;
- [ ] the duplicate-id failure renders **no fabricated `requestId`** and no server diagnostic text,
      asserted on the key set rather than on a placeholder string;
- [ ] the check runs **before** domain mapping and ordering, asserted on call order so a check that
      ran after rendering fails.

### Coverage semantics

- [ ] **the three source fields render independently**, using distinct fixture values so a collapsed
      rendering fails:

      | Field | Fixture value |
      | --- | --- |
      | `meta.source.name` | `Kommunaler Servicebetrieb` |
      | `meta.source.attribution` | `Kommunaler Servicebetrieb, Koblenz` |
      | `meta.source.landingPageUrl` | a documentation-reserved HTTPS URL under `*.example.test` |

      asserted as three separate expectations: the exact source name is rendered, the exact
      attribution text is rendered, and the link's `href` equals the validated `landingPageUrl`
      exactly;
- [ ] **attribution remains visible when `data` is `[]`**;
- [ ] **Named prohibited fields do not leak, and required product data is still rendered.** The vague
      "no other untrusted field" rule is replaced by explicit assertions over one negative fixture.

      **Injection point and validator behaviour, read from the real contract.**
      `ScheduleSourceSchema` in `packages/api-client/src/contracts/collection-events.ts` is a plain
      `z.object`, which **strips** unknown keys rather than rejecting them — confirmed against the
      pinned `zod@4.4.3`: `z.object({name: z.string()}).parse({name: 'a', __debug: 'X'})` returns
      `{"name":"a"}`. The sentinels are therefore injected into the **raw transport payload before
      validation**, the response still parses **successfully**, and nothing about `api-client` or its
      unknown-field policy changes. These keys are **test-only injected fields and are not part of the
      API contract**; no schema gains them.

      | Injected key | Sentinel value |
      | --- | --- |
      | `meta.source.__arDebugSentinel` | `AR005-LEAK-SOURCE-7f3a` |
      | `meta.__arRawSentinel` | `AR005-LEAK-META-91c2` |
      | `data[0].__arEventSentinel` | `AR005-LEAK-EVENT-b40e` |

      The test asserts **both directions**, so neither can be satisfied by breaking the other:

      - **required validated product data renders** — the exact `meta.source.name`, the exact
        `attribution`, the event presentation fields per their documented contracts, and an anchor
        whose `href` equals the validated `landingPageUrl` **exactly**. The test **fails if any of
        these is hidden**;
      - **none of the three sentinel values appears anywhere in the rendered output** — not in text
        and not in any attribute, searched across both;
      - **no whole response or debug payload is dumped into the DOM**: no serialized `meta`, no
        serialized response object, and no `<pre>`/`data-*` attribute carrying one.

      This bans **named** fields, not categories. An API-derived string, a link, or a URL that
      resembles a calendar or download path is **not** prohibited by this criterion when it is a
      documented, validated, rendered field playing its documented role;
- [ ] a link that opens a new context carries the appropriate `rel` protection;
- [ ] the complete declared `coverage.wasteTypes` is rendered as provenance;
- [ ] the declared coverage is still rendered when `data` is `[]`;
- [ ] coverage is never derived from the events array, asserted with a fixture whose declared coverage
      is a strict superset of the types actually present;
- [ ] no waste-type selector, filter control, or preference state exists on any surface.

### Boundary guard tests

- [ ] **no module outside `src/adapters/` imports or re-exports `@abfall-radar/api-client`**, asserted
      on the **importing module's own specifiers**, not on transitive reachability — the intended
      `main.tsx` → hook → adapter → `api-client` path must **pass**;
- [ ] **positive:** the adapter-mediated path is exercised and allowed, with the adapter as the only
      module naming the package;
- [ ] **negative:** a direct `@abfall-radar/api-client` import from outside `src/adapters/`, **and** a
      re-export bypass (`export * from '@abfall-radar/api-client'` in a non-adapter module, or a
      wrapper re-exporting its client), are each **rejected**;
- [ ] this is **distinct from fixture protection**: reaching a protected fixture **through** an
      adapter remains forbidden by
      [the production dependency guard](#the-production-dependency-guard), which judges resolved
      targets rather than which module named them;
- [ ] no module outside `src/adapters/` calls `fetch`;
- [ ] no module imports from `apps/extension`;
- [ ] **no production entry reaches a protected test or fixture module.** After rejecting any
      deviation from the complete HTML source shell and its closed build inputs, walk the sole
      `index.html → /src/main.tsx` edge and then static imports,
      side-effect imports, barrel re-exports, and string-literal `import()`, **no** resolved target
      lies in `apps/web/src/test/**` — including `src/test/build-output-fixtures/**` — or in any
      `*.test.*`/`*.spec.*` module. Targets are judged by **resolved absolute path**, with the `@/`
      alias resolving to the **`apps/web` workspace root** — so `@/src/test/…` reaches the protected
      directory — plus directory `index` resolution, TS/TSX extension candidates, and Vite query
      suffixes handled as the production build handles them, so a wrapper, alias, or query cannot
      bypass it. An
      **unresolved in-scope import fails the check** rather than being skipped. The failure names the
      forbidden resolved target and the complete import chain;
- [ ] **the guard runs in the mandatory path** — inside `apps/web`'s Vitest suite and therefore inside
      `pnpm check` — and is not a manual instruction or an opt-in script;
- [ ] **import extraction is parser-based**, over the **unmodified** source under the workspace's
      parser modes, per
      [parser-based import extraction](#import-extraction-is-parser-based-not-regex-and-line-stripping).
      Neither `withoutCommentLines` nor a regex specifier scan is used, asserted by reading the guard's
      source: a comment on the same line as an import must not remove the import, and import-like text
      in a comment or string must not create one;
- [ ] **syntax validity comes from public API only**: a `ts.Program` with `noEmit: true`,
      `program.getSourceFile(fileName)`, and `program.getSyntacticDiagnostics(sourceFile)`. **No**
      access to `SourceFile.parseDiagnostics` or any other internal member, **no** unchecked cast,
      **no** suppressed type error, and **no** emit. A recovered AST is **not** accepted as proof of
      valid syntax — malformed source with a non-empty syntactic-diagnostic set **fails the check** —
      and an absent source file or unreadable path fails too, never becoming an empty dependency list.
      Semantic and type diagnostics are **not** substituted for the syntactic set;
- [ ] **resolved dependencies are classified in the documented order** per
      [dependency classification](#classifying-a-resolved-dependency): resolve → **protected-path
      check** → classify → traverse `.ts`/`.tsx` → **traverse `.css` recursively** → boundary-check a
      genuine leaf resource **before** terminating → otherwise fail. The `main.tsx` →
      `src/app/styles.css` chain passes including its Tailwind and UI `@import`s; no unknown
      extension, unstripped query, or unresolvable specifier passes silently;
- [ ] **Bare specifiers are classified by resolved target, not by shape**, per
      [package and workspace resolution](#package-and-workspace-resolution): `react-dom/client` and
      the planned React imports resolve and pass; `@abfall-radar/api-client`, `@abfall-radar/domain`,
      `@abfall-radar/ui`, and `@abfall-radar/ui/styles.css` resolve through their declared `exports`
      to **workspace TypeScript and CSS sources** and are **traversed**; a missing, undeclared,
      forbidden, or unsupported import **fails** with an informative diagnostic. Resolution uses the
      build's **production browser conditions**, never an assumed `require.resolve` result, and a
      pnpm symlink or `node_modules`-shaped path never causes a workspace package — or a protected
      target reached through one — to be skipped;
- [ ] **`new URL(…, import.meta.url)` is rejected as an unsupported dependency-producing form** in
      every production-reachable first-party or workspace script, per
      [URL dependency forms](#url-dependency-forms-are-rejected): standalone, and nested inside
      `new Worker(…)` or `new SharedWorker(…)`. Detection is an AST visit over the original source
      that inspects every `NewExpression`, unwraps parentheses and the syntax-only wrappers `as`,
      `satisfies`, `!`, and `<T>` through the public guards, and recognises `import.meta.url` as a
      `MetaProperty` property access. It rejects whatever the first argument is, **without** resolving
      the referenced file, evaluating anything, or stripping comments; reports file, line, column,
      the expression's text, and the production-entry chain; and leaves ordinary URL parsing without
      `import.meta.url`, the third-party boundary, and the four emitted-URL categories unchanged;
- [ ] **Third-party packages terminate traversal and that limit is stated**, not disguised: they are
      resolved and identity-checked, their internals are **not** audited and **never** parsed by the
      TS/TSX-only extractor, and no assertion claims otherwise. The forbidden-package and
      Node-built-in rules are unchanged;
- [ ] **Tailwind content discovery is closed and checked separately from import traversal**, per
      [Tailwind content discovery](#tailwind-content-discovery): `apps/web/src/app/styles.css` imports
      `tailwindcss` with **`source(none)`**; registers exactly `apps/web/index.html`, `apps/web/src`,
      and `packages/ui/src`; and excludes `apps/web/src/test/**` plus every colocated `*.test.ts`,
      `*.test.tsx`, `*.spec.ts`, and `*.spec.tsx` under both scanned trees. Paths resolve relative to
      the stylesheet containing each directive. `@source not` is an exclusion, never a forbidden load.
      The **effective scanned file set** — not a glob's base directory — contains no protected file,
      and no imported workspace stylesheet widens or re-enables discovery. Generated production CSS
      lacks both planted protected candidates while still containing production web and shared-UI
      candidates;
- [ ] **CSS dependencies are followed, not treated as leaves.** The reported chain
      `main.tsx → src/app/styles.css → @import → src/test/build-output-fixtures/banner.css` is
      **rejected**, with the complete three-step import chain in the diagnostic. Extraction uses the
      **`postcss` parser** and `postcss-value-parser` for preludes — never line removal or a specifier
      regex — and covers quoted and `url(...)` `@import` forms, import modifiers, relative paths
      resolved from the **importing stylesheet**, alias and workspace-package specifiers, Tailwind
      4.3.3's `@reference`/`@plugin`/`@config`, and local `url(...)` resources. No supported
      file-loading directive is silently ignored. `@source` and `@source not` are **not** judged by
      this traversal; they belong to the separate content-discovery check;
- [ ] **A protected target is rejected on reachability, not on contents**: a fixture with **no URLs**,
      one holding an otherwise sanctioned namespace or React diagnostic value, and one containing
      ordinary CSS are rejected identically. **No emitted-output exemption grants permission to import
      a fixture**, and all four emitted-URL categories keep their exact restrictions;
- [ ] **One visited set spans script and CSS edges**, so repeated imports and `@import` cycles
      terminate deterministically while every edge is still classified and boundary-checked before the
      set short-circuits traversal;
- [ ] **Emitted-bundle information is not accepted as a substitute**: CSS `@import` targets are inlined
      before a chunk list exists, so no assertion may use one in place of this source-graph walk;
- [ ] **test and verifier entries still import their fixtures freely**: the walk starts only at
      production entries, and a fixture importing another fixture is unaffected;
- [ ] **bundle inspection is not accepted as evidence** for this boundary. The guard is a source-graph
      rule, and no assertion may substitute "no fixture module appears in `dist`" for it, because
      inlining erases the module while the value ships;
- [ ] no module imports `@abfall-radar/data-providers`;
- [ ] no module imports `getUpcomingEvents` or `getRelativeDateLabel`;
- [ ] no module in `packages/ui` performs data fetching or transport mapping;
- [ ] each guard scans a meaningful number of files, so none can pass vacuously.

**Closed HTML/build-entry regression cases.** These are ordinary source-boundary tests. The test
passes only when the same production check returns the required verdict; no build or `dist` read is
needed to demonstrate source-shell rejection.

| Source/configuration case | Required result |
| --- | --- |
| The complete canonical HTML source shell and resolved default entry settings | **Pass**, then record exactly the HTML edge to `src/main.tsx` and continue the existing graph walk |
| Add `<link rel="stylesheet" href="/src/test/build-output-fixtures/banner.css">` where the target has no URLs | **Reject** the HTML shell before traversal |
| Add a preload/icon link, `img src`/`srcset`, media source, iframe/`srcdoc`, object, SVG reference, `base`, import map, inline script/style, or second module script | **Reject**; these are distinct mutations, not a test of the stylesheet spelling alone |
| Put a resource inside `template`, add a duplicate attribute, encode its path with character references, or append markup after the canonical document | **Reject** the complete source mismatch; no subtree or raw-URL-only comparison |
| Change the sole script path to a protected fixture or a permitted-looking extra entry | **Reject**, even if its contents contain no URLs |
| Turn on `publicDir`, add/change Rollup input, enable library mode, change the resolved root, or add a CLI entry/config override to the build script | **Reject** the corresponding build-entry assertion |
| Introduce an application-configured copy/emission/HTML-transform hook outside the declared integrations | **Reject** the configuration boundary |
| Vite-generated stylesheet/module-preload links in fresh emitted HTML | **Do not apply source-template equality**; apply normal post-build URL and viewport checks |

**Production dependency-guard regression cases.** Each rejection fixture must be **rejected by the
guard**, and the enclosing test **passes on that expected rejection** — a rejection fixture the guard
accepts is a failing test. Rule in
[the production dependency guard](#the-production-dependency-guard).

| Case | Required result |
| --- | --- |
| A **direct** production import from `src/test/build-output-fixtures/` | **Rejected**, naming the resolved target and the one-step chain |
| An **indirect** chain — production entry → an ordinary-looking application module → a fixture | **Rejected**, with every step of the chain reported |
| A **barrel re-export** (`export * from` / `export { x } from`) that forwards a fixture export | **Rejected** — the re-exporting module's own location does not launder the target |
| An **aliased** import — `@/src/test/build-output-fixtures/react`, resolving to `apps/web/src/test/build-output-fixtures/react.ts` — and a **supported transformed** import (a string-literal `import()`, and a Vite query suffix such as `?raw`) | **Rejected** — resolution matches the production build, so neither bypasses the boundary |
| A **no-substitution template** specifier — `` import(`@/src/test/build-output-fixtures/react`) `` | **Rejected** — it is a static specifier with a known value |
| A `@/test/…` specifier, which resolves to the **non-existent** `apps/web/test/…` | **Fails as unresolved**, not silently skipped — it is in scope and does not resolve |
| A **production-looking wrapper** whose name and path contain no "test" or "fixture" but which resolves inside a protected boundary | **Rejected** — judgement is by resolved path, not specifier text |
| A fixture exporting an **otherwise permitted** value — the exact React diagnostic prefix, or an allowlisted namespace literal — reached from production | **Rejected**, proving an emitted-URL exemption grants no source provenance |
| **Legitimate** test and verifier fixture imports — a test importing a fixture, a fixture importing a fixture | **Allowed**, with no diagnostic |
| **Production imports from permitted application modules** — the ordinary `src/adapters/`, `src/app/`, `src/features/` graph | **Allowed**, and the walk visits a meaningful number of files so the case cannot pass vacuously |
| An **unresolved in-scope import** — a computed `import()` specifier, a concatenation, or a **substituted** template | **Fails the check**, reported as unresolved, never skipped and never evaluated |
| An **unsupported loading form** on a production-entry path — `import.meta.glob`, another wildcard loader, or `require` | **Fails the check** as an explicitly unsupported form, not silently omitted |
| **Block comment on the same line as a protected static import** — `` /* c */ import '@/src/test/build-output-fixtures/react'; `` | **Rejected.** The dependency is real; line-stripping preprocessing would have erased it |
| **Multiline block comment whose closing line also carries a protected import** | **Rejected**, for the same reason |
| **Protected literal dynamic import with an adjacent or intervening comment** — `` import(/* why */ '@/src/test/build-output-fixtures/react') `` | **Rejected**; comments are trivia, not separators the parser trips on |
| **Protected re-export with adjacent comments** — `` /* a */ export { X } from '@/src/test/build-output-fixtures/react'; /* b */ `` | **Rejected** |
| **Positive:** import-like text **solely inside a comment or an ordinary string** — `` const s = "import '@/src/test/build-output-fixtures/react'"; `` and the same text in `//` and `/* */` comments | **Allowed** — no dependency is created, and the walk records none. This is what the parser buys over a regex |
| **Malformed syntax** — a production module with a syntax error, which still yields a recovered AST | **Fails the check** on the non-empty syntactic-diagnostic set, naming the file and the formatted diagnostics; never reported as "no imports" |
| **Missing or unreadable file** — `program.getSourceFile` returns `undefined` | **Fails the check**, naming the file |
| **A realistic, architecture-compliant application entry** — `main.tsx` imports `react-dom/client`, `@/src/app/styles.css`, and the application composition; a feature hook imports a module under `src/adapters/`; **only that adapter** imports `@abfall-radar/api-client`; components import `@abfall-radar/domain` and `@abfall-radar/ui` | **Allowed by every boundary check together** — fixture reachability, the adapter-only `api-client` rule, and the URL-form rule. The workspace packages are **traversed** into their `src/` sources and `react-dom/client` is recorded at the third-party boundary. A variant where `main.tsx` imports `@abfall-radar/api-client` **directly** passes fixture reachability but **fails** the adapter-only rule, and is not a passing case |
| **A protected SVG referenced through `new URL`** — `new URL("../test/build-output-fixtures/logo.svg", import.meta.url)` in a production module | **Rejected** as an unsupported form, with location, expression, and entry chain. The SVG is never resolved |
| **A protected worker through `Worker`** — `new Worker(new URL("../test/build-output-fixtures/worker.ts", import.meta.url), { type: "module" })` | **Rejected**; the nested URL constructor is found |
| **A protected worker through `SharedWorker`** — the same shape with `new SharedWorker(…)` | **Rejected** |
| **A permitted-looking worker with a downstream fixture import** — `new Worker(new URL("./sync-worker.ts", import.meta.url))`, where `sync-worker.ts` is ordinary production code that itself imports a protected fixture | **Rejected at the URL constructor.** The form is unsupported before any question of what the worker imports arises, so the verdict does not depend on following it |
| **Adjacent comments** — `new URL(/* asset */ "./a.svg", /* base */ import.meta.url)` | **Rejected**; comments are trivia |
| **A no-substitution template** first argument — ``new URL(`./a.svg`, import.meta.url)`` | **Rejected** |
| **Syntax-only wrappers** — `new URL("./a.svg", (import.meta.url as string))`, `import.meta!.url`, `(… satisfies URL)`, and parenthesised callee `new (URL)(…)` | **Rejected**; each wrapper is unwrapped through the public guards |
| **A computed first argument** — `new URL(assetName, import.meta.url)` | **Rejected**; the argument is never evaluated |
| **Constructor-like text only in a comment or string** — `// new URL("./a.svg", import.meta.url)` and `const s = "new Worker(new URL('./w.ts', import.meta.url))"` | **Allowed** — neither is a `NewExpression`, so nothing is created |
| **Ordinary URL parsing without `import.meta.url`** — `new URL("https://example.test/x")` and `new URL(path, base)` | **Allowed**; the restriction is specific to the dependency-producing form |
| **A workspace re-export chain reaching a protected fixture** — `@abfall-radar/ui` → an internal module → a protected `apps/web` fixture | **Rejected**, with the chain crossing the package boundary intact. Treating workspace packages as opaque would pass this |
| **A missing or undeclared package** — a bare specifier that resolves to nothing | **Fails** with a diagnostic naming importer, specifier, and what was attempted; never silently skipped |
| **The reported bypass** — `main.tsx → @/src/app/styles.css → @import "./…/build-output-fixtures/banner.css"`, with `banner.css` containing **no URLs at all** | **Rejected**, with the complete three-step chain in the diagnostic. A CSS-terminal walker passes this and is what the case exists to catch |
| **A protected stylesheet reached through another allowed stylesheet** — an extra permitted `.css` hop before the fixture | **Rejected**; depth grants nothing |
| **Alias and import-syntax variants** — `@import url("…")`, `@import "…" layer(base)`, and an `@/src/…`-aliased target | **Rejected**; a modifier or alias may not conceal the target |
| **A protected resource referenced by allowed CSS** — `url(./…/build-output-fixtures/logo.svg)` from a permitted stylesheet | **Rejected**; the boundary check runs **before** leaf termination |
| **Legitimate application stylesheet chains** — `main.tsx → styles.css → @import "tailwindcss" source(none)` and `→ @import "@abfall-radar/ui/styles.css"` | **Allowed**; the required Tailwind import keeps working and CSS processing is not disabled. The stylesheet's `@source` directives are **not** evaluated here — [Tailwind content-discovery tests](#tailwind-content-discovery-tests) own them |
| **Comment-only import-like text** — `/* @import "./…/build-output-fixtures/banner.css"; */` | **Allowed**, producing no dependency. A leading comment yielded no at-rule on the store's `postcss@8.5.22`; the test re-establishes that on the approved `8.5.28` |
| **Repeated imports and an `@import` cycle** — `a.css → b.css → a.css`, plus the same stylesheet imported twice | **Terminates deterministically** via the shared visited set, with every edge still classified and boundary-checked |
| **Unresolved or unsupported CSS forms** — an unresolvable `@import`, a parser error, or a file-loading at-rule outside the documented set | **Fails the check** explicitly, naming importer, specifier, and resolved path where one exists |
| **Ordinary stylesheet edge** — `main.tsx` side-effect imports `@/src/app/styles.css` | **Allowed**; the walk records it, does not parse it as TypeScript, and **does follow** its own `@import`/`url(...)` dependencies |
| **Script dependencies are still traversed** — an ordinary `.ts`/`.tsx` chain beyond the stylesheet edge | **Traversed transitively**, so admitting CSS does not truncate the walk |
| **A stylesheet inside a protected fixture directory, imported directly** — `import '@/src/test/build-output-fixtures/banner.css'` | **Rejected.** The protected-path check runs **before** any kind-specific handling, so CSS grants no exemption |
| **An unsupported asset or unstripped query** — `.svg`, `.json`, or a query form outside the documented set | **Fails the check** explicitly, naming importer, specifier, and resolved path; never silently accepted |

### Configuration

- [ ] request URLs are same-origin and are built from the exact configured origin including its port,
      using a reserved `*.example.test` origin as the injected document origin;

The browser-origin resolver is a pure function over two injected strings — the serialized global
origin and the location origin — so every case below is reachable **without constructing a real
sandboxed iframe in jsdom**:

- [ ] **matching HTTP origins** resolve successfully;
- [ ] **matching HTTPS origins** resolve successfully;
- [ ] **an opaque global origin with an HTTP(S) location** — global `"null"`, location
      `https://sandbox.example.test` — is a **configuration failure**, which is the sandboxed-frame case and
      the reason `location.origin` alone is insufficient;
- [ ] the literal `"null"` global origin is refused;
- [ ] an **empty** and a **malformed** origin are each refused;
- [ ] a **non-web scheme** is refused;
- [ ] **disagreement** between a usable global origin and the location origin, after normalization, is
      refused rather than resolved in favour of either;
- [ ] **no api-client call is made after a configuration failure**, asserted on the request spy;
- [ ] `document.domain` is never read or assigned, asserted by a source scan.

### Emitted-artifact verification tests

Run by **`pnpm exec turbo run test:build-output --filter=@abfall-radar/web`**, whose Turbo graph
builds `@abfall-radar/web` first. **A direct `pnpm --filter @abfall-radar/web test:build-output`
bypasses `turbo.json` and proves nothing about freshness**, so it is never the documented invocation.
**Assertions inspecting real `dist` run only in this inner task.** Deterministic scanner-fixture
assertions may run in the ordinary suite using the same scanner on inert supplied input; no ordinary
test reads `dist`. Both sets remain on the mandatory `pnpm check` path.

**The inner task owns artifact inspection only.** It makes **no claim** about whether Turbo executed
or cache-replayed it, **never invokes Turbo**, never invokes itself, never runs two copies of itself,
and never parses a parent Turbo summary. Those assertions belong to
[the outer meta-verifier tests](#outer-meta-verifier-tests).

**Scanner rejection and stale-output replacement are different scenarios with different inputs at
inspection time.** Conflating them assigns one scenario two incompatible outcomes, so the expected
results are fixed here and every dependent description must agree:

| Scenario | Content **at inspection time** | Scanner result | Test result |
| --- | --- | --- | --- |
| **Test A** — negative scanner fixture | The prohibited URL is **still present** | **Reject** | **Pass** when rejection and diagnostics are asserted |
| **Test B** — stale-output replacement | Prior invalid content **has been replaced** with valid output | **Accept** | **Pass** when ordering, replacement, and verifier execution are proved |
| Normal clean production output | Only content permitted by [the canonical policy](#the-four-sanctioned-categories) | **Accept** | **Pass**, subject to the other checks |

- [ ] **Test A — prohibited content is actually inspected.** An **isolated emitted-asset fixture**
      containing a prohibited absolute URL is passed to **the same scanning implementation the
      production verifier uses**. **No build runs**, so nothing replaces the fixture before
      inspection. Assert **rejection**, and diagnostics identifying the **offending asset and value**;
      when exercised through the CLI, assert its **documented failure exit status**. The automated
      test **passes because it observed the expected rejection**. No second scanner implementation and
      no production configuration escape hatch is introduced. This proves scanner behaviour and does
      **not** replace the authoritative build-before-scan path for real application output;
- [ ] the verifier **fails clearly when an expected emitted file is absent or empty** — `index.html`,
      at least one JavaScript asset, and at least one CSS asset — rather than passing vacuously;
- [ ] the separate inner Vitest configuration selects only `src/test/build-output.verify.ts`; the
      ordinary configuration excludes it. HTML/JSX decoding uses inert `DOMParser`, with no script
      execution, subresource loading, direct untyped jsdom import, or extra type dependency;
- [ ] **the verifier recursively scans every emitted production HTML, JavaScript, and CSS asset** from
      the fresh `apps/web/dist` build, rather than checking selected filenames or selected hosts;
- [ ] **raw and contextually decoded absolute HTTP(S) occurrences are detected**, per
      [contextual decoding](#contextual-decoding-before-url-matching), including encoded scheme
      letters, colons and slashes, mixed-case schemes, CSS escaped code points, and HTML character
      references. The explicit fixture matrix below is mandatory; slash-only normalization fails it;
- [ ] **every detected occurrence fails unless it matches one of
      [the four sanctioned categories](#the-four-sanctioned-categories)**, enumerated once there. The
      **namespace** allowlist is only one of the four and is empty unless a fresh build establishes a
      required literal, and no match of any category exempts a near-match, another path/query, or
      another URL on the same host;
- [ ] a clean fixture with no absolute HTTP(S) URL occurrence passes;
- [ ] `http://127.0.0.1:3000` fails;
- [ ] `https://api.example.test` fails;
- [ ] an unrelated origin such as `https://unexpected.example.test` also fails, proving this is not a
      one-sentinel denylist;
- [ ] an origin in HTML fails, an origin in JavaScript fails, and an origin in CSS fails;
- [ ] all cases in the contextual-decoding fixture matrix below have their stated result;
- [ ] an exact documented platform namespace literal passes only when explicitly allowlisted;
- [ ] the platform-namespace fixture uses exact `http://www.w3.org/2000/svg` only to exercise the
      allowlist mechanism; it does not pre-authorize that literal in production, and a fresh build
      must establish any real entry;
- [ ] a near-match and another URL on the same host do not inherit an exact-literal exemption;
- [ ] failure output identifies the offending emitted asset and detected value;

**Contextual-decoding regression cases.** Each spelling below is the literal text supplied to the
scanner, not a host-language string that has already consumed its backslashes. Build fixture bytes
with raw strings or inert fixture files and assert their bytes before checking the result. The same
scanner used for production output owns these tests.

| Emitted fixture | Required result |
| --- | --- |
| `"https\u003a\u002f\u002fapi.example.test"` | **Reject**, reporting `https://api.example.test` and its original asset/location |
| `"\x68ttps\x3a\x2f\x2fapi.example.test"` | **Reject**; a scheme letter and punctuation are escaped |
| `"\u0068\u0074\u0074\u0070\u0073\u003a\u002f\u002fapi.example.test"` | **Reject**; the complete scheme is escaped |
| `"\u{68}ttps\u{3a}\u{2f}\u{2f}api.example.test"` | **Reject**, including code-point escape syntax |
| The same cases in single quotes and no-substitution templates, plus mixed escape forms and mixed-case `HTTPS://` | **Reject**, with case-insensitive scheme detection and no URL normalization |
| An ordinary string with `http` followed by a backslash plus actual line terminator, then `s://api.example.test` | **Reject** after cooking the line continuation |
| A substituted template with an escaped absolute prefix, or an absolute literal inside its expression | **Reject** the detected occurrence; do not evaluate the substitution |
| A tagged template with an absolute raw or cooked segment | **Reject**; no React or scaffold exemption follows from the segment alone |
| `"https\\u003a\\u002f\\u002fapi.example.test"`, with exactly the displayed doubled backslashes | **Pass** as this isolated no-URL fixture: its cooked value still contains literal backslashes. Do not decode it twice |
| The exact React diagnostic value with encoded scheme/colon/slashes in each permitted whole-literal form | **Pass** only for the React occurrence; a second forbidden literal still rejects the asset |
| The same escaped React URL in first-party JavaScript, or `href="https&#58;&#47;&#47;react.dev/errors/"` in first-party JSX | **Reject by Check 1**; Check 2 cannot establish first-party provenance |
| CSS `url("https\3a \2f \2f api.example.test")`, an escaped CSS string, and an escaped `@import` target | **Reject** after CSS decoding; retain genuine-comment context for banner matching |
| CSS dependency `@import "../\74 est/build-output-fixtures/banner.css"` from `src/app/styles.css` | **Reject by Check 1b** after decoding and resolving the protected path |
| HTML `href="https&#58;&#47;&#47;api.example.test"`, the equivalent hex references, and `&colon;&sol;&sol;` punctuation | **Reject** after one HTML decoding pass |
| Decoded HTML style/event attributes or nested `srcdoc` containing escaped URL literals | **Reject** after the appropriate language layers, without executing any of them |
| HTML with a script that would set a test marker and an external resource that would trigger a request | **No execution and no request**; the marker stays unset and the scanner never attaches parsed nodes or imports the asset |
| JavaScript/CSS syntax or escape-decoding failure | **Reject as unresolved**, naming the asset/location; no empty-success fallback |
| Clean minified division/regex syntax, legal non-URL Unicode escapes, and the established four-category positive fixture set | **Pass**; parser reuse must not reject ordinary valid output |

**Tailwind license-comment exemption fixtures.** The positive fixture uses the **actual observed
banner** — an abbreviated or invented comment would fail the required full-comment match and would
prove nothing. Rule in
[The Tailwind license-comment exemption](#the-tailwind-license-comment-exemption).

| Fixture | Expected |
| --- | --- |
| Clean CSS containing the exact verified banner `/*! tailwindcss v4.3.3 \| MIT License \| https://tailwindcss.com */` | **Pass** |
| The verified banner followed by a prohibited CSS `url(...)` | **Fail**, reporting the prohibited URL |
| The verified banner followed by an absolute `@import` | **Fail** |
| `https://tailwindcss.com` in a JavaScript string | **Fail** |
| The same URL in an HTML attribute | **Fail** |
| The same URL in a CSS string or `url(...)` | **Fail** |
| Complete banner-like text inside a **quoted CSS string** | **Fail** — it is not a comment |
| Complete banner-like text inside a **JavaScript string or template literal of any form** | **Fail** — the CSS comment exemption does not apply, and the React exemption covers one exact value only |
| A modified license comment carrying an additional unexpected URL | **Fail** |
| Another URL or path on the Tailwind host outside the sanctioned comment | **Fail** |
| An unrelated prohibited origin beside the valid banner | **Fail** |
| Existing escaped-origin and exact-namespace fixtures | **Retain their established results** |

**React diagnostic-literal fixtures.** The positive fixture uses the **actual pinned React
diagnostic formatter in the syntax it is actually emitted in** — the bundled
`` var t=`https://react.dev/errors/`+e `` **no-substitution template literal** recorded in the
evidence table — not a hand-written approximation and not the source's double-quoted form alone. Rule
in [The React diagnostic-literal exemption](#the-react-diagnostic-literal-exemption).

| Fixture | Expected |
| --- | --- |
| Double-quoted `"https://react.dev/errors/"` | **Pass** |
| Single-quoted `'https://react.dev/errors/'` | **Pass** |
| **Actual emitted** no-substitution template `` `https://react.dev/errors/` `` in the pinned formatter's bundled shape | **Pass** |
| The complete value with legal escaped scheme letters, colons, or slashes, in **each** permitted literal form | **Pass**, after one-pass cooking and exact whole-value comparison |
| A template **containing a `${…}` substitution** | **Fail** — substituted templates are outside the exemption |
| A substituted template whose **first segment is exactly** the sanctioned prefix, such as `` `https://react.dev/errors/${code}` `` | **Fail** — a segment never qualifies on its own, and no evaluation or constant folding is performed |
| A **no-substitution template** with a changed path, an added query, or an added fragment | **Fail** |
| A valid React literal **beside a separate prohibited URL** in the same asset | **Fail** on the prohibited URL only, with the React value still exempt |
| `https://react.dev` | **Fail** |
| `https://react.dev/other` | **Fail** |
| `https://react.dev/errors/123` as one complete hard-coded literal | **Fail** — the exemption is not a prefix rule |
| The exact URL embedded within a larger string | **Fail** |
| The exact prefix in an HTML attribute | **Fail** |
| The exact prefix in CSS `url(...)` or a CSS string | **Fail** |
| Another hostname containing similar text | **Fail** |
| Clean multi-asset fixture with the sanctioned React value, the verified Tailwind banner, and documented namespace literals | **Pass** |
| That same multi-asset fixture plus one additional unexpected origin | **Fail**, identifying the offending asset and value |

- [ ] the React exemption compares the **complete decoded value** of an **ordinary string literal or
      a no-substitution template literal** and requires **exact equality**, preserving the trailing
      slash — no hostname-wide, origin-wide, substring, or prefix match, and no normalization that
      discards a meaningful difference;
- [ ] a template literal qualifies **only with no substitution**; the verifier **evaluates no
      JavaScript and folds no constants**, so a substitution that could yield an empty string is
      still outside the exemption;
- [ ] **every other URL occurrence in the same asset is still scanned** after a React value is
      exempted;

**First-party transport regression — a different guard, and it must be attributed correctly.**

- [ ] first-party code **cannot use the React diagnostic address as a fetch destination or a
      configurable API origin**: `https://react.dev/errors/` placed in `apps/web/src/**` production
      source is rejected by **check 1, the first-party source scan**, and the web gateway continues to
      build same-origin requests from the resolved document origin with `cache: 'no-store'`;
- [ ] the test **attributes that rejection to the source scan and the gateway contract**, not to the
      emitted-literal allowlist. The output scan cannot distinguish dependency provenance from
      first-party use of an identical string, and no assertion may claim it does;
- [ ] the existing **development-proxy and test-fixture exceptions keep their own scope** and are not
      widened by this guard.

#### Tailwind content-discovery tests

**These are future implementation checks.** None was run during documentation preparation. Rule in
[Tailwind content discovery](#tailwind-content-discovery).

Two **unique, valid** utility candidates are planted where production must never scan them. Each is a
real Tailwind utility, so a leak would genuinely generate CSS rather than be ignored as nonsense, and
each is chosen to appear **nowhere** in allowed production source:

| Candidate | Planted in | Imported by production? |
| --- | --- | --- |
| `tracking-[0.1337em]` | an **unimported** file under `apps/web/src/test/build-output-fixtures/` | **No** — nothing imports it, so only content discovery could reach it |
| `tracking-[0.4242em]` | a **colocated** `*.test.tsx` beside a production component under `apps/web/src` | No — it is a test |

**Source-stage assertions**, in the mandatory source guard:

- [ ] the canonical stylesheet's `@import "tailwindcss"` carries `source(none)`, and the positive
      `@source` registrations are exactly the three documented paths;
- [ ] no imported workspace stylesheet adds a positive `@source`, imports `tailwindcss`, or sets
      `source(…)`;
- [ ] the effective scanned file set contains **no** file under `apps/web/src/test/**` and **no**
      `*.test.ts`, `*.test.tsx`, `*.spec.ts`, or `*.spec.tsx` under `apps/web/src` or
      `packages/ui/src` — asserted on **files**, not on a glob's base directory;
- [ ] **both candidates are absent from every file in the allowed production source set**, so a
      later absence from generated CSS cannot be explained by the candidate simply being present
      elsewhere.

**Post-build assertions**, in the **existing post-build verification stage** alongside the emitted-URL
scan, against a fresh build:

- [ ] **`tracking-[0.1337em]` and `tracking-[0.4242em]` are both absent from generated production
      CSS**;
- [ ] **production candidates still generate**: a unique utility used only in a production
      `apps/web/src` component, and one used only in a `packages/ui/src` primitive, are each
      **present** in generated CSS — so the fix cannot pass by scanning nothing.

**Mutation regressions.** Each must turn the relevant check red, and the enclosing test passes on that
expected failure:

| Mutation | Required result |
| --- | --- |
| **Remove `source(none)`** | The source stage **fails**; a build in that state emits a protected candidate |
| **Remove one `@source not` exclusion** — for example `"../test"` | The effective-set assertion **fails**, naming the exposed protected file |
| **Add a positive `@source` registration** that exposes protected files — for example `@source "../test"` or `@source "../../src/test/build-output-fixtures"` | The exact-registration assertion **fails**, and so does the effective-set assertion |
| **An imported workspace stylesheet adds `@source` or re-imports `tailwindcss`** | The imported-stylesheet assertion **fails** |

**Zod IPv6 URL-parsing-scaffold fixtures.** Positive fixtures use the **actual emitted text** quoted
in [the exemption](#the-zod-ipv6-url-parsing-scaffold-exemption), not a hand-written approximation.
**Every negative fixture must be rejected by the scanner, and the enclosing test passes on that
expected rejection** — a negative fixture that quietly passes the scan is a failing test.

| Fixture | Expected |
| --- | --- |
| Observed `ipv6` form: `` try{new URL(`http://[${n.value}]`)}catch{…} `` | **Pass** — exempt |
| Observed `cidrv6` form: `` …throw Error();new URL(`http://[${e}]`)}catch{…} `` | **Pass** — exempt |
| The same shapes with **renamed identifiers** (`a`, `x9`, `$t.value`, `q.r.s`) | **Pass** — the identifier-path form survives minifier renaming |
| A **changed static segment**: `https://[${e}]`, `http://x[${e}]`, `http://[${e}]/p`, `http://[${e}]?q`, `http://[${e}]#f`, or `http://[${e}]:80` | **Fail** |
| **Zero** substitutions: `` new URL(`http://[::1]`) `` | **Fail** — outside the shape |
| **Two** substitutions, or a substitution covering only part of the host | **Fail** |
| A **non-identifier interpolation**: `${f()}`, `${a+b}`, `${a[0]}`, `${a?b:c}`, `` ${`x`} `` | **Fail** — no call, operator, index, conditional, or nested template |
| The same template **outside** a `try`/`catch` window | **Fail** — the required enclosing context is absent |
| The result **used** rather than discarded — assigned, returned, awaited, or member-accessed | **Fail** |
| The same template passed to a **network operation**: `fetch`, `new Request`, `XMLHttpRequest#open`, `navigator.sendBeacon`, `importScripts`, or assigned to `location`/`src`/`href` | **Fail** — this is the case the exemption exists to keep rejecting |
| **Lookalike text in a surviving `/*! … */` legal comment** | **Fail** — comment bytes never satisfy a syntactic-context requirement |
| **Lookalike text inside a `'`, `"`, or `` ` `` string literal** | **Fail**, for the same reason |
| An **exempt occurrence adjacent to a forbidden URL** in the same expression, statement, and asset | **Fail on the forbidden URL only**, with the scaffold still exempt and scanning continuing to the end of the asset |
| A JavaScript asset with non-empty public syntactic diagnostics or an undecodable literal | **Fail**, reported as **unresolved** — never silently exempted |
| Valid division and regular-expression syntax beside an otherwise permitted scaffold | **Pass**; the TypeScript parser determines syntax without a hand-written slash heuristic |

- [ ] the exemption is decided from **emitted text only**: no expression evaluation, constant folding,
      identifier resolution, or execution of bundle code, asserted by reading the verifier source;
- [ ] **the emitted-JavaScript recognizer reuses the declared TypeScript compiler API**, with public
      diagnostics and original AST/source spans; it adds no dependency and uses no hand-written
      JavaScript lexer. CSS inspection and dependency traversal share the two approved parser packages
      in [the dependency table](#manifest-and-dependency-changes), and add no further parser;
- [ ] the existing **Tailwind**, **React**, **platform-namespace**, and **escaped-URL** boundary cases
      keep their established results and are re-run unchanged alongside these;
- [ ] the separate **stale-output** scenario is preserved: when the prerequisite build or cache
      restoration replaces stale output, the scanner subsequently **passes** — that is distinct from a
      negative fixture being rejected, and neither test may be rewritten into the other.

**Fixture-category tests.** These prove the fixtures may exist, not just what the verifier decides:

- [ ] **positive verifier fixtures may hold the exact real literals** — the documented W3C namespace
      literals, the verified Tailwind banner, and the exact React diagnostic literal — and the
      verifier **passes** on them;
- [ ] **negative verifier fixtures may hold real-host near-match data** — changed paths, queries,
      fragments, altered banner contents, and the real literals in forbidden contexts — and the
      verifier **fails** on them, identifying the asset and value;
- [ ] **API-origin fixtures remain subject to their own reserved-origin rule**: an API-base or
      gateway fixture uses loopback or `*.example.test`, and the documented development-proxy
      exception is unchanged;
- [ ] **the first-party source guard does not reject the sanctioned verifier fixtures** — it excludes
      `src/test/` fixture data, so the verifier tests can run at all;
- [ ] every verifier fixture is **inert data on a deterministic local transport**: no real website is
      fetched, no DNS resolution occurs, and no live API behaviour is relied on;
- [ ] a **prohibited fixture value emitted into production output is still rejected** by the
      production verifier — the fixture permission grants production nothing;

- [ ] only the **matched comment's text range** is excluded — a prohibited URL later in the same
      asset, the same line, or the surrounding CSS is still detected;
- [ ] the verifier remains **read-only**: no fixture asset is rewritten and no license notice is
      stripped;
- [ ] the CSS-comment recognizer **distinguishes comments from quoted strings**, proven by the two
      banner-like-text-in-a-string fixtures above.
- [ ] the emitted `index.html` carries **`lang="de"`** and **exactly one**
      `<meta name="viewport" content="width=device-width, initial-scale=1">`, with no zoom-disabling
      directive — proving both survived the production build, not merely that the source template
      declared them;
- [ ] **clean-checkout run**, the load-bearing one — driven through the outer meta-verifier or the
      complete root check, never by the inner task observing itself:

      1. begin with `apps/web/dist` **absent**;
      2. invoke the build-output check **through Turbo** —
         `pnpm exec turbo run test:build-output --filter=@abfall-radar/web`;
      3. prove **that same invocation built the current web workspace first**, asserted on the Turbo
         task graph or run summary rather than on the command exiting zero;
      4. inspect **only that invocation's** newly emitted HTML, CSS, and JavaScript, asserted on the
         emitted files' identity;

      A run that skips step 2 and calls the workspace script directly proves nothing about steps 3
      and 4, which is precisely why the direct form is not documented anywhere;
- [ ] **Test B — stale output is replaced before inspection.** Starting from a deliberately invalid
      prior `dist` — for instance one containing `http://127.0.0.1:3000` — invoke **the existing
      authoritative Turbo path**. Verify that the documented build/output-replacement step **replaces
      the invalid prior content before the verifier reads it**, that the scanner **actually executes
      against the resulting valid output**, and that the authoritative invocation **succeeds**.
      Preserve the existing evidence that the inner task is **uncached**, and preserve the documented
      caching/restoration mechanism — if valid cache restoration is what replaces the stale output,
      that is the mechanism. **Rejection is not expected here**: prohibited content existing *before*
      replacement is not prohibited content at inspection time, so **this scenario is never cited as
      evidence that prohibited content was rejected** — Test A is that evidence. **A successful
      process exit alone is not sufficient**: ordering, replacement, and verifier execution must each
      be proved;
- [ ] the reverse guard: a scan proves **no test under `apps/web/src/**` reads `dist`**, so the
      separation cannot erode back.

### Outer meta-verifier tests

Cases for `pnpm verify:web-build-output-task` — `scripts/verify-web-build-output-task.mjs`, **not a
Turbo task and not a Vitest test**. Ordinary Vitest tests never spawn Turbo. Because the script is
**not typechecked**, every case below asserts against **runtime-validated** parsed JSON.

Dry-run configuration assertions, against `--dry-run=json`:

- [ ] **the inner task missing from the dry graph** fails the outer command;
- [ ] **the `@abfall-radar/web#build` dependency missing** from that task's `dependencies` fails;
- [ ] **`resolvedTaskDefinition.cache` not `false`** — caching enabled for the inner task — fails.

Two-run execution assertions, against `--summarize` run summaries:

- [ ] **either child Turbo run exiting non-zero** fails the outer command;
- [ ] **either summary reporting `cache.status === "HIT"`** for the inner task fails;
- [ ] **missing or ambiguous run-summary evidence fails closed** — a summary that cannot be located
      unambiguously, lacks the inner task, or lacks its `execution` block is a failure, never an
      assumed pass;
- [ ] **a failing emitted-artifact scan propagates** through the child Turbo run and fails the outer
      command;
- [ ] **two consecutive invocations with unchanged sources are both observed as executed with caching
      bypassed** — `cache.status === "MISS"` and `execution.exitCode === 0` on both — so a future
      `cache: true` regression fails here rather than silently replaying a pass;
- [ ] **replayed stdout alone is never accepted as proof of execution**: the assertion reads the
      structured summary, not matched output text;
- [ ] the script **identifies only the summaries created by its own invocation** and **cleans up only
      its own** temporary data;
- [ ] **malformed or structurally unexpected Turbo JSON fails closed** — a missing `tasks` array, a
      non-object entry, or an absent `resolvedTaskDefinition` is a failure, never a skipped assertion.
      This is the guard that replaces the typechecking the script deliberately does not have.

### The `configuration_error` surface

Component and application tests, each driving the resolver's two injected strings:

- [ ] a **`file:` or other non-web origin** renders `configuration_error`;
- [ ] an **opaque global origin `"null"` with an HTTP(S) location** renders `configuration_error` —
      the sandboxed-frame case;
- [ ] **mismatching global and location origins** render `configuration_error`;
- [ ] a **malformed origin** renders `configuration_error`;
- [ ] the state **renders instead of a thrown render**: the application mounts and does not crash;
- [ ] **the page is not blank** — a stable heading and the normal application shell are present,
      asserted on the accessibility tree;
- [ ] the surface carries **status or alert semantics**, and **no loading spinner remains active**;
- [ ] **no api-client call is made**, asserted on the request spy;
- [ ] the DOM contains **no `requestId`, no HTTP status, no rejected origin or URL, and no technical
      detail** — asserted by searching the rendered output for the injected origin string and for a
      status-like value, so a leaked value fails;
- [ ] **valid matching HTTP(S) origins continue into normal catalogue loading**, so the test group
      cannot pass by rejecting everything.
- [ ] **`apps/web/src/**`, excluding test files and `src/test/` fixture data, contains no absolute API
      origin**; the scan does not read `vite.config.ts`, fixtures, or documentation, so a correct proxy
      configuration and the sanctioned verifier fixtures cannot fail it;
- [ ] that scan is proven non-vacuous: it reads a meaningful number of files, and an absolute origin
      placed in a non-test module under `src/` would fail it;
      **The emitted-output assertions live in `test:build-output`, not here** — the ordinary test
      suite must not read `dist`. See
      [Emitted-artifact verification](#emitted-artifact-verification-tests).
- [ ] **`vite.config.ts` contains the exact development proxy target `http://127.0.0.1:3000`**,
      asserted **positively** against the resolved configuration, so drift to `localhost`, another
      port, or an unreviewed host fails;
- [ ] **the proxy context is segment-aware**, `^/api(?:/|$)`, and is exercised against every path
      below — a plain `/api` string key is a **prefix** match in Vite and would wrongly capture all
      four near misses:

      | Path | Proxied |
      | --- | --- |
      | `/api` | yes |
      | `/api/` | yes |
      | `/api/v1/providers` | yes |
      | `/apiary` | **no** |
      | `/api-old` | **no** |
      | `/apis` | **no** |
      | `/application` | **no** |
- [ ] **no environment-dependent production host is invented**: no `import.meta.env` or `process.env`
      value supplies an API origin anywhere in `apps/web`.

### Accessibility

- [ ] every control has an accessible name;
- [ ] focus moves to the appropriate heading when one surface replaces another;
- [ ] sequential keyboard navigation reaches every operable control and skips every disabled one;
- [ ] a polite live region announces the transition into **each of the nine union members**, iterated
      over the union so a newly added state without an announcement fails;
- [ ] a `range_recovery` failure announces the failed refresh while the accessibility tree still
      exposes the `range_not_covered` heading and phase-aware Retry control;
- [ ] every status is conveyed by text, not by color alone, asserted on the rendered text.

## Responsive and accessibility requirements

Verified manually in a browser and recorded as manual. See [Verification scope](#verification-scope).

- [ ] **320, 390, 768, and 1280 CSS px** are each usable with no horizontal page scrolling.
- [ ] The relevant flows are repeated at **200% browser zoom**, including **768 px at 200%**, with
      **effective reflow** verified rather than a changed DevTools width.
- [ ] The **long-content fixtures** below are verified at every width **and** at 200% zoom.
- [ ] Keyboard, focus, semantics, and accessible names are verified.

### Long-content fixtures for manual verification

Substituted through the browser Elements panel **after a real successful render** — never committed
into the product, and never used to fabricate a rendered state that the API did not produce. Exact
strings, so two reviewers check the same thing:

| Field | Value |
| --- | --- |
| Provider name | `Kommunaler Servicebetrieb für Abfallwirtschaft und Stadtreinigung Koblenz` |
| Service-area name | `Stadtmitte-Nord, Rauental und Oberwerth-Süd (Sammelbezirk 12)` |
| Attribution | `Kommunaler Servicebetrieb für Abfallwirtschaft und Stadtreinigung, Koblenz am Rhein` |
| Source-link label | `Offizielle Entsorgungstermine des Kommunalen Servicebetriebs Koblenz` |
| Freshness/status line | `Zuletzt am 02.08.2026 um 14:35 Uhr abgerufen — aktuell und vollständig` |
| Unbroken token | `Abfallentsorgungsterminkalenderveröffentlichungsverzeichnis` |

The last row is the one that breaks layouts: a long **unbroken** externally supplied compound word
cannot be wrapped at a space, so a container without a wrapping strategy is forced wider and the whole
page scrolls horizontally. It is externally supplied, so no amount of copy discipline prevents it.

**Automated jsdom tests may assert that these complete strings render and are not programmatically
truncated** — that is a DOM fact. **They do not verify layout**, and no such test may claim to: jsdom
performs no layout, so wrapping, overflow, clipping, and reflow are the manual checks above.

## Verification

Automated:

```bash
pnpm --filter @abfall-radar/web test
pnpm --filter @abfall-radar/web typecheck
pnpm --filter @abfall-radar/web build

# Emitted-artifact verification. Must go through Turbo: `pnpm --filter` would
# bypass turbo.json and inspect whatever `dist` is already on disk.
pnpm exec turbo run test:build-output --filter=@abfall-radar/web

# Outer meta-verifier: proves Turbo's behaviour around that task. A root shell
# command, never a Turbo task, never invoked from inside one.
pnpm verify:web-build-output-task

pnpm check
```

### Mandatory manual scenarios

Reachable against the current live catalogue, with `pnpm dev:api` running and the web application
served by `pnpm dev:web`. **Each must be performed and recorded.** A scenario whose documented
prerequisites hold is **mandatory and blocks acceptance on failure**; a scenario whose prerequisites
are **absent** is recorded `not applicable` with the concrete reason and the observed evidence, and
its absence does **not** block acceptance — per `AGENTS.md`'s requirement to validate every acceptance
criterion, a criterion that cannot be exercised is recorded honestly rather than reported as passed.
**Never record `pass` for a scenario that was not exercised.**

- [ ] On first load, confirm the needs-selection state, that no schedule request is issued before
      confirmation, and that the demo provider is not offered.
- [ ] Select the official provider and the verified area — `koblenz-servicebetrieb` /
      `koblenz-stadtmitte` — and confirm the official dates for the current range, the source
      attribution text, the source link, the retrieval time, the freshness label, the complete
      declared coverage, and the effective display range.
- [ ] **Relative-day labels follow the source's calendar day, not the device's — conditional.**
      Applicability is decided from the **actual verification instant**, the **validated capability
      `timeZone`**, and the **accepted events**, never from a date fixed in this document and never
      from an assumption that the catalogue is unchanged. Both prerequisites must hold:

      1. **An accepted event exercises a real relative branch.** `relativeDayLabel` returns `Heute`,
         `Morgen`, or `In N Tagen` only for an event within the documented relative window of
         `sourceToday`; anything further out renders the **absolute German fallback**, which reads
         identically whether the day was derived from the source zone or the device zone and therefore
         proves nothing. An **empty** result set proves nothing either.
      2. **The device zone and the instant make source-local and device-local disagree.** Choose a
         device time zone and a time of day such that, *at the moment of verification*, the
         device-local calendar date differs from the capability zone's — and such that the difference
         would change the expected label (for example `Heute` where a device-derived day would read
         `Morgen`, or the reverse). If both zones hold the same date at that instant, a correct and an
         incorrect implementation print the same string and the check distinguishes nothing.

      When both hold, this check is **mandatory and its failure blocks acceptance**: confirm the
      requested range and every day label match the source's local dates. When either is absent,
      record **not applicable** with the concrete reason plus the **observed verification instant,
      device time zone, capability time zone, derived source-local date, and the accepted events with
      their dates and rendered labels**. Do **not** record a pass, and do **not** substitute an empty
      result set or an unchanged absolute label as evidence that relative labels work.

      **Absence of a suitable live event does not block acceptance**, provided the deterministic
      [source-local calendar day tests](#source-local-calendar-day-tests) pass at implementation
      acceptance and every other applicable requirement is satisfied. Those tests remain
      **mandatory** and already carry both halves this live check cannot guarantee: the
      **source-local versus device-local** date difference — the three-date fixture, the two
      east/west boundary instants, and the same-source-day event labelled with the device zone one day
      ahead — and the **relative/absolute boundary**, where one day later is `Morgen`, two to six days
      later are `In N Tagen`, and seven or more days later fall back to the absolute label formatted
      identically in every device zone. No live observation substitutes for them.
- [ ] Reload the page and confirm it returns to needs-selection, which is the recorded trade-off rather
      than a defect.

#### Reachable failure and retry flows

Two upstream-failure modes exist and carry **different failure kinds**. Both are mandatory, and each
must be reached in a non-recovery selection phase as described, where it produces the top-level error
surface. The same failure during range recovery is nested under `range_not_covered`; phase changes
containment and Retry, while failure kind still controls copy and `requestId`. See
[ADR 0005](../decisions/0005-responsive-web-schedule.md#stopping-the-api-is-an-invalid-response-not-a-network-failure).

- [ ] **A. Proxy upstream failure — expect `invalid_response`.** With the application loaded through
      the Vite dev server, stop `apps/api`, then trigger a provider-catalogue
      `selection_providers` attempt. The dev server is still up, so `fetch` **succeeds** and the proxy
      answers with a `text/plain` error of its own —
      `502 Bad Gateway` on the pinned Vite 8.1.5. Confirm the dedicated **invalid-response** state
      appears — not the network state, and not an empty schedule — and that **no `requestId` and no
      placeholder identifier** is shown. **Record the status actually observed** rather than assuming
      it; the classification, not the number, is what this scenario verifies.
- [ ] **B. True browser network failure — expect `network`.** Load the application while the API is
      available, far enough that the page and its assets are already in the browser. **Before** the
      next API request, either enable DevTools Network "Offline" or block the same-origin `/api`
      request, so `fetch` itself rejects. Trigger a `selection_providers` or `selection_areas` request
      through its real UI action and confirm the dedicated **network** state appears with **no**
      `requestId` and the Retry behavior matches that assigned phase.

      **Do not reload the page while DevTools is offline.** The Vite application assets are served
      over the same connection, so a reload fails to load the application at all and demonstrates
      nothing about its failure handling.
- [ ] Confirm **`Erneut versuchen`** for a failed `selection_providers` catalogue read follows
      [the canonical phase table](../decisions/0005-responsive-web-schedule.md#erneut-versuchen-is-phase-aware-not-operation-routed):
      it re-reads only the catalogue, and recovery works once the API is available again.
- [ ] Confirm **`Auswahl ändern`** is present on the live schedule surface, hides the schedule, and
      returns to the service-area step with the confirmed area shown as the draft.
- [ ] Confirm **`Zurück`** from the service-area step returns to the provider step without refetching
      the catalogue and without loading a schedule.
- [ ] **The local, capability-derived `range_not_covered` path is conditional but genuinely
      reachable.** It requires source-local today to fall beyond the **selected capability's** declared
      validity, or the documented clamp to yield no intersection. Read that window from the live
      capability rather than assuming it — **if it still ends on `2026-12-31`**, a source-local date
      after that endpoint makes this path reachable, and nothing promises live data will keep that
      endpoint. When reachable, confirm the schedule and its `Heute` labels are cleared, the state
      renders, `Erneut versuchen` triggers an immediate complete recovery cycle from fresh providers,
      and no schedule appears until a matching response is published. Otherwise record **not currently
      reproducible with the selected live capability**, naming that capability's effective window, and
      rely on [the deterministic tests](#range-recovery-coordinator-tests). Never record it verified
      without evidence.
- [ ] **The terminal-422 path is not part of this live check.** It needs the declared window to change
      between the capability and events reads, which ordinary live manual use cannot arrange; record
      it as such and rely on
      [Schedule/capability reconciliation tests](#schedulecapability-reconciliation-tests). Its
      precondition is **budget exhaustion**, reached by an earlier exact `422` **or** a metadata
      mismatch — two `422` responses are never required. Do **not** add a debug UI, a production clock
      override, a fixture server, or system-clock manipulation to make it reachable.
- [ ] Reconfirm the same area and confirm a **new** schedule request is issued rather than the
      previous result reappearing instantly.

      Provider and area *switching* stays conditional — the live catalogue offers one of each — but
      `Zurück`, `Auswahl ändern`, and reconfirmation are all reachable with a single provider and are
      therefore **mandatory**.

#### Responsive, accessibility, and output checks

Also mandatory, and also reachable today.

- [ ] **Layout — exact widths.** Verify each, with no horizontal page scrolling at any of them:

      | Width | Role |
      | --- | --- |
      | **320 CSS px** | Floor |
      | **390 CSS px** | Phone |
      | **768 CSS px** | Tablet |
      | **1280 CSS px** | Desktop |

- [ ] **Browser zoom at 200%.** Repeat the relevant phone, tablet, and desktop flows at 200% browser
      zoom, **explicitly including 768 px at 200%**. Verify **effective reflow** — the layout actually
      responding — rather than only changing the DevTools width, which is not the same thing.
- [ ] **Long dynamic content.** After a **real successful render**, use the browser Elements panel to
      substitute the representative long values in
      [Long-content fixtures](#long-content-fixtures-for-manual-verification), then re-check every
      width above **and** 200% zoom for: no horizontal page scrolling; no clipping or overlap; text
      wrapping; cards and controls growing vertically; attribution and source link readable; focus
      indicators visible and unobscured; keyboard order still logical; controls still operable; no
      content disappearing; and **long unbroken content unable to force the page wider**.
- [ ] **Record browser, viewport, and zoom level** for each of the above in the handoff.
- [ ] **Visible focus:** verify that focus is visibly indicated on **every operable control that
      exists in the current live flow**.
- [ ] **Keyboard focus order:** verify keyboard-only operation through provider selection,
      available-area selection, confirmation, the schedule, and the retry, back, and
      change-selection actions, plus any other reachable control.

      **No mandatory step here depends on an unavailable area** — the live catalogue exposes none.
      That behaviour is covered by [the deterministic tests](#unavailable-areas) and by the
      conditional scenario below.
- [ ] **Touch targets:** measure the primary targets and confirm at least 44 by 44 CSS pixels.
- [ ] **Reduced motion:** enable the preference and confirm no animation runs.
- [ ] **Styling pipeline:** confirm `BrandMark` and `WasteIcon` render styled, which is what proves the
      explicit `@source "../../../../packages/ui/src"` registration reached the shared primitives with
      automatic discovery off.
- [ ] Verify the live-region announcement with a screen reader.
- [ ] From a state where `apps/web/dist` is **absent**, run `pnpm verify:web-build-output-task` (or
      the complete `pnpm check`) and confirm the current build was produced or restored **before each**
      artifact scan, with no reliance on stale pre-existing output. The automated assertions in
      [Emitted-artifact verification](#emitted-artifact-verification-tests) and
      [Outer meta-verifier tests](#outer-meta-verifier-tests) are the evidence; this step confirms the
      topology held end to end.
- [ ] Confirm no `localStorage`, `IndexedDB`, or cookie entry is created by any interaction.

### Conditional live scenarios

These are **not mandatory live checks, and a false precondition does not block acceptance.** There is
nothing to perform: treating one as outstanding would make the milestone permanently unacceptable for
a reason no implementation can fix. Each is proven by the deterministic tests named below, and those
tests *are* mandatory.

Perform the live check **only** if its precondition genuinely holds at verification time; otherwise
record it as **not applicable** and state **the actual reason** in the handoff — the precondition and
what was observed instead. Never record one as passed when it was not performed, and never as failed
when it could not be reached.

- [ ] **Provider switching.** Precondition: the running API offers **two or more** non-demo providers.
      It currently offers one (`koblenz-servicebetrieb`), so this is **not applicable** — record it as
      such, naming the two-provider fixture tests in
      [Lifecycle and races](#lifecycle-and-races) as the evidence. Do not claim it was verified live.
- [ ] **Area switching and rapid supersession.** Precondition: the selected provider offers **two or
      more** available areas. It currently offers one (`koblenz-stadtmitte`), so this is **not
      applicable** — record it as such, naming the same fixture tests. Do not claim it was verified
      live.
- [ ] **Mobile drop-off rendering — date-dependent, and mandatory whenever it applies.** This is
      **not** a structurally unreachable scenario: the catalogue does publish drop-offs, so
      applicability is decided from the **actual accepted response**, not from an assumption.

      **Applicability is read from three things at the moment of verification**: the effective
      requested range after clamping, the **validated capability** the range was derived from, and
      the **accepted events** that response actually carried. The check applies when that response
      contains at least one `mobile_drop_off` event. It is **not** decided by the appointment dates
      alone, which is why the accepted data is what gets recorded.

      The verified source publishes two timed **appointments**, on `2026-03-21` and `2026-11-07`,
      which normalize into **four** events — keep the two counts apart. Those are **dated examples
      from the documented catalogue**, not a promise about live data. Worked example: a 90-day rolling
      range derived from a source-local `2026-09-14` extends past `2026-11-07`, so that appointment's
      two normalized events would fall inside it and the check would apply. **Nothing here claims that
      verification was performed** — the tester reads the real response.

      **When it applies** — mandatory: confirm that **both** normalized waste-type events of each
      in-range appointment are represented, one `hazardous` and one `small_electronics`, each with its
      own waste-type label and its own window, zone, and location, and **not** collapsed into a single
      row. Two in-range appointments mean four normalized events. Failure blocks acceptance.

      **When it does not apply** — the accepted response carries no `mobile_drop_off` event — record
      **not applicable** with the concrete reason: the effective requested range, the capability's
      validity window, and the accepted event set that was actually returned. Then rely on the
      validated-fixture test in [Mapping and ordering](#mapping-and-ordering). **Do not claim the live
      page must always show two or four drop-off events**, and do not record a pass for a check that
      was not exercised.

      **This is a separate question from the relative-label check.** An in-range drop-off supports
      drop-off rendering verification while still rendering the **absolute** date label — an event
      roughly two months out is outside the relative window entirely. Neither check's applicability
      implies the other's.
- [ ] **Unavailable-area visual, focus, and accessibility checks.** Precondition: the **live offered
      catalogue actually contains an unavailable area**. It currently contains none, and exposing the
      demo provider to manufacture one would break the very rule being verified — so this is **not
      applicable**. Record it as such, naming the deterministic component tests in
      [Unavailable areas](#unavailable-areas) as the standing evidence. **Its absence does not block
      acceptance.** If a real one does appear, check that it is listed with explanatory German copy,
      skipped by `Tab` with focus advancing to the next operable control, inert to click, Enter, and
      Space, announced as disabled, and issuing no collection-events request.

**The source-day lifecycle — including
[the final source-date gate](#5d-the-final-source-date-gate-before-publication) — is deterministic
automated verification, not a manual scenario.** No
tester waits for real midnight and none changes the operating-system clock: waiting is not a test,
and moving the machine clock shifts the device zone's relationship to the source zone in ways that
make the observation ambiguous. An incidental live-midnight observation is welcome and is **not an
acceptance blocker**; the fake-clock tests in
[Source-day lifecycle tests](#source-day-lifecycle-tests) and
[Source-date publication-gate tests](#source-date-publication-gate-tests) are the evidence. The gate
in particular needs a response held open across a controlled rollover, which no manual browser
session can arrange reliably.

The following state is **automated rather than manually verified**, and that is recorded honestly
rather than worked around:

- **The terminal HTTP 422 race, not the whole `range_not_covered` state.** The two entry paths differ
  in how reproducible they are, and collapsing them into one "unreachable" claim is wrong:

  - **Local, capability-derived entry is reachable by hand** whenever source-local today falls beyond
    the selected capability's validity, or the documented clamp yields no intersection. **If the
    selected capability still ends on `2026-12-31`**, a source-local date after that endpoint makes
    this path reachable — but live data is not promised to keep that endpoint, so the tester reads the
    **actual** capability rather than assuming it.
  - **Problem-derived entry** requires an exact range `422` **after the shared reconciliation budget
    is exhausted**. Exhaustion can come from an earlier exact `422` **or** from a metadata mismatch,
    so *mismatch → reconciliation → exact `422`* qualifies and **two 422 responses are not
    required**.

  What ordinary live manual reproduction cannot arrange is **the terminal 422 itself**: it needs the
  declared window to change between the capability and events reads, and the normal UI exposes no
  arbitrary range control and clamps every request it issues. That limitation is scoped to this race
  under these conditions — it is **not** a claim that the state, or the race in every possible
  environment, is impossible.

  **Both paths are covered by deterministic controlled tests regardless**: the local uncovered-range
  cases in [Range derivation](#range-derivation) and the terminal-422 behaviour in
  [Schedule/capability reconciliation tests](#schedulecapability-reconciliation-tests). Record the
  local path as **verified** when the actual date and capability made it reachable, and otherwise as
  **not currently reproducible with the selected live capability**, naming that capability's effective
  window. **Never record manual verification without evidence.** **Do not** mutate the real API, add a
  debug control or debug UI, add a production clock override, add a fixture server, manipulate the
  system clock, issue an out-of-contract request, or edit production data to reach it manually.

**Do not add a manual fixture mechanism, a debug control, clock control, or browser automation to
make any of the above reachable.** Each would be a product or tooling change outside this task, and
the first three would put a test affordance inside the shipped application.

## Verification feasibility audit

Every requirement in this task has an **owning layer**, a **reachable product path**, an **observable
result**, and a **feasible verification owner**. The claims below were considered and are **excluded**
because at least one of the four is missing. They are recorded so they are not reintroduced as
plausible-sounding additions.

| Excluded claim | Why it cannot hold |
| --- | --- |
| jsdom asserting scroll width, overflow, or layout | jsdom performs no layout; the assertion would read invented values. Layout is [manual](#responsive-and-accessibility-manual-browser-verification) |
| Mandatory **live** provider switching | the live catalogue offers one official provider; conditional, with fixture tests as evidence |
| Mandatory **live** unavailable-area scenario | the live catalogue exposes none, and exposing the demo provider would break the rule being verified |
| Mandatory-**unconditionally**-live mobile-drop-off scenario | the source publishes two timed appointments a year, so the rolling window may contain none. It is **date-dependent, not structurally unreachable**: mandatory whenever the accepted response carries a drop-off event, `not applicable` with recorded evidence otherwise |
| A product-generated out-of-window `422` | the UI exposes no arbitrary range control and clamps every request; reachable only through the injected boundary |
| "Stopping the API produces a `fetch` rejection" | behind the pinned Vite proxy it produces an HTTP `502 text/plain` → `invalid_response`. A real `network` failure needs DevTools offline or request blocking |
| Web code observing an upstream `VEVENT` | `apps/web` receives already-normalized transport records with one `wasteType` each; normalization is proven in `packages/data-providers` |
| A Turbo task inspecting its own parent execution | recursive and self-reported; owned by [the outer meta-verifier](#the-outer-meta-verifier) instead |
| A direct `pnpm --filter` script honouring Turbo dependencies | `pnpm --filter` never reads `turbo.json` |
| Inspecting emitted artifacts before a fresh build | the inner task depends on `@abfall-radar/web#build` and is `cache: false` |
| An emitted-origin scan rejecting prohibited literal URL occurrences | it contextually decodes and scans fresh production HTML/CSS/JS under all four exact exemption categories; the closed HTML/build-entry check and script/CSS/source-discovery checks protect fixture provenance separately |
| Changing the OS clock, or waiting for real midnight | ambiguous and untestable; the source-day lifecycle is fake-clock only |
| Claiming punctual wall-clock timer execution | browser scheduling is outside application control; freshness is bounded by the next delivered callback or lifecycle signal |

## Risks and decisions

- **The API is not deployed and there is no production topology.** The same-origin assumption is an
  assertion until a reverse proxy exists to satisfy it. Deployment is a separate later decision.
- **Layout has no automated guard.** jsdom performs no layout, and no browser runner is added, so
  responsive behavior, overflow, focus appearance, touch-target size, and reduced motion are caught at
  review time rather than in CI. The mitigation is that they stay acceptance criteria and are recorded
  as manual, never as something a test proved.
- **The live catalogue is too small to exercise selection behavior.** One provider, one area, and two
  timed **appointments** a year, normalizing into four events — mean switching and supersession are
  only ever seen in tests over fixtures the implementer wrote. **Drop-off rendering is the exception**:
  it is date-dependent rather than structurally unreachable, so it is sometimes verifiable live and
  sometimes not, and the record must say which. A fixture that drifts from what the API really returns
  would not be caught here; `apps/api`'s contract tests and the client's own validators are what keep
  the shapes honest, which is why every schedule fixture must parse through the real validator. The
  exposure grows if a second provider is added later and nobody revisits these scenarios.
- **The source-date gate narrows the stale-publication window rather than removing it.** It
  guarantees no schedule is published for a source day the application already knows has passed, but a
  rollover *after* publication belongs to the accepted-pair watchdog, whose 1-second observation is
  not hard real time. It also assumes the clock is injected on the whole acceptance path — a direct
  `Date.now()` would make the check unverifiable, and only tests, not the type system, catch that.
- **Reused entry revalidation trades one duplicate request for a predicate that must stay honest.**
  Skipping the immediate cycle is correct only while every clause of
  [the evidence predicate](#entry-revalidation-is-evidence-based) actually holds. A future change that
  loosens one clause — or that infers eligibility from a retained object — would suppress a real
  refresh and leave a stale uncovered state up until the next 15-minute deadline. The predicate is
  therefore stated as evidence and asserted directly in tests, never derived from a flow's name.
- **A "not applicable" verification record can decay into an unexamined habit.** Several scenarios are
  expected to be recorded that way, and the **relative-day-label** check joins them whenever no
  accepted event falls inside the relative window or the chosen device zone and the verification
  instant hold the same calendar date. Each record must carry its precondition — for the drop-off, the
  source dates and the effective range; for the label check, the observed instant, both time zones,
  the derived source-local date, and the accepted events with their rendered labels. Without that, a
  future reader cannot tell an unreachable scenario from a skipped one, and the deterministic
  calendar-day tests are what actually keep the rule honest.
- **Session-only selection will read as a defect** to anyone comparing the web application with the
  extension. It is a deliberate first-slice trade-off, recorded in ADR 0005 and stated in the README
  rather than hidden.
- **No offline path exists.** With the API unreachable, selection and schedule phases show an error
  where the extension can show a labelled cached schedule; range recovery retains its truthful range
  state with a nested failure but still has no cached schedule. That is the first thing a later PWA
  milestone should address.
- **The ambient-date helpers in `packages/domain` stay exported.** Nothing prevents a future
  contributor from reaching for `getUpcomingEvents` and reintroducing a device-zone day; the
  boundary guard in [step 9](#9-boundary-guards) is what makes the rule mechanical for `apps/web`.
- **The transport-to-domain mapping, the range derivation, and the calendar-day helpers now exist
  twice** in the repository. Only the shared `CollectionEventSchema` and the boundary tests keep them
  honest. ADR 0005 records the review point for the duplicated-behavior ground: **re-evaluate
  extraction when another concrete consumer exposes proven identical behavior and a stable owner** —
  never on a consumer count, and never because mobile has appeared. The
  [stable-domain-boundary ground](../architecture/repository-structure.md#the-two-permitted-grounds)
  remains separately available and needs no such trigger; ADR 0005 records why it is not satisfied by
  a field-rename adapter.
- **`location.origin` can look perfectly healthy in a context that has no usable origin.** A
  sandboxed frame reports an ordinary HTTPS location alongside a `"null"` serialized global origin,
  which is why the resolver treats the global origin as authoritative and refuses on disagreement. The
  rule is proven by unit tests over injected strings, not against a real embedder — this milestone
  adds no browser automation.
- **The midnight refresh changes the surface with no user action.** A page left open overnight clears
  its schedule and refetches on its own. That is correct — the alternative is a confidently wrong
  "Heute" — but it means the surface can go from populated to loading unprompted, which is why the
  polite live region has to announce it.
- **`range_not_covered` has an automatic recovery path in addition to explicit Retry and lifecycle
  signals.** During a coordinator poll, a person sees an unchanged surface; if recovery keeps failing,
  they see a truthful state with a nested refresh failure rather than a contradictory top-level error.
  That is correct, and it means the live-region announcement is the only visible cue during automatic
  work — so if that announcement is dropped, the surface looks inert while it is in fact working.
- **One transport operation can belong to several product phases.** `listProviders` and
  `listServiceAreas` both occur in selection, schedule reconciliation, and range recovery. Routing
  Retry by `failure.operation`, provider-id presence, or a retained confirmed pair would resume the
  wrong owner and can strand recovery. Owner-assigned `FailureContext`, per-phase tokens/controllers,
  and the phase-matrix tests are the guard.
- **Fifteen minutes is a guess at the right cadence, not a measured one.** A validity window changes
  about annually, so the interval is generous by design; nothing in the contract informs it, and a
  later milestone should feel free to change it without treating this document as a constraint.
- **Timer throttling is browser policy this milestone does not control, and it applies to visible
  tabs too.** A throttled or suspended foreground page can sit past source midnight still showing
  yesterday's schedule and a stale `Heute`. That window is real and accepted: freshness is bounded by
  the next delivered callback or recovery signal, not by midnight. What is guaranteed is that when
  the application does run, it derives the actual current date, clears what would read as current,
  and revalidates authoritatively — never assuming, never republishing from stale capability
  metadata.
- **The id-uniqueness check fails closed against real data.** If the API ever emits a duplicate id,
  the whole schedule disappears rather than rendering partially. That is the intended trade, but it
  means a server-side regression surfaces here as an unusable answer rather than a diagnosable one.
- **Timestamp comparison can regress in two directions.** Lexical comparison breaks on fractional
  seconds; `Date.parse` breaks below a millisecond. Both pass a casual whole-second fixture, so the
  `.500` and `.0001`/`.0002` tests are the only things standing between the contract and a wrong
  "next collection".
- **Tailwind is a real added dependency**, even though it is required by `packages/ui`. With
  `source(none)` every scanned path is explicit, so a wrong positive `@source` path renders shared
  primitives unstyled and a wrong or missing exclusion lets a protected candidate through. The
  post-build candidate assertions catch both directions; the manual styling-pipeline check remains a
  visual backstop, not the only guard.
- **Showing every waste type makes a busy area's list long.** Accepted for this slice: a filter needs
  preference state, which needs persistence, which is deferred.
- **A new `collectionMode` variant fails validation loudly** in this client too, which remains ADR
  0003's intended cost of a closed variant set.
- **The 90-day window is a product choice**, not a contract constraint, and the near-year-end
  experience depends on the operator publishing the next year's validity window.
- **Deriving today in the source's zone** means a traveller sees the municipality's day rather than
  their own. Correct for a collection schedule, and recorded as a trade.

## Implementation boundaries

- Implement only this task. Ask before adding a dependency beyond
  [the table](#manifest-and-dependency-changes), before changing a public contract, or before
  expanding scope.
- Do not change `apps/api`, `packages/domain`, `packages/api-client`, `packages/ui`,
  `packages/data-providers`, or `biome.json`. Do not change `apps/extension` **except** for the one
  permitted comment correction in `apps/extension/src/adapters/collection-event.ts`, described in
  [the extension comment correction](#the-one-permitted-extension-edit-a-comment-correction) — and
  record that edit explicitly in the handoff, with the before and after comment text, so a reviewer
  can confirm it is comment-only. Change `turbo.json` and the root `package.json` **only** as
  [Build and verification ordering](#build-and-verification-ordering) requires.
- Do not add Playwright, another browser runner, or screenshot tooling, and do not write an automated
  assertion about layout, viewport width, element dimensions, or horizontal overflow.
- Do not add a waste-type filter, selector, or preference state.
- Do not create a new package.
- Do not add CORS to `apps/api`.
- Do not invent or commit a production API domain, real or placeholder, and do not hard-code an
  absolute API origin anywhere under `apps/web/src/**`. The development proxy target in
  `vite.config.ts` is the one permitted absolute origin outside tests and documentation.
- Do not add a manual fixture mechanism, a debug control, clock control, or browser automation to
  make a conditional live scenario reachable, and do not record such a scenario as passed when its
  precondition did not hold.
- Do not add persistence of any kind.
- All code, comments, documentation, examples, and identifiers are English; user-visible copy is
  German, matching the existing product copy.

## Rollout

Follows [ADR 0005's rollout](../decisions/0005-responsive-web-schedule.md#rollout): activate the
workspace, then the data layer and its guards, then the calendar-day helpers, range derivation,
ordering, view-state derivation, and phase-owned `FailureContext`/Retry transition — with the inner
emitted-artifact verifier and the separate root outer meta-verifier wired before any product surface
depends on them — then the needs-selection surface with its two steps, empty and disabled states, and
the `Zurück` / `Erneut versuchen` actions, then the schedule surface with `Auswahl ändern`, then
bounded reconciliation and the two lifecycle mechanisms — the accepted-pair watchdog and the
range-recovery coordinator, which must never run concurrently — then the phase-matrix tests and
manual browser verification against a locally running API.

## Handoff workflow

1. **Claude Code implements** the approved scope, runs the checks in [Verification](#verification),
   and produces the required handoff: files and behavior changed, checks and manual scenarios
   completed, assumptions, trade-offs, residual risks, and any incomplete acceptance criterion. The
   working tree is left uncommitted so the complete change is reviewable.

   The handoff must additionally record, for the manual layout work: **the browser and version, each
   viewport width exercised, and each zoom level** — including the 200% passes — and **which
   long-content fixtures were substituted**. "Responsive verified" without those is not a record
   anyone can re-check.

   It must also record, for the navigation actions: **which of `Zurück`, `Auswahl ändern`, and
   `Erneut versuchen` were exercised live, on which surfaces, and where focus landed** — plus which
   switching scenarios were recorded **not applicable** because the live catalogue offers one provider
   and one area.

   For the **relative-day-label** check it must record whether the prerequisites held — an accepted
   event inside the relative window, and a device zone and verification instant that put source-local
   and device-local on different calendar dates — and then either the mandatory result or a
   `not applicable` entry carrying the observed instant, both zones, the derived source-local date,
   and each accepted event's date and rendered label. **A pass may not be recorded for a check that
   was not exercised**, and an unchanged absolute label or an empty result set is not evidence.

   It must record the automated phase-matrix result: identical `listProviders` and
   `listServiceAreas` failures produced the documented distinct selection, schedule/reconciliation,
   and range-recovery Retry call orders; **transport** diagnostics preserved the real operation while
   the local `source_date_unavailable` branch carried **none** — no operation, status, or `requestId`;
   the two selection phases admitted **no** local failure; stale contexts were cleared on phase or
   selection change; and every transient second failure remained retryable.

   For the production dependency guard it must first record the full source-shell comparison, the
   sole HTML entry edge, `publicDir: false`, the resolved root/default input and declared build command,
   and the rejection-fixture results for extra HTML/build inputs. It must then record that extraction
   was **parser-based** — naming
   `ts.createProgram` / `getSyntacticDiagnostics` and the `typescript` version resolved, that **no
   file was emitted** and no internal member was accessed — plus **which production entries were
   walked, how many
   modules the walk visited**, and that **no resolved target fell inside `apps/web/src/test/**` or any
   `*.test.*`/`*.spec.*` module** — plus any import the walk could not resolve, which fails the check
   rather than being omitted. It must separately record **how many stylesheets the walk entered and
   how many CSS dependencies it followed**, naming the `postcss` version resolved, and confirm that
   the `styles.css` import chain — Tailwind and the shared UI stylesheet — was traversed rather than
   terminated at. It must record the **content-discovery** result **separately**: that `source(none)`
   is present, the three positive registrations and eight exclusions found, the effective scanned file
   count, that no protected file was in that set, and — from the post-build stage — that both planted
   candidates were absent from generated CSS while the production web and shared-UI candidates were
   present. A record showing **zero CSS edges followed** means the walk stopped at the
   first stylesheet and the bypass is open. "The guard passed" without the entry list, visited count,
   and CSS-edge count is not a record anyone can re-check.

   It must cite the **owner approval of `postcss` 8.5.28 and `postcss-value-parser` 4.2.0** recorded
   in [Dependency approval record](#dependency-approval-record) — who approved, when, and that the
   approval covered both packages at both versions — and confirm `pnpm-workspace.yaml` gained exactly
   those two entries with no other version changed, and that both are `apps/web` devDependencies only.
   If implementation needed a different version or scope, the handoff reports the task as
   **Blocked** and the CSS traversal as unimplemented; it never presents that as done.

   For the document foundation it must confirm the emitted `index.html` carries `lang="de"` and
   **exactly one** `<meta name="viewport" content="width=device-width, initial-scale=1">` with no
   zoom-disabling directive, and state plainly that this is a **declaration** check — the 320 px and
   44 px evidence comes from the recorded manual browser passes, not from it.

   For the emitted-artifact scan it must record the TypeScript, jsdom, and CSS parser versions,
   contextual-decoding fixture results, and whether any syntax/decoding failure remained. It must
   report **every raw or contextually decoded absolute HTTP(S) URL occurrence detected in
   the first fresh `apps/web` production build**, each classified against
   [the four sanctioned categories](#the-four-sanctioned-categories) or as **an unresolved
   occurrence**. The [`json-schema.org` dialect identifiers](#dependency-baseline-inventory) are
   expected to appear and must be added as exact namespace literals with recorded justification, or
   shown to be absent from this build. An unresolved occurrence is resolved by an explicit recorded
   decision — never by widening an existing exemption.

   For range-recovery entry it must record, per entry-producing flow exercised, **whether qualifying
   evidence was present and whether the immediate cycle was reused or run**, with the observation
   window used for the call-count assertions. A reuse reported without its window is not a record
   anyone can re-check.

   For the source-date gate it must record that **every** publication path — initial, reconciled
   retry, and recovery cycle — re-reads the injected clock and compares against **that request's own**
   snapshot, and that the
   [publication-gate tests](#source-date-publication-gate-tests) pass, naming the identical-clamped-
   bounds case explicitly. If no asynchronous response-processing stage exists, say so rather than
   reporting that case as covered.

   It must also record that **derivation failure is handled at all five checkpoints** per
   [step 3c](#3c-source-date-derivation-failure-at-every-checkpoint) as `source_date_unavailable` —
   with no fabricated operation, status, or `requestId` — and state the **observed events-request
   count per checkpoint**, distinguishing a preflight failure (the dependent request never issued)
   from a publication-gate failure (its request already completed). A report that states "no events
   request" without naming the checkpoint is not an acceptable record.

   And for the lifecycle mechanisms: confirmation that **at most one** of the accepted-pair watchdog
   and the range-recovery coordinator was ever active for a confirmed selection, and — if
   `range_not_covered` was reached live — whether recovery was observed. Record the **two entry paths
   separately**. The **local, capability-derived** path is reachable whenever source-local today lies
   beyond the selected capability's validity: record it **verified** with the actual capability window
   and date if so, and otherwise **not currently reproducible with the selected live capability**,
   naming that window — which was `2026-01-01` to `2026-12-31` when this task was written and is read
   from the live capability, not assumed. The **terminal-422** path is not reproducible by ordinary
   live manual use, and that is recorded as such rather than as a property of the whole state. Neither
   record may claim manual verification without evidence.
2. **Codex reviews the complete uncommitted working tree** with `codex review --uncommitted`,
   validating every acceptance criterion rather than the happy path.
3. **Claude Code resolves findings**: fixes confirmed defects, rejects incorrect findings with
   concrete evidence, avoids unrelated refactors, and re-runs the affected checks.
4. **Codex performs the final review** and returns `APPROVE` or `CHANGES_REQUESTED`.
5. **The repository owner commits only after the review is clean**, then pushes the branch and opens a
   PR from `.github/pull_request_template.md` linking this task and ADR 0005.

**Implementation is blocked until this task and
[ADR 0005](../decisions/0005-responsive-web-schedule.md) are reviewed, committed, and pushed**, because
Codex discovers task context from the repository rather than from a prompt.
