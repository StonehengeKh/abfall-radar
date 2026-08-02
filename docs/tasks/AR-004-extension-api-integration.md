# AR-004: Connect the Chrome extension to the shared HTTP API

- Status: Ready
- Owner: Claude Code

## Goal

Make the browser extension show official municipal collection dates, retrieved through the
documented AbfallRadar HTTP API, behind a network boundary owned by the Manifest V3 background
service worker. Every schedule the extension displays states where it came from, when it was
retrieved, and whether it is current, cached, or unavailable — and the extension stops reading demo
data entirely.

## User outcome

A person opens the popup and sees the dates the responsible municipal operator published for the
collection area they chose, with the mobile drop-off window and location where the source states
one. On open, a previously retrieved schedule appears immediately and is explicitly labelled with
its retrieval time until a current response replaces it. With the API unreachable, that cached
schedule stays visible and is labelled offline rather than vanishing or being presented as current.
With nothing trustworthy available, they see an explicit, plainly worded state rather than a
plausible-looking guess. An existing user whose stored settings named the verified Stadtmitte
district keeps that area; anyone else is asked to choose one instead of being moved somewhere nobody
verified. No demo schedule and no demo reminder is ever shown again.

## Context

- [ADR 0004: Extension API integration](../decisions/0004-extension-api-integration.md) — the
  approved architecture this task implements. Do not restate it; link it.
- [ADR 0002: Shared documented HTTP API](../decisions/0002-shared-http-api.md) — the contract,
  error, and dependency-boundary rules that stay in force, including OpenAPI as the canonical
  contract.
- [ADR 0003: Official schedule ingestion](../decisions/0003-official-schedule-ingestion.md) — the
  provenance, freshness, coverage, and closed-variant semantics the client must preserve.
- [Repository architecture](../architecture/repository-structure.md)
- [Shared engineering rules](../ai/shared-rules.md)
- [Design system](../design/design-system.md)
- [Agent workflow](../ai/workflow.md)
- [AR-002: Documented API foundation](AR-002-api-foundation.md) and
  [AR-003: Official ICS provider](AR-003-official-ics-provider.md) — the contract this task
  consumes, including the source verification record that justifies the single migration mapping
  entry.

Existing code this task builds on rather than duplicating:

| Location | Reuse |
| --- | --- |
| `packages/data-providers/src/browser-boundary.test.ts` | The import-graph walk to copy for the api-client boundary guard and the popup-boundary guard |
| `packages/data-providers/vitest.config.ts` | The `pool: 'forks'`, `isolate: true` pattern that makes `process.env.TZ` pinning safe per test file |
| `packages/domain/src/waste.ts` | `CollectionEventSchema`, `WasteTypeSchema`, `wasteLabels`, `wasteDescriptions` |
| `packages/domain/src/schedule.ts` | `getUpcomingEvents`, `findReminderEvent`, `getRelativeDateLabel` — unchanged |
| `apps/api/src/routes/v1/providers.schemas.ts` | `ServiceAreaSchema`, `ProviderSchema`, the transport identifier constraints |
| `apps/api/src/routes/v1/collection-events.schemas.ts` | `ScheduleRangeSchema` and the event variant schemas as the shape the client mirrors |
| `apps/api/src/providers/provider-catalogue.ts` | `toServiceArea`, `listServiceAreas`, `findProviderEntry` |
| `apps/api/src/http/openapi.ts` | `DISCRIMINATORS` and `applyOneOfDiscriminators` for publishing the new capability union |
| `apps/api/src/test/build-test-app.ts`, `log-collector.ts` | Injection-based app construction and structured-log assertions |
| `apps/api/scripts/build.ts` | The typed-script-run-with-`tsx` pattern for the contract generation script |
| `packages/domain/package.json`, `tsconfig.json` | The manifest and TypeScript configuration shape to mirror in `packages/api-client` |
| `apps/extension/entrypoints/popup/style.css` | The existing popup shell and 320 px floor to preserve |
| `apps/extension/src/features/*` | The existing responsive views and their tests to extend, not replace |

## Approved implementation clarifications

Approved by the repository owner during implementation planning, before any application code was
written. Both resolve a question this task left implicit; neither changes an approved decision in
[ADR 0004](../decisions/0004-extension-api-integration.md).

### The local cache-restore message kind

ADR 0004's data flow gives the background worker sole ownership of the schedule cache, so the popup
must not read the raw storage item. Restoring a cached schedule therefore has to cross the message
boundary, and it must do so without waiting for the network — otherwise the offline case, which is
the case the cache exists for, could not render.

The request union in [Worker gateway](#6-worker-gateway) is therefore the three API reads **plus one
local-only kind**:

```ts
{ kind: 'restore_cached_schedule'; providerId: string; serviceAreaId: string }
```

It deliberately accepts no `from` or `to`: the requested window is derived from the entry's own
capability snapshot, so a caller cannot ask for a range the cache was never evaluated against. On
this kind the worker must:

- perform no network request;
- locate and validate the entry by normalized API origin, `providerId`, and `serviceAreaId`;
- evict the entry and answer `data: null` when it is missing, invalid, past its 7-day retention, or
  belongs to another origin;
- take the cached response's already-validated `meta.source.timeZone`, `meta.validFrom`, and
  `meta.validTo`, together with an injected clock, to derive source-local today and the current
  90-day target range;
- intersect that target range with the entry's recorded served range;
- answer either `data: null` or the already-bounded restored state carrying the validated events, the
  response metadata, `storedAt`, `coverage`, and `displayRange`;
- never return an event outside `displayRange`.

The live provider, service-area, and collection-events refresh remains a separate path, and this kind
performs no request, so it cannot produce a network failure. The failure union stays exactly as ADR
0004's table specifies.

### The local cache-invalidation message kind

ADR 0004 requires that when a successful capability refresh reports the stored area `unavailable`, the
cache entry is **evicted or invalidated** — a provider that has withdrawn a calendar must not keep
answering through a cache, because that is precisely the case where old data reads as current official
data. The same ADR gives the background worker sole ownership of that cache, so the popup cannot evict the
entry itself.

The request union therefore carries a **second local-only kind**, which also performs no `fetch`:

```ts
{ kind: 'invalidate_cached_schedule'; providerId: string; serviceAreaId: string }
```

Like the restore, it takes no `from` or `to`: there is nothing to evaluate, only an entry to drop. On this
kind the worker must:

- perform no network request;
- remove the cache entry for the normalized API origin, `providerId`, and `serviceAreaId`;
- leave every other entry untouched, including another area of the same provider;
- answer `{ ok: true, data: null }` whether or not an entry existed, because "nothing is cached for this
  area" is the outcome either way;
- treat a storage failure as best-effort, exactly as a cache write is, so it never becomes an error state.

The popup sends this the moment a capability response reports the selected area missing or unavailable,
**before** it clears its own state, and it must additionally supersede that attempt's in-flight cache
restore so a late reply cannot repaint the withdrawn schedule. Superseding by attempt identifier alone is
not enough: the restore belongs to the *same* attempt.

This keeps cache ownership in the worker and adds no dependency and no change to the public HTTP API. It
is the smallest internal solution consistent with ADR 0004. The alternative — letting the popup import the
schedule-cache module — would put the range-intersection policy in two places and let a UI surface present
a schedule the worker had already decided was unusable; a test asserts that no popup-owned module imports
that storage module at all.

### `WXT_RELEASE` is set by the packaging entry points

`zip` and `zip:firefox` are controlled release and packaging commands rather than development or
verification commands, so they set `WXT_RELEASE=1` themselves. Packaging can then never silently ship
a development origin because an operator forgot the variable.

- `pnpm --filter @abfall-radar/extension zip` without `WXT_API_BASE_URL` fails, and `zip:firefox`
  follows the same rule.
- `WXT_API_BASE_URL` stays externally supplied and is never hardcoded.
- `dev`, `build`, `test`, `typecheck`, and `pnpm check` never set `WXT_RELEASE`.
- A separately invoked release build may set `WXT_RELEASE=1` explicitly from the release workflow.

An inline `WXT_RELEASE=1 wxt zip` in a package script would be POSIX-shell-only, and `cross-env` is a
dependency this task does not permit. The scripts therefore run a small `apps/extension/scripts`
entry point that sets the variable and then calls `wxt`'s programmatic API, which Node 24 executes
directly with no added dependency. The exact release and verification commands are documented in
`apps/extension/README.md`.

### One dependency beyond the table: `@types/node` in `packages/api-client`

The import-graph guard reads source files to walk them, so it needs types for `node:fs`, `node:path`,
and `node:url`. `packages/api-client` declares no `@types/node`, and
[the dependency table](#manifest-and-dependency-changes) does not list one.

`@types/node` is therefore added to `packages/api-client` as a **`catalog:` devDependency**, reusing the
repository's existing pinned version. No new version is introduced. Conditions:

- it is **test and tooling only** and must never become a runtime dependency;
- `node:fs`, `node:path`, and `node:url` may be imported **only** by the import-graph test and tooling,
  never from the package's production entry graph;
- the guard **stays in `packages/api-client`**, which is where the browser-safety invariant is owned;
- the guard must still assert the **complete** set of bare specifiers reachable from the production
  entry point, which is what proves no Node built-in, no server framework, and no other workspace
  package enters that graph.

The alternatives were rejected: hand-declaring Vite's `import.meta.glob` would redeclare a bundler API
in userland, and moving the guard into `apps/api` would put a package's own boundary invariant outside
the package and reach into it by relative path.

## Scope

Implement in this order.

### 1. Additive API contract change: the collection-events capability

`ServiceAreaSchema` gains one member stating whether the provider publishes an official calendar for
that area, as a discriminated union rather than nullable fields:

```ts
collectionEvents:
  | { availability: 'available'; timeZone: string; validity: { from: string; to: string } }
  | { availability: 'unavailable' }
```

- `available` carries the source manifest's `timeZone`, `validFrom`, and `validTo`, resolved through
  the official provider's `findManifest`.
- `unavailable` carries nothing else. Every demo area reports `unavailable`, with no invented zone
  and no invented window.
- Register both branches as component schemas and add the union to `DISCRIMINATORS` in
  `apps/api/src/http/openapi.ts`, so the contract publishes a `oneOf` discriminated on
  `availability` rather than an undiscriminated `anyOf`. The existing mechanism refuses an
  incomplete mapping, so a missing branch surfaces as a failing contract test.
- Give each branch its own OpenAPI example and update the `ServiceAreaListResponseSchema` examples,
  the route description, and `apps/api/README.md`.
- Response schemas already strip undocumented fields; keep it that way, and assert that an
  `unavailable` area serializes no other member.

This is an additive change to an existing resource. `GET /api/v1/providers` and the
collection-events resource are otherwise untouched, and no ingestion semantics change.

### 2. Contract generation pipeline

Add `apps/api/scripts/generate-contract.ts`, run with the already approved `tsx`:

- build the application in process with documentation enabled, `await app.ready()`, and read
  `app.swagger()`;
- write `apps/api/openapi.json` as 2-space-indented JSON with a trailing newline;
- run `openapi-typescript`'s programmatic API on that document and write the generated module under
  `packages/api-client/src/generated/`, with a header comment stating that the file is generated and
  must not be edited;
- never listen on a port, and never require a running development server.

Add a drift test in `apps/api` that re-runs both steps in memory and compares each result
byte-for-byte with its committed artifact, so a stale artifact fails `pnpm check` rather than
reaching a client. Exclude both generated artifacts from Biome's file set so formatting cannot fight
the generator; `tsc --noEmit` still typechecks the generated module.

Expose the generation as a script on `apps/api` and document it in `apps/api/README.md`.

### 3. Activate `@abfall-radar/api-client`

The package is a tracked stub — `package.json` and `README.md` only. Extend it; do not treat it as
new.

- `package.json` gains `exports`, the `test`, `test:watch`, and `typecheck` scripts, and the
  dependencies in [Manifest and dependency changes](#manifest-and-dependency-changes). Mirror
  `packages/domain`, which carries no vitest configuration; add one only if a test genuinely needs a
  non-default environment or pool, and say why in the handoff.
- Add `tsconfig.json` mirroring `packages/domain/tsconfig.json`.
- Hand-write Zod validators for exactly the boundary this client reads: the provider list, the
  service-area list, the collection-events response, and RFC 9457 Problem Details. Every validator
  **requires and validates all known members** and **strips unknown ones**, so an additive server
  field cannot break an installed extension.
- Assert validator output against the generated response types at compile time, so a validator that
  drifts from the generated contract is a type error.
- Add `base-url.ts`: a pure function that validates and normalizes a configured base URL. It rejects
  a value carrying credentials, a path, a query, or a fragment, and reports whether the origin is
  loopback and whether it is HTTPS. It performs no environment access, so both the build
  configuration and the application can call it.
- Add the failure taxonomy as a **strict discriminated union**, so a failure that never reached the
  server cannot be typed as though it might carry a request identifier, and a failure raised before
  the request was understood cannot be typed as though it knew which operation it was:

  | Kind | Members — exactly these, no others |
  | --- | --- |
  | `problem` | `kind`, `operation`, `status`, `code`, `requestId` |
  | `network` | `kind`, `operation` |
  | `timeout` | `kind`, `operation`, `timeoutMs` |
  | `cancelled` | `kind`, `operation` |
  | `invalid_response` | `kind`, `operation`, `status` |

  A `requestId` member exists **only** on `problem`. It comes from a validated Problem Details body
  and is never generated, defaulted, or substituted with a placeholder: an identifier that matches
  no server log is worse than none. A Problem Details body is validated in full and then projected
  at the parse site onto exactly the `problem` members above; `detail`, `instance`, `errors`, and
  every server-supplied message string are discarded there and never returned to a caller.

  The `timeout` variant has exactly one shape, used verbatim in the client result, the worker
  envelope, the logging rules, and every example and test:

  ```ts
  { kind: 'timeout'; operation: Operation; timeoutMs: number }
  ```

  `timeoutMs` is **the configured deadline in milliseconds** — a positive integer, `8000` by default
  — and never a measured elapsed duration. Validate it: a missing, non-integer, zero, or negative
  value is rejected rather than defaulted. Use the member name `timeoutMs` everywhere and introduce
  no synonym: not `deadlineMs`, not `elapsed`, not `elapsedMs`.

  `unsupported_message` is a worker-boundary failure rather than a client one, so it is defined with
  the message contract in step 6. It carries `kind` and nothing else. This union and that one must
  match ADR 0004's table exactly, member for member.
- Add `createApiClient({ baseUrl, fetch?, timeoutMs? })` exposing `listProviders`,
  `listServiceAreas`, and `listCollectionEvents`. Each accepts an optional `AbortSignal`, applies
  the `timeoutMs` deadline — default `8000` — through an internal signal-linking helper, and reports
  a timeout distinctly from a caller cancellation. A timeout failure carries back the configured
  `timeoutMs` unchanged.
- Add the import-graph guard, modelled on `packages/data-providers/src/browser-boundary.test.ts`:
  assert the complete set of bare specifiers rather than only the absence of known-bad ones, so a
  new dependency cannot slip in unnoticed.
- Replace the placeholder `README.md` with the package's real boundary documentation.

### 4. Build-time configuration and host permissions

- Read `WXT_API_BASE_URL` through the shared validator. Unset resolves to `http://127.0.0.1:3000`,
  matching the API's default `HOST`; use the loopback literal, not `localhost`, so name resolution
  cannot reach an address the API is not bound to.
- Fail the build when the value is malformed, or when it carries credentials, a path, a query, or a
  fragment.
- Fail a release or package build — the `WXT_RELEASE` path, used only by the controlled release and
  zip workflow — unless `WXT_API_BASE_URL` is explicitly supplied and is a non-loopback HTTPS
  origin. Document `WXT_RELEASE` as belonging to that workflow alone, and never set it for
  development or for `pnpm check`.
- Derive exactly one `host_permissions` match pattern from the validated origin. Keep `permissions`
  at `alarms`, `notifications`, `storage`. Add no `<all_urls>`, `optional_host_permissions`, `tabs`,
  or `activeTab`.
- Document that a Chrome match pattern cannot restrict the grant to a port, and that runtime
  requests are nevertheless built from the exact configured base URL.
- Invent no production domain and commit none.
- The shared validator lives in `@abfall-radar/api-client` so the build configuration and the
  application code cannot disagree. Verify that the extension build tooling resolves the workspace
  TypeScript export from its configuration file and report the evidence. If it does not, move the
  validator into the extension, leave URL construction in the client, and record the reason.

### 5. Versioned settings and the migration-aware storage repository

- The persisted shape becomes versioned, with the selection as one value —
  `{ providerId, serviceAreaId }` or `null` — so a half-chosen selection is unrepresentable. Keep
  `remindersEnabled`, `reminderDaysBefore`, `reminderTime`, and `visibleWasteTypes` as they are.
  Persisted schemas stay strict.
- Add a pure migration function. The **only** automatic mapping is the verified one:

  | Legacy `districtId` | Migrated selection |
  | --- | --- |
  | `koblenz-stadtmitte` | `{ providerId: 'koblenz-servicebetrieb', serviceAreaId: 'koblenz-stadtmitte' }` |
  | anything else | `null` |

  The single entry is a hand-recorded fact from AR-003's source verification record, expressed as a
  literal table — never derived from the two identifiers happening to match. No other provider or
  service-area identifier is invented under any circumstance.
- The migration is pure, deterministic, and idempotent, preserves unrelated settings including
  `visibleWasteTypes`, and handles an absent value, a valid legacy value, an unknown legacy
  identifier, a malformed value, a valid current value, and a version newer than this build.
- Persist the new schema version **only after** a successful migration.
- Add one migration-aware repository module that is the **only** reader and writer of the raw
  storage item. Rewire `use-settings` and the background path to it. No other module may read the
  raw item or a legacy object.
- A `null` selection blocks schedule requests **and** reminders until the user selects and confirms
  a service area. Nothing is preselected, persisted, or fetched on the user's behalf. A fresh
  install starts at `null`.
- The repository **refuses to persist a selection for an area whose capability is `unavailable`**,
  so the rule does not rest on the UI alone, and it **invalidates a stored selection** when a
  successful capability refresh reports that area `unavailable`. See
  [Unavailable service areas](#unavailable-service-areas).

### 6. Worker gateway

- Add the typed message contract: a request union covering the three reads, and a response envelope
  that is either a success carrying validated data or a **strict discriminated failure**. The
  failure union is exactly this, and it must match ADR 0004's table member for member:

  | Kind | Members — exactly these, no others |
  | --- | --- |
  | `problem` | `kind`, `operation`, `status`, `code`, `requestId` |
  | `network` | `kind`, `operation` |
  | `timeout` | `kind`, `operation`, `timeoutMs` |
  | `cancelled` | `kind`, `operation` |
  | `invalid_response` | `kind`, `operation`, `status` |
  | `unsupported_message` | `kind` **only** |

  `requestId` exists on `problem` alone. **`unsupported_message` carries no `operation`, no
  `requestId`, no rejected payload, and no echo of the refused message kind.** It is raised when the
  inbound message fails envelope validation, so no trustworthy operation exists to name:
  `operation: 'unknown'` is explicitly forbidden, because it manufactures a value that reads like a
  real operation and forces every consumer to handle a sentinel. Echoing the refused kind is also
  forbidden — that string is untrusted input, which is why the message was refused. Model the union
  so reaching for `operation` on this branch is a type error, not a convention.
- Handle messages in the background entrypoint with `sendResponse` and `return true` — the selected
  compatibility baseline for the supported Chrome versions. No path may let a rejection escape, and
  an unrecognized or malformed message answers with the `unsupported_message` failure.
- Coalesce identical concurrent requests into one upstream call.
- Log only safe structured fields: the local failure kind; the operation on every branch that has
  one; `timeoutMs` on a `timeout`; and — on a `problem` failure only — the HTTP status, `code`, and
  `requestId`. **For `unsupported_message`, log the failure kind alone.** `detail`, `instance`,
  `errors`, server messages, upstream URLs, payloads, stack traces, and the refused message kind
  must never be logged and must never cross the boundary. No log line invents a `requestId` or an
  `operation`, and none reports a measured elapsed duration in place of `timeoutMs`.
- Read and write the schedule cache described in [Caching rules](#caching-rules), including the
  range intersection and the [startup bootstrap](#startup-bootstrap).
- Rewire the reminder path: read settings through the repository and the schedule through this
  gateway. Keep the alarm name, schedule, and behavior unchanged. **A reminder may only consider
  events inside the safe intersection** of the cached served range and the range being reminded on,
  and the absence of an event outside that intersection is never read as nothing being scheduled.
  With a `null` selection, or with nothing trustworthy cached or retrievable, show no notification.
  Remove every remaining `@abfall-radar/data-providers` import from the extension.

### 7. Popup

- Add the messaging client used by UI code: send, validate the reply, and never touch
  `@abfall-radar/api-client` directly.
- Derive the current date **in the declared source zone**, using `Intl.DateTimeFormat` with
  `formatToParts` and reading the `year`, `month`, and `day` parts, with the calendar pinned to
  `gregory` and the numbering system to `latn`. Never parse a formatted string and never use the
  device zone. Compute the 90-day span as calendar arithmetic on that derived date, then clamp into
  the validity window. When the derived today is past the window's end, or the clamp inverts, issue
  no request and show the explicit no-calendar-for-this-period state.
- Take the zone and window from the **live capability when one is available and from the cached
  entry's capability snapshot when it is not**, per the [startup bootstrap](#startup-bootstrap). The
  derivation itself is one pure function over `{ timeZone, validity }` and a clock, so it does not
  know or care which source supplied them.
- Add the schedule hook. Each attempt carries a monotonically increasing identifier, and a reply
  whose identifier is not the latest is discarded, so an older provider, service-area, or date-range
  response can never overwrite a newer selection.
- Derive the view state with one pure function covering `needs_selection`, `loading`, fresh, stale,
  cached-because-offline, cached-because-refresh-failed, empty, range-not-covered, and error. A
  cached state carries `coverage: 'full' | 'partial'` and the effective `displayRange`, and a
  partial state renders the explicit partial-cache message with the date through which data is
  available.
- Show a support `requestId` **only** when the failure kind is `problem`. Every other failure state
  renders its own message with no identifier and no placeholder.
- Add the needs-selection view as its own small surface composed from the existing primitives,
  rather than a mode flag on the settings view. It lists providers, excluding `sourceKind: 'demo'`,
  and the selected provider's areas. Selection requires explicit confirmation.
- Handle an `unavailable` area to the rules in
  [Unavailable service areas](#unavailable-service-areas) — visible with an explanatory label, not
  selectable, not confirmable, not persistable, no events request, no reminder, and disabled
  semantics exposed to keyboard and assistive-technology users.
- Extend the settings view with provider and service-area selection. Changing the provider clears
  the area selection rather than carrying an identifier across providers.
- Extend the dashboard with provenance: the source name, its public attribution link, the retrieval
  time, the freshness or cached state, and the mobile drop-off window and location where present.
  Distinguish "no collection in this period" from "this source does not publish this waste type",
  using `coverage.wasteTypes` — never inferring coverage from an empty result.
- Map transport events onto the domain model through one explicit adapter that renames
  `serviceAreaId` to `districtId` and `wasteType` to `type` and validates the result through
  `CollectionEventSchema`, so `getUpcomingEvents`, `findReminderEvent`, `getRelativeDateLabel`, and
  `DashboardView`'s existing props keep working.
- Preserve the existing responsive shell, the 320 px floor, and the existing views wherever the new
  states allow. Use semantic tokens only; add no arbitrary color, spacing, or shadow.

### 8. Documentation

Update `apps/extension/README.md` (the worker boundary, configuration, the release gate,
permissions, and the states), `packages/api-client/README.md` (the boundary, the
generated-plus-validated contract, and the never-edit rule), `apps/api/README.md` (the new
capability member and the generation script), the root `README.md` milestone section, and the client
or extension rows of `docs/architecture/repository-structure.md` where the implemented boundary
reveals a gap. Link ADR 0004; do not restate it.

## Caching rules

- Key an entry by the **normalized API origin, `providerId`, and `serviceAreaId`**, and record the
  range it was served for. Development-origin data is therefore never presented under another
  configured origin.
- Cache only a response that passed transport validation. A failed refresh writes nothing.
- Overwrite an entry only when the new `retrievedAt` is not older than the stored one, so an
  upstream-stale response cannot displace a newer cached result.
- Store the server's `retrievedAt` and the client's own storage time. A restored entry always shows
  its own retrieval time, stays labelled cached or offline, and is relabelled only when a current
  API response replaces it. Never present old data as fresh.
- **Restore an entry only through the intersection of its recorded served range with the range now
  being requested.** The requested window advances every day, so a cache served for yesterday's
  window does not answer today's question:

  | Intersection | Behavior |
  | --- | --- |
  | Served range fully contains the requested range | `coverage: 'full'`. Show the cached schedule normally with the cached or offline label |
  | Ranges overlap in part | `coverage: 'partial'`. Filter events to the intersection, show the explicit partial-cache message, and state the date through which data is available |
  | Ranges do not overlap | Show no cached events. Show the offline or error state appropriate to why the refresh failed |

  The restored state is `{ coverage: 'full' | 'partial', displayRange: { from, to } }`, where
  `displayRange` is the intersection and not the requested range. Every event shown and every
  statement about what is absent is bounded by `displayRange`. **Never present a partial
  intersection as coverage of the complete requested 90-day range**: rendering an uncovered tail as
  "no collection scheduled" is a confident claim about a period the extension holds no data for.
- Reminders may use only events inside that same intersection.
- Bound only the presented view. The stored entry keeps its full contents and its own served range,
  so a later request overlapping differently still finds everything the entry holds.
- Retain for 7 days, mirroring ADR 0003's stale-if-error window. An entry past it is no longer
  usable and is **evicted**; an entry belonging to another origin is evicted the same way. A failed
  refresh preserves every still-usable entry.

### Startup bootstrap

**Never gate a validated cache entry behind a live service-area request.** Requiring one would make
the offline case — the case the cache exists for — unable to render. A cached collection-events
response already carries validated `meta.source.timeZone`, `meta.validFrom`, and `meta.validTo`,
which is the same information the capability publishes, so the entry is its own **last-known
capability snapshot**. Introduce no second persisted representation and guess no capability
metadata.

Startup runs two independent paths:

1. read the configured, normalized API origin;
2. read the migrated settings through the storage repository;
3. locate the cache entry by origin, `providerId`, and `serviceAreaId`;
4. validate the entry and its 7-day retention, evicting it if either fails;
5. take the entry's already-validated `meta.source.timeZone`, `meta.validFrom`, and `meta.validTo`
   as the capability snapshot;
6. derive source-local today and the current 90-day target range from that snapshot;
7. intersect the target range with the entry's recorded served range and apply the full, partial, or
   no-overlap rule;
8. **independently** start the live provider and service-area refresh.

Steps 1 to 7 perform no network request, and step 8 does not block them.

**A later successful capability response is authoritative:**

- `availability`, `timeZone`, and `validity` all matching the snapshot — the displayed range stands
  and the events request proceeds;
- a changed `timeZone` or `validity` — **recompute the target range and re-evaluate the displayed
  cache against it before fetching events**, because a corrected zone can move the local date and a
  moved window can turn full coverage into partial;
- the area now `unavailable` — stop presenting its cached schedule and evict or invalidate the
  entry. A withdrawn calendar must not keep answering through a cache.

Authority flows only from the live capability to the snapshot, never back.

## Unavailable service areas

These rules govern an unavailable area **of an offered, non-demo provider**. A provider whose
`sourceKind` is `demo` is filtered out at the catalogue, so none of its areas is ever requested,
listed, or rendered — that exclusion is stronger and happens earlier, and nothing here weakens it.
Do not expose a demo provider or its areas in order to exercise this UI.

An area whose `collectionEvents.availability` is `'unavailable'` exists but has no official calendar
behind it. It must therefore stay visible while being impossible to choose, because a selection
nobody can serve produces a permanently empty dashboard that reads as "no collections scheduled
here".

- **Remains visible with an explanatory label** stating that the provider publishes no official
  calendar for it. Hiding it would imply the municipality does not serve the area — a different and
  unfounded claim.
- **Cannot be selected or confirmed** through any interaction, pointer or keyboard.
- **Cannot be persisted as a new selection.** The settings repository rejects it, so the guarantee
  does not depend on the UI.
- **Causes no collection-events request and no reminder.**
- **Exposes disabled semantics to keyboard and assistive-technology users.** Appearance is not the
  mechanism: the control reports its disabled state and is not operable. A row that merely looks
  greyed while still activating on Enter fails this requirement.

**A persisted selection that becomes unavailable is invalidated.** When a successful capability
refresh reports `unavailable` for the stored area: invalidate the selection, stop presenting its
cached schedule, evict or invalidate the cache entry, issue no schedule request, fire no reminder,
and return the user to the needs-selection state.

## Non-goals

- Retrieving or parsing an ICS or any municipal source from the extension.
- Backend deployment, hosting, DNS, TLS, CORS for a real origin, or a production base URL.
- Authentication, accounts, or cross-device synchronization.
- Push notifications, background refresh scheduling, or any change to `chrome.alarms` scheduling
  behavior beyond redirecting the existing reminder's data source.
- Web or mobile application implementation.
- Maps, recycling points, addresses, or geocoding.
- Any change to official ingestion semantics, the source manifest, retrieval, caching,
  normalization, or event identity in `packages/data-providers`.
- Any change to `packages/domain`.
- Generating runtime validators from OpenAPI, or replacing the hand-written boundary validators.
- A user-editable API URL, a runtime origin override, `<all_urls>`, or optional host permissions.
- Presenting demo, cached, stale, or estimated data as current official data, and presenting a
  mobile drop-off as a curbside collection or the reverse.
- A first-run onboarding flow beyond the needs-selection state, and any localization layer.
- Inventing a provider or service-area identifier during migration.

## Manifest and dependency changes

Classified against the current manifests. `packages/api-client/package.json` today declares no
`exports`, no `scripts`, and no dependencies.

| Change | Where | Status |
| --- | --- | --- |
| `zod` runtime dependency | `packages/api-client` | Added, `catalog:` — the catalog already pins `zod` |
| `vitest` devDependency | `packages/api-client` | Added, `catalog:` |
| `typescript` devDependency | `packages/api-client` | Added, `catalog:`, required by `typecheck` |
| `exports`, `test`, `test:watch`, `typecheck` | `packages/api-client` | Added, mirroring `packages/domain` |
| `openapi-typescript` devDependency | `apps/api` | Added as `"catalog:"` |
| `openapi-typescript` catalog entry | `pnpm-workspace.yaml` | New — the exact entry `openapi-typescript: 7.13.0`. The catalog previously held `openapi-types` only |
| `@abfall-radar/api-client` (`workspace:*`) dependency | `apps/extension` | Added |
| `@abfall-radar/api-client` (`workspace:*`) devDependency | `apps/api` | Added — test-only, so the production bundle and its externals guard are unaffected |
| `@abfall-radar/data-providers` dependency | `apps/extension` | Removed once no extension module imports it, verified by the import-graph guard |
| `zod`, `@abfall-radar/domain` | `apps/extension` | Already declared; unchanged |
| `pnpm-lock.yaml` | Root | Regenerated by `pnpm install` |
| Generated-artifact exclusions | `biome.json` | Added for `apps/api/openapi.json` and the generated api-client module |

The approved version is **`openapi-typescript` 7.13.0**, pinned exactly. `pnpm-workspace.yaml`
receives the catalog entry `openapi-typescript: 7.13.0`, and `apps/api` declares the dependency as
`"catalog:"`, so the version lives in one place like every other shared version in this repository.
A different version is a dependency change and needs approval.

`openapi-typescript` emits types only, so it never enters a runtime bundle, and it is the single new
third-party dependency in this task.

**Any dependency discovered during implementation beyond this table requires stopping and asking for
approval.** That explicitly includes a different generator, a date or time-zone library, a messaging
or state-management helper, and any additional test utility. `strict-peer-dependencies` is enabled:
an unmet peer must be declared explicitly, as `openapi-types` was in AR-002, rather than by relaxing
the setting.

## Expected files

**Modified — `packages/api-client`**

- `package.json`, `README.md` — the two tracked stub files.

**New — `packages/api-client`**

- `tsconfig.json`; `src/index.ts`, `src/client.ts`, `src/base-url.ts`, `src/errors.ts`,
  `src/generated/` (generated), `src/contracts/` (validators), and their tests, including the
  import-graph guard and the compile-time compatibility assertions.

**New — `apps/api`**

- `scripts/generate-contract.ts`, `openapi.json` (generated, committed), and the artifact drift
  test.

**Modified — `apps/api`**

- `src/routes/v1/providers.schemas.ts`, `src/routes/v1/providers.ts`,
  `src/providers/provider-catalogue.ts`, `src/http/openapi.ts`, and the corresponding tests;
  `package.json`; `README.md`.

**New — `apps/extension`**

- `src/messaging/`, `src/background/`, `src/storage/schedule-cache.ts`,
  `src/storage/settings-migration.ts`, `src/storage/settings-repository.ts`,
  `src/adapters/collection-event.ts`, `src/config/api.ts`, `src/schedule/schedule-range.ts`,
  `src/hooks/use-schedule.ts`, `src/features/onboarding/`, and their tests.
- Test fixtures under `src/test/`, including the offered non-demo provider whose area list mixes an
  `available` and an `unavailable` area. Written for this repository; not derived from the demo
  provider and not wired into any product surface.

**Modified — `apps/extension`**

- `package.json`, `wxt.config.ts`, `vitest.config.ts`, `entrypoints/background.ts`,
  `entrypoints/popup/App.tsx`, `src/storage/settings.ts`, `src/hooks/use-settings.ts`, both feature
  views and their tests, `README.md`.

**Modified — root and docs**

- `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `biome.json`, `README.md`,
  `docs/architecture/repository-structure.md`.

## Acceptance criteria

### Boundaries

- [ ] No extension module imports `@abfall-radar/data-providers`, and the dependency is removed from
      `apps/extension/package.json`.
- [ ] No extension module fetches a municipal host, and no municipal host permission is requested.
- [ ] An import-graph test proves `@abfall-radar/api-client` is unreachable from the popup entry.
- [ ] An import-graph test asserts the complete set of bare specifiers reachable from
      `@abfall-radar/api-client`, and it contains no Fastify, no `node:*` built-in, no
      `@abfall-radar/data-providers`, and nothing from `apps/api`.
- [ ] `@abfall-radar/api-client` does not depend on `@abfall-radar/domain`, and the explicit
      transport-to-domain adapter lives in the extension.
- [ ] The message handler answers with `sendResponse` and `return true`, and no path lets a
      rejection escape.

### Contract and generation

- [ ] `apps/api/openapi.json` and the generated api-client module are committed, carry a
      generated-file header where the format allows it, and are excluded from Biome while still
      typechecked.
- [ ] The generation script builds the app in process and never listens on a port.
- [ ] The drift test fails when either committed artifact is stale, and passes on a clean tree.
- [ ] Validator output is asserted against the generated response types at compile time.
- [ ] Every API response validator accepts and strips an unknown property, and rejects a missing or
      wrong-typed required member.
- [ ] Message-envelope and persisted-storage schemas are strict.

### Service-area capability

- [ ] `GET /api/v1/providers/{providerId}/service-areas` returns `availability: 'available'` with
      the manifest `timeZone`, `validity.from`, and `validity.to` for the verified official area.
- [ ] Every demo area returns `availability: 'unavailable'` and serializes no zone, window, or other
      member.
- [ ] OpenAPI publishes the capability as a `oneOf` discriminated on `availability`, with an example
      per branch.
- [ ] No undocumented field is serializable on the resource.
- [ ] `GET /api/v1/providers` and the collection-events resource are otherwise unchanged, and every
      existing API test still passes.

### Configuration and permissions

- [ ] With `WXT_API_BASE_URL` unset, a development build resolves `http://127.0.0.1:3000`.
- [ ] A value carrying credentials, a path, a query, or a fragment fails the build.
- [ ] A release build fails when `WXT_API_BASE_URL` is unset, loopback, or not HTTPS.
- [ ] `WXT_RELEASE` is documented as belonging to the release and zip workflow only, and is not set
      by any development or verification command.
- [ ] The built manifest's `permissions` is exactly `alarms`, `notifications`, `storage`.
- [ ] The built manifest carries exactly one `host_permissions` entry, derived from the validated
      origin, containing no port, and no `<all_urls>`, `optional_host_permissions`, `tabs`, or
      `activeTab` appears.
- [ ] No production domain appears anywhere in the repository.

### Settings and migration

- [ ] A legacy `districtId` of `koblenz-stadtmitte` migrates to the official
      `koblenz-servicebetrieb` / `koblenz-stadtmitte` selection.
- [ ] Every other legacy `districtId`, including `koblenz-metternich-1` and `koblenz-karthause-2`,
      migrates to `selection: null`, and no provider or service-area identifier is invented.
- [ ] The migration is pure and deterministic, and running it twice yields an identical result.
- [ ] `visibleWasteTypes` and the reminder settings survive the migration unchanged when valid.
- [ ] The new schema version is persisted only after a successful migration.
- [ ] A fresh install starts at `selection: null`.
- [ ] One repository module is the only reader and writer of the raw storage item, and both the
      popup and the background path go through it.
- [ ] `selection: null` issues no schedule request and produces no notification.

### Data flow and states

- [ ] Providers whose `sourceKind` is `demo` are not offered for selection, and no service-area
      request is issued for one, so no demo area reaches the selection surface at all.
- [ ] No demo provider or demo area is exposed anywhere in order to exercise the unavailable-area
      UI.

The next five criteria concern an `unavailable` area **of an offered, non-demo provider**, and are
verified against the fixture described in the [test matrix](#test-matrix):

- [ ] An `unavailable` area is shown as publishing no official calendar rather than being hidden,
      while an `available` area in the same list stays selectable.
- [ ] An `unavailable` area cannot be selected or confirmed by pointer or by keyboard, and no
      interaction with it reaches the settings repository.
- [ ] The settings repository rejects a selection naming an `unavailable` area, independently of the
      UI.
- [ ] An `unavailable` area triggers no collection-events request and no reminder.
- [ ] An `unavailable` area reports its disabled state to assistive technology and is not operable,
      so appearance alone is never the mechanism.
- [ ] When a successful capability refresh reports the stored area `unavailable`, the persisted
      selection is invalidated, its cache stops being presented, no schedule request is issued, no
      reminder fires, and the needs-selection state is shown.
- [ ] The requested range is derived in the capability's declared zone with `formatToParts`, and is
      identical regardless of the device time zone.
- [ ] The range is clamped into the declared window, and a derived today past `validity.to` issues
      no request and shows the no-calendar-for-this-period state.
- [ ] A `422` response is handled as its own state rather than as a generic error.
- [ ] Loading, fresh, stale, cached-offline, cached-refresh-failed, cached-partial, empty,
      range-not-covered, needs-selection, and error states are each rendered distinctly.
- [ ] A partial cache renders the explicit partial-cache message stating the date through which data
      is available, and never presents the intersection as coverage of the requested 90-day range.
- [ ] An empty result inside a covered range reads as no collection in this period, and a selected
      waste type outside `coverage.wasteTypes` is labelled as not published by that source.
- [ ] A mobile drop-off shows its window, its zone, and its trimmed location; a curbside event shows
      neither a window nor a location.
- [ ] The dashboard shows the source name, its public attribution link, and the retrieval time.

### Failures, caching, and races

- [ ] No envelope and no log line contains `detail`, `instance`, `errors`, a server message, an
      upstream URL, a payload, or a stack trace.
- [ ] A projected `problem` failure carries exactly the status, `code`, `requestId`, the operation,
      and the failure kind.
- [ ] `network`, `timeout`, `cancelled`, `invalid_response`, and `unsupported_message` failures
      carry no `requestId` member at all — not an empty string, not a placeholder, not a locally
      generated value — in the client result, the worker envelope, and the log line alike.
- [ ] Startup restores a validated cache entry without issuing any request first, using the entry's
      own `meta.source.timeZone`, `meta.validFrom`, and `meta.validTo` as the capability snapshot.
- [ ] No capability metadata is guessed, and no second persisted representation of the zone or the
      validity window is introduced.
- [ ] A live capability response matching the snapshot leaves the displayed range unchanged.
- [ ] A live capability response with a changed `timeZone` or `validity` recomputes the target range
      and re-evaluates the displayed cache **before** any events request is issued.
- [ ] A live capability response reporting the area `unavailable` stops presenting its cached
      schedule and evicts or invalidates the entry.
- [ ] A support `requestId` is displayed only when a validated Problem Details response supplied
      one, and every other failure state renders no identifier.
- [ ] `unsupported_message` carries `kind` and nothing else: no `operation`, no `requestId`, no
      rejected payload, and no echo of the refused message kind, in the envelope and the log line
      alike. No branch anywhere uses `operation: 'unknown'`.
- [ ] The client failure union in `@abfall-radar/api-client`, the worker envelope union, and ADR
      0004's table agree member for member.
- [ ] An unknown problem `code` degrades to a generic message instead of failing validation.
- [ ] A malformed Problem Details body becomes an invalid-response failure.
- [ ] A `timeout` failure is exactly `{ kind, operation, timeoutMs }`, and `timeoutMs` equals the
      configured deadline rather than a measured elapsed duration, in the client result, the worker
      envelope, and the log line alike.
- [ ] A `timeoutMs` that is missing, non-integer, zero, or negative is rejected rather than
      defaulted.
- [ ] No `deadlineMs`, `elapsed`, or `elapsedMs` member exists anywhere in the changed code.
- [ ] A request exceeding the deadline reports a timeout, and a caller cancellation reports
      cancellation; a cancellation is never an error state.
- [ ] Identical concurrent requests cause exactly one upstream call.
- [ ] A reply from a superseded attempt is discarded, and rapid provider, area, and range changes
      always render the newest selection.
- [ ] Only a validated response is cached, and a failed refresh writes nothing.
- [ ] Cache entries are keyed by normalized origin, provider, and area, record their served range,
      and are never reused across origins.
- [ ] An older `retrievedAt` never overwrites a newer cached entry.
- [ ] An entry past 7 days, and an entry for another origin, are evicted rather than retained.
- [ ] A failed refresh preserves every still-usable entry.
- [ ] A restored entry stays labelled cached or offline until a current response replaces it, and is
      never labelled fresh.
- [ ] A cached entry is restored only through the intersection of its served range with the
      requested range: full containment shows normally, partial overlap filters to the intersection
      and states its end date, and no overlap shows no cached events at all.
- [ ] The restored state carries an explicit `coverage` of `full` or `partial` and an effective
      `displayRange` equal to the intersection rather than the requested range.
- [ ] A reminder considers only events inside that intersection, and an absence outside it is never
      treated as nothing being scheduled.
- [ ] Restoring bounds only the presented view; the stored entry keeps its full contents and its own
      served range.

### Responsive and accessibility

- [ ] The 320 px layout is usable with no horizontal page scrolling, and the popup and tablet widths
      are verified.
- [ ] Provenance and freshness are conveyed by text and icon, not by color alone.
- [ ] State transitions are announced through a polite live region.
- [ ] Every control has an accessible name and visible focus; focus order is preserved and returned
      across state transitions including the needs-selection surface.
- [ ] Primary touch targets are at least 44 by 44 CSS pixels.
- [ ] Only semantic tokens are used; no arbitrary color, spacing, or shadow is added.

### Checks and documentation

- [ ] `apps/extension/README.md`, `packages/api-client/README.md`, `apps/api/README.md`, the root
      `README.md`, and `docs/architecture/repository-structure.md` describe the boundary,
      configuration, permissions, states, and generated-artifact rule, and link ADR 0004.
- [ ] No test performs network access, and no municipal file or excerpt is committed.
- [ ] Every command in [Verification](#verification) passes.

## Test matrix

### `packages/api-client`

- [ ] each response validator accepts an unknown extra property and strips it from its output;
- [ ] each response validator rejects a missing required member and a wrong-typed member;
- [ ] the capability union parses both branches and rejects an unknown `availability` value;
- [ ] an `unavailable` branch carrying a zone or window is rejected;
- [ ] the collection-events response parses both event variants and rejects an unknown
      `collectionMode`;
- [ ] a Problem Details body with an unrecognized `code` parses and degrades;
- [ ] a malformed Problem Details body yields an invalid-response failure;
- [ ] a non-problem error body yields an invalid-response failure;
- [ ] a success response with the wrong content type is rejected;
- [ ] the projected `problem` failure's key set is exactly the safe subset, and `detail`,
      `instance`, and `errors` are absent;
- [ ] a `network`, `timeout`, `cancelled`, and `invalid_response` failure each carry no `requestId`
      member, asserted on the key set rather than on its value, so an empty string or a placeholder
      fails the test;
- [ ] base URL validation rejects credentials, a path, a query, a fragment, and a malformed value,
      and reports loopback and HTTPS correctly;
- [ ] request URLs are built from the exact configured base URL, including its port;
- [ ] the deadline aborts with a timeout under fake timers, and the failure's key set is exactly
      `{ kind, operation, timeoutMs }`;
- [ ] `timeoutMs` equals the configured value for both the default `8000` and an explicitly passed
      value, asserted after advancing fake timers well past the deadline so a measured elapsed
      duration fails the test;
- [ ] a `timeoutMs` that is missing, non-integer, zero, or negative is rejected at construction;
- [ ] a caller cancellation is reported as cancellation, not as a timeout;
- [ ] a thrown `fetch` is reported as a network failure;
- [ ] the import graph contains only the expected bare specifiers;
- [ ] validator output is assignable to and from the generated response types.

### `apps/extension`

- [ ] the derived current date and the 90-day window are identical with the process time zone pinned
      to zones on both sides of UTC, using the forked isolated pool pattern;
- [ ] a fixture near midnight where the device date and the source date differ resolves to the
      source date, so a device-zone derivation fails the test;
- [ ] clamping produces `from` and `to` inside the declared window at both boundaries;
- [ ] a derived today past `validity.to`, and an inverted clamp, issue no request;
- [ ] a `422` response produces the range-not-covered state;
- [ ] the worker answers a success, each reachable problem code, a network failure, a timeout, and
      an unrecognized message kind with the documented envelope;
- [ ] no envelope carries `detail`, `instance`, `errors`, a server message, an upstream URL, or a
      stack trace;
- [ ] no log line carries any of those, asserted against a captured log destination;
- [ ] a non-`problem` failure envelope and its log line carry no `requestId` member, and the error
      surface for each renders no identifier and no placeholder;
- [ ] a `problem` failure's envelope, log line, and error surface all carry the same `requestId` the
      validated body supplied;
- [ ] an unrecognized message kind, a malformed message payload, a message that is not an object,
      and a message with no kind at all each answer `unsupported_message` whose key set is exactly
      `{ kind }`, so an `operation`, a `requestId`, an echoed kind, or the rejected payload fails
      the test;
- [ ] the log line for `unsupported_message` carries the failure kind alone;
- [ ] the popup messaging client rejects a malformed reply;
- [ ] identical concurrent requests cause one upstream call;
- [ ] migration: absent value, valid legacy value with the verified identifier, legacy value with an
      unknown identifier, malformed value, valid current value, and a version newer than this build;
- [ ] migration idempotency, preserved `visibleWasteTypes` and reminder settings, and version
      written only after success;
- [ ] only the repository module reads the raw storage item, and both the popup and background paths
      go through it;
- [ ] `selection: null` blocks both a schedule request and a notification;
- [ ] the cache is keyed by origin, provider, and area, records its served range, and is not reused
      across origins;
- [ ] only a validated response is cached, and a failed refresh writes nothing;
- [ ] an older `retrievedAt` does not overwrite a newer entry;
- [ ] an entry past 7 days and an entry for another origin are evicted, while a still-usable entry
      survives a failed refresh;
- [ ] a restored entry is labelled cached or offline and never fresh, until a current response
      replaces it;
- [ ] a range advanced by exactly one day against an entry served for yesterday's window restores as
      `coverage: 'partial'` with a `displayRange` ending at the served range's end, which is the
      ordinary daily case and the one a containment-only check would silently get wrong;
- [ ] full containment restores as `coverage: 'full'` with a `displayRange` equal to the requested
      range;
- [ ] a partial overlap filters out every event outside the intersection and renders the partial
      message with the intersection's end date;
- [ ] no overlap restores no events at all and yields the offline or error state instead;
- [ ] a reminder derived from a partially covered entry considers only events inside the
      intersection, and an event-free uncovered tail produces no notification and no "nothing
      scheduled" claim;
- [ ] restoring leaves the stored entry's contents and served range untouched;
- [ ] **offline startup restores entirely from a valid cache**: with every request failing, the
      schedule renders from the entry's own capability snapshot and no service-area or events
      request is issued first;
- [ ] **partial restoration after the date advances**: the same entry, with the clock moved forward
      inside its served range, restores as `partial` with the bounded `displayRange`;
- [ ] **an expired cache**: an entry past the 7-day retention is evicted and nothing is restored,
      with no snapshot taken from it;
- [ ] **a live capability matching the snapshot**: the displayed range is unchanged and no
      recomputation occurs;
- [ ] **a changed zone or validity**: the target range is recomputed and the displayed cache
      re-evaluated before any events request, asserted on call order so a re-evaluation after the
      fetch fails the test;
- [ ] **an area becoming unavailable**: the persisted selection is invalidated, the cached schedule
      stops being presented, the entry is evicted or invalidated, no schedule request is issued, no
      reminder fires, and the needs-selection state is shown;
- [ ] the demo provider is absent from the selection surface, asserted against a catalogue fixture
      that contains one;

The remaining unavailable-area tests use a fixture of an **offered, non-demo provider** whose area
list contains at least one `available` and at least one `unavailable` area. The fixture is written
for this repository; no demo provider or demo area is exposed to the selection surface to obtain
one, and these deterministic tests are the standing evidence for this behavior because the live API
currently offers no unavailable area under a non-demo provider.

- [ ] the fixture's `unavailable` area is rendered with its explanatory copy rather than omitted
      from the list, while the `available` area in the same fixture remains selectable — so a test
      cannot pass by disabling everything;
- [ ] clicking the `unavailable` area does not select it, and `userEvent` keyboard interaction —
      `Tab` to it, then `Enter` and `Space` — does not confirm it either, so a pointer-only test
      cannot pass a keyboard-operable control;
- [ ] no interaction with the `unavailable` area reaches the settings repository, asserted against a
      spied repository whose write is never called;
- [ ] the settings repository itself rejects a selection naming an `unavailable` area, so the rule
      holds without the UI;
- [ ] the `unavailable` area triggers no collection-events request and no notification;
- [ ] the `unavailable` control exposes its disabled state to assistive technology, asserted through
      the accessibility tree rather than a class name;
- [ ] a superseded attempt's reply is discarded and the newest selection is rendered;
- [ ] changing the provider clears the area selection, and the selection persists;
- [ ] the built manifest carries exactly the expected permission set and one derived host pattern
      with no port and no `<all_urls>`;
- [ ] the popup entry's import graph does not reach `@abfall-radar/api-client`;
- [ ] every UI state renders distinctly with a non-color cue at 320 px, and the transport-to-domain
      adapter round-trips both event variants through `CollectionEventSchema`;
- [ ] the reminder path produces no notification when nothing trustworthy is available.

### `apps/api`

- [ ] the official area returns the `available` capability with the manifest zone and window;
- [ ] every demo area returns `unavailable` and no other member;
- [ ] the response serializes no undocumented field;
- [ ] OpenAPI publishes the discriminated `oneOf` with an example per branch;
- [ ] the generated OpenAPI document and the generated client module match their committed
      artifacts;
- [ ] real injected responses for all three resources parse through the api-client validators.

## Verification

Automated:

```bash
pnpm --filter @abfall-radar/api-client test
pnpm --filter @abfall-radar/api-client typecheck
pnpm --filter @abfall-radar/api test
pnpm --filter @abfall-radar/api typecheck
pnpm --filter @abfall-radar/api build
pnpm --filter @abfall-radar/extension test
pnpm --filter @abfall-radar/extension typecheck
pnpm --filter @abfall-radar/extension build
pnpm check
```

Manual scenarios, with `pnpm dev:api` running and the built extension loaded from
`apps/extension/.output/chrome-mv3`:

- On a fresh profile, confirm the needs-selection state, that no schedule request is issued before
  confirmation, and that the demo provider is not offered.
- Select the official provider and the verified area, confirm the official dates, the mobile
  drop-off window, zone, and trimmed location, the source attribution link, the retrieval time, and
  the fresh label.
- Reopen the popup and confirm the cached schedule paints immediately, labelled with its own
  retrieval time, and is replaced by the current response.
- Stop the API, reopen the popup, and confirm the cached schedule stays visible with an offline
  label and that the cached entry survives.
- Still offline, reload the extension so the worker restarts cold, and confirm the cached schedule
  renders **without any successful request having been made** — inspect the network panel to confirm
  the service-area request failed while the schedule was still shown, which is what proves the cache
  is not gated behind a live capability lookup.
- Still offline, advance the system date by one day so the requested window moves past the cached
  served range, reopen the popup, and confirm the partial-cache message names the date through which
  data is available, that no event beyond it is shown, and that the uncovered tail is not presented
  as having no collection scheduled.
- Advance the system date past the whole cached served range and confirm no cached events are shown
  at all, and that the offline state appears instead.
- Confirm that while the cache is partially covering the window, the reminder alarm produces a
  notification only for a collection inside the covered part, and none for the uncovered tail.
- Clear the cache, stop the API, and confirm the explicit network error state appears rather than an
  empty schedule, and that **no `requestId` and no placeholder identifier is shown** — the request
  never reached a server, so no identifier exists.
- Restart the API, trigger a server-side failure that does return Problem Details — request an
  out-of-window range for a `422` — and confirm that state does show a `requestId` matching the
  `x-request-id` header.
- Switch provider and area rapidly and confirm the newest selection is always rendered.
- Set the device time zone to a non-European zone and confirm the requested range still matches the
  source's local dates, both online and on an offline start restored from the snapshot.
- Send an unrecognized message to the worker from the extension console and confirm the reply is
  exactly `{ kind: 'unsupported_message' }` — no `operation`, no `requestId`, no echoed kind, and no
  copy of the message — and that the log line carries the kind alone.
- Open the selection surface and confirm the **demo provider is absent** from it, and that no
  service-area request is issued for a demo provider. Do not expose a demo provider or its areas to
  check anything else.
- **Unavailable-area behavior is verified by the deterministic interaction tests**, not by hand:
  they drive a fixture of an offered non-demo provider containing an `unavailable` area and prove it
  stays visible with explanatory copy, is inert to pointer and keyboard, exposes accessible disabled
  semantics, cannot be confirmed or persisted, and triggers neither a collection-events request nor
  a reminder. The live API currently offers no unavailable area under a non-demo provider, and
  exposing the demo provider to manufacture one would break the rule being verified.
- **Conditional live check.** Perform it *only* if the API being run does expose an unavailable area
  under an offered non-demo provider: confirm the area is listed with its explanatory copy, cannot
  be activated by click, does nothing on `Tab` then Enter and Space, is announced as disabled by a
  screen reader, and issues no collection-events request. Otherwise record this scenario as **not
  applicable**, naming the fixture tests as the evidence. Do not report it as passed when it was not
  performed.
- Inspect the service worker console and confirm no `detail`, `instance`, `errors`, upstream URL, or
  stack trace appears, and that the offline failure logged no `requestId`.
- Migrate an existing profile whose stored `districtId` is `koblenz-stadtmitte` and confirm the
  official area is selected; migrate one whose value is `koblenz-metternich-1` and confirm the
  needs-selection state with reminder settings and waste types preserved.
- Inspect the built manifest and confirm the permission set and the single derived host pattern.
- Run a release build without `WXT_API_BASE_URL` and confirm it fails; run one with a loopback or
  non-HTTPS value and confirm it fails.
- Verify 320 px, the popup width, and a tablet width, keyboard-only operation, visible focus, and
  the live-region announcement.
- Confirm the reminder alarm produces no notification while the selection is `null`.

## Risks and decisions

- **The API is not deployed.** This milestone produces a development-configured artifact by design,
  and the release gate is what keeps that from shipping.
- **Two representations of one contract.** Generated types and hand-written validators only stay
  aligned because the compatibility assertions and the drift check run in `pnpm check`. If either is
  weakened, the arrangement degrades into duplicated types nobody compares.
- **A hand-edited generated artifact is a review blocker**, not a merge conflict. The drift check is
  the detector; reviewers must know the rule.
- **A new `collectionMode` variant fails validation loudly.** That is ADR 0003's intended cost of a
  closed variant set, and it means a server-side contract change needs a coordinated client release.
- **The 90-day window is a product choice**, not a contract constraint, and the near-year-end
  experience depends on the operator publishing the next year's validity window.
- **The moving window makes the partial cache the common offline path, not an edge case.** Because
  the requested range advances daily, a restored entry is almost always partial. A containment-only
  check would therefore pass every same-day test and fail silently in real use by rendering an
  uncovered tail as "no collection scheduled". The one-day-advanced test exists specifically to
  catch that.
- **The capability snapshot is last-known, not current.** Between the first offline paint and the
  authoritative capability response, the displayed range comes from a zone and window the operator
  may since have changed. Recomputing on the live response and evicting on `unavailable` are the
  mitigations; the brief snapshot-governed window is accepted, because the alternative is showing
  nothing offline. Reusing the cached response's own validated `meta` is what keeps a second
  persisted representation from drifting away from it.
- **The startup order is easy to regress into a network dependency.** Any change that awaits the
  capability before reading the cache silently breaks offline start while every online test keeps
  passing. The offline-startup test asserts that no successful request precedes the render, and the
  changed-zone test asserts call order.
- **A failure that never reached the server has no request identifier.** Support gets less to
  correlate for an offline report than for a server-side one. Inventing a value would be worse: it
  would match no server log while looking like it should.
- **A cache bounded at 7 days can still be wrong.** A source correction inside that window is
  invisible to an offline client; labelling is the mitigation, not a fix.
- **A Chrome match pattern cannot restrict a port**, so the granted host permission is broader than
  the requests the extension makes. The exact base URL is what keeps the requests narrow.
- **Deriving today in the source's zone** means a traveller sees the municipality's day rather than
  their own. That is correct for a collection schedule and wrong-feeling for a traveller; the ADR
  records the trade.
- **Whether the extension build tooling resolves a workspace TypeScript export from its
  configuration file is unverified.** Establish it with evidence; if it does not, move the base URL
  validator into the extension and record why.
- **Extension storage is not encrypted.** Only a public schedule, a selection, and reminder
  preferences are stored; no address, position, or credential is involved.

## Implementation boundaries

- Implement only this task. Ask before adding a dependency beyond the one in
  [Manifest and dependency changes](#manifest-and-dependency-changes), before changing a public
  contract beyond the additive service-area capability, or before expanding scope.
- Do not change `packages/domain`.
- Do not change ingestion, retrieval, caching, normalization, identity, or the source manifest in
  `packages/data-providers`.
- Do not change the collection-events route contract, the problem catalogue, or the error boundary.
- Do not invent a production domain, a provider identifier, or a service-area identifier.
- Do not commit a municipal calendar file or any excerpt of one.
- All code, comments, documentation, examples, and identifiers are English; user-visible copy stays
  German, matching the existing product copy.

## Handoff workflow

1. **Claude Code implements** the approved scope, runs the checks in [Verification](#verification),
   and produces the required handoff: files and behavior changed, checks and manual scenarios
   completed, assumptions, trade-offs, residual risks, and any incomplete acceptance criterion. The
   working tree is left uncommitted so the complete change is reviewable.
2. **Codex reviews the complete uncommitted working tree** with `codex review --uncommitted`,
   validating every acceptance criterion rather than the happy path.
3. **Claude Code resolves findings**: fixes confirmed defects, rejects incorrect findings with
   concrete evidence, avoids unrelated refactors, and re-runs the affected checks.
4. **Codex performs the final review** and returns `APPROVE` or `CHANGES_REQUESTED`.
5. **The repository owner commits only after the review is clean**, then pushes the branch and opens
   a PR from `.github/pull_request_template.md` linking this task and ADR 0004.

Implementation starts only after this task and
[ADR 0004](../decisions/0004-extension-api-integration.md) are reviewed, committed, and pushed,
because Codex discovers task context from the repository rather than from a prompt.
