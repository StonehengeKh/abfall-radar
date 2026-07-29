# AR-003: Official ICS collection-schedule provider

- Status: Ready
- Owner: Claude Code

## Goal

Serve real official waste collection dates through the documented HTTP API for at least one manually
verified Koblenz collection area, by ingesting the municipal calendar file server-side behind a
bounded, allowlisted retrieval boundary. Every response states where its data came from, when it was
retrieved, which period the source covers, whether it is fresh or stale, and which waste types the
source actually declares.

## User outcome

A person who selects a verified official collection area sees the dates the responsible municipal
operator published, not generated sample data. When the municipal source is temporarily unavailable,
they can still see the last successfully retrieved schedule, explicitly labelled as stale. When
nothing trustworthy is available, they see an error rather than a plausible-looking guess. At no
point is demo, partial, estimated, or stale data presented as complete current official data.

## Context

- [ADR 0003: Official schedule ingestion](../decisions/0003-official-schedule-ingestion.md) — the
  approved architecture this task implements.
- [ADR 0002: Shared documented HTTP API](../decisions/0002-shared-http-api.md) — the contract,
  error, and dependency-boundary rules that stay in force.
- [Repository architecture](../architecture/repository-structure.md)
- [Shared engineering rules](../ai/shared-rules.md)
- [Agent workflow](../ai/workflow.md)
- [AR-002: Documented API foundation](AR-002-api-foundation.md) — the foundation this task extends.

Official sources:

- <https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/>
- <https://servicebetrieb.koblenz.de/downloads/broschueren/ksk-abfallratgeber-26-ai.pdf?cid=3mpk>

Existing code this task builds on, rather than duplicating:

| Location | Reuse |
| --- | --- |
| `packages/domain/src/waste.ts` | `WasteTypeSchema`, `CollectionEventSchema`, `DistrictSchema`. `source: 'municipal_ics'` already exists, so **the domain does not change** |
| `packages/data-providers/src/provider.ts` | The `ScheduleProvider` contract the demo provider implements |
| `packages/data-providers/src/demo-provider.ts` | The deterministic-identifier and normalization style to follow; it must keep working unchanged |
| `apps/api/src/providers/provider-catalogue.ts` | `ProviderCatalogueEntry`, `findProviderEntry`, `toServiceArea` |
| `apps/api/src/routes/v1/providers.schemas.ts` | `ProviderSourceKindSchema`, `ServiceAreaSchema`, `PROVIDER_ID_PATTERN`, `PROVIDER_ID_MAX_LENGTH` |
| `apps/api/src/http/problem-details.ts` | `problemCatalogue`, `ApiProblem`, `ProblemDetailsSchema`, `buildProblem` |
| `apps/api/src/http/error-handler.ts` | The single centralized error boundary. Do not add a second error path |
| `apps/api/src/http/openapi.ts` | Generated-contract passes; OpenAPI stays generated from route schemas |
| `apps/api/src/test/build-test-app.ts`, `apps/api/src/test/log-collector.ts` | Injection-based app construction and structured-log assertions |
| `packages/domain/package.json` | The `vitest` script and dependency shape to mirror in `data-providers` |

## Scope

Implement in this order. Step 1 produces the facts every later step depends on.

### 1. Manual source verification

Manually retrieve and inspect the real official calendar for at least one Koblenz collection area,
and record in the source manifest:

- the exact HTTPS calendar URL and its host;
- the official area name, and the service-area identifier derived from that official naming;
- the response content types actually observed;
- the validity window the file covers;
- the waste types actually present in the file.

Do not guess a URL pattern and do not commit the downloaded file. If the observed facts contradict
anything in this task's examples, the observed facts win and the examples are corrected.

### 2. Source metadata types

Add `packages/data-providers/src/source.ts` with the manifest, provenance, freshness, and snapshot
types, exported from the package root so `apps/api` can type its responses without importing
Node-only code. `packages/domain` is not modified.

### 3. Node-only retrieval and cache

Add a Node-only area, `packages/data-providers/src/node/`, reached through a new `"./node"` entry in
the package `exports` map and **never** re-exported from `src/index.ts`:

- an injectable fetch boundary typed against the Node 24 built-in `fetch`;
- bounded retrieval: 5-second timeout, 1 MiB response-body limit, manual redirect handling that
  refuses any hop leaving the host allowlist, and rejection of a content type outside the recorded
  allowlist;
- a process-local per-source cache: 6-hour fresh TTL, 7-day stale-if-error maximum, coalesced
  concurrent refreshes, preserved last-success timestamp, `freshness: "fresh" | "stale"`, and no
  manufactured stale value when no successful retrieval exists;
- an injectable clock so TTL and staleness are tested without waiting.

Add `node-ical@0.27.1` to `packages/data-providers` dependencies and to the root pnpm catalog. Use
only its string-parsing API; do not use any helper that fetches a URL.

### 4. Koblenz adapter

Add the `koblenz-servicebetrieb` adapter beside its manifest, containing all Koblenz-specific names,
URLs, and mappings:

- an adapter-local summary-to-`WasteType` mapping table;
- combined entries normalizing into two events where the source announces two collections;
- all-day `VALUE=DATE` handling that preserves the calendar date with no UTC or local-time shift;
- deterministic identifiers derived from provider, service area, waste type, and date, stable across
  refreshes and processes; the upstream `UID` is not the public identifier;
- collapsing of duplicate identical normalized events;
- runtime validation of every event through `CollectionEventSchema`;
- a failed refresh — not a partial schedule — when an entry is malformed, unmapped, or invalid.

### 5. API wiring

- Extend `ProviderSourceKindSchema` with `official_ics` and register the official provider in the
  catalogue with its verified service areas.
- Add the collection-events route with its request and response schemas, range filtering, and
  transport mapping (`districtId` → `serviceAreaId`, `type` → `wasteType`).
- Reject an unknown service area for a known provider with `SERVICE_AREA_NOT_FOUND`.
- Keep the demo provider listed and unchanged, and keep its demo labelling intact.

### 6. Error contract and documentation

- Extend `problemCatalogue` and `ProblemCode` with the codes in the error contract below, each with
  a fixed diagnostic `detail` that interpolates no request input and no upstream payload.
- Document success, fresh, stale, validation, both not-found cases, range, invalid-upstream, and
  unavailable-upstream responses in the generated OpenAPI contract with realistic examples.

### 7. Tests

Add a `vitest` configuration, `test`, and `test:watch` scripts to `packages/data-providers`,
mirroring `packages/domain`. Cover everything in [Test requirements](#test-requirements).

### 8. Documentation updates

Update `apps/api/README.md` (new route, new provider, new error codes, request correlation),
`packages/data-providers/README.md` (the `./node` boundary and why it exists), and the provider
section of `docs/architecture/repository-structure.md` if the implemented boundary reveals a gap. Do
not restate the ADR; link it.

## Non-goals

- Migrating the browser extension to the API or to `@abfall-radar/api-client`.
- Generating `@abfall-radar/api-client` or any client code.
- Web application or mobile application work.
- Cataloguing every Koblenz collection area.
- Generating, estimating, or inferring `residual` or `bio` events, odd/even week rules, or holiday
  shifts.
- Addresses, geocoding, map data, or recycling-point endpoints.
- Database, migrations, Redis, another shared cache, or scheduled refresh jobs.
- Authentication, accounts, or cross-device synchronization.
- Deployment, container images, CI deployment, rate limiting, or a monitoring backend.
- Any product UI or design-system change.
- Changing `packages/domain`, the demo provider, or extension behavior.

## HTTP contract

```text
GET /api/v1/providers/{providerId}/service-areas/{serviceAreaId}/collection-events
    ?from=YYYY-MM-DD&to=YYYY-MM-DD
```

`providerId` and `serviceAreaId` reuse the existing transport constraint: lowercase ASCII letters
and digits with internal hyphens, starting and ending alphanumeric, at most 64 characters. A
violation is `400`; a well-formed but unregistered value is `404`.

`from` and `to` are required ISO calendar dates. `from` must not be after `to`, and the inclusive
range must not exceed 366 days. Events are filtered to the inclusive range.

Values written as `<recorded during source verification>` are placeholders that step 1 replaces with
verified facts. They must not survive into the implementation.

### Fresh success

```json
{
  "data": [
    {
      "id": "koblenz-servicebetrieb-<serviceAreaId>-paper-2026-08-14",
      "serviceAreaId": "<recorded during source verification>",
      "wasteType": "paper",
      "date": "2026-08-14",
      "title": "<official summary, preserved>",
      "source": "municipal_ics"
    }
  ],
  "meta": {
    "provider": {
      "id": "koblenz-servicebetrieb",
      "name": "<recorded during source verification>",
      "sourceKind": "official_ics"
    },
    "serviceArea": {
      "id": "<recorded during source verification>",
      "locality": "Koblenz",
      "name": "<official area name, preserved>"
    },
    "source": {
      "name": "<recorded during source verification>",
      "landingPageUrl": "https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/",
      "attribution": "<recorded during source verification>"
    },
    "retrievedAt": "2026-07-29T08:14:02.000Z",
    "validFrom": "<recorded during source verification>",
    "validTo": "<recorded during source verification>",
    "freshness": "fresh",
    "coverage": {
      "wasteTypes": ["<recorded during source verification>"]
    },
    "range": { "from": "2026-08-01", "to": "2026-08-31" }
  }
}
```

`meta.source` carries the public landing page. The direct calendar download URL is never part of a
response. `coverage.wasteTypes` is the manifest declaration; an empty `data` array with a non-empty
coverage list means "no collection in this range", which is a different statement from "this source
does not cover this waste type".

### Stale success

Identical shape. Only the provenance differs, and `retrievedAt` remains the timestamp of the last
successful retrieval:

```json
{
  "meta": {
    "freshness": "stale",
    "retrievedAt": "2026-07-27T05:02:11.000Z"
  }
}
```

A stale response is accompanied by a structured warning log carrying the request identifier and the
source identifier.

## Error contract

Expected failures use `application/problem+json` per RFC 9457 through the existing single error
boundary. `detail` is fixed diagnostic API copy: it never contains request input, an upstream
response body, a stack trace, an upstream URL, or infrastructure details.

| `code` | Status | `type` | Trigger |
| --- | --- | --- | --- |
| `VALIDATION_ERROR` | 400 | `urn:abfall-radar:problem:validation-error` | Malformed identifier, missing or invalid `from`/`to`, `from` after `to`, or a range over 366 days. Adds `errors` with stable paths |
| `PROVIDER_NOT_FOUND` | 404 | `urn:abfall-radar:problem:provider-not-found` | Well-formed provider identifier that is not registered |
| `SERVICE_AREA_NOT_FOUND` | 404 | `urn:abfall-radar:problem:service-area-not-found` | Known provider, well-formed service-area identifier that the provider does not serve |
| `SCHEDULE_RANGE_NOT_COVERED` | 422 | `urn:abfall-radar:problem:schedule-range-not-covered` | The requested range is not covered by the source's declared validity window |
| `UPSTREAM_SOURCE_INVALID` | 502 | `urn:abfall-radar:problem:upstream-source-invalid` | The source was retrieved but is unusable — content type outside the allowlist, body limit exceeded, RFC parse failure, unknown or unmapped summary, or domain validation failure — and no valid cached value exists |
| `UPSTREAM_SOURCE_UNAVAILABLE` | 503 | `urn:abfall-radar:problem:upstream-source-unavailable` | The source could not be retrieved — timeout, connection error, non-2xx status, or a redirect leaving the host allowlist — and no valid cached value exists |
| `INTERNAL_SERVER_ERROR` | 500 | `urn:abfall-radar:problem:internal-server-error` | Any unexpected failure. Logged in full with its request identifier, returned sanitized |

`SCHEDULE_RANGE_NOT_COVERED` is decided from the declared validity window, never from an empty
result. Where a valid cached value exists, a retrieval or content failure produces a stale `200`
instead of `502` or `503`.

```json
{
  "type": "urn:abfall-radar:problem:upstream-source-unavailable",
  "title": "Official source unavailable",
  "status": 503,
  "detail": "The official source could not be retrieved and no valid schedule is available.",
  "instance": "/api/v1/providers/koblenz-servicebetrieb/service-areas/<id>/collection-events?from=2026-08-01&to=2026-08-31",
  "code": "UPSTREAM_SOURCE_UNAVAILABLE",
  "requestId": "req-1"
}
```

Every response, success or failure, carries an `x-request-id` header. For a Problem Details response
it equals the body's `requestId`, and the same value appears as `requestId` on that request's
structured log line.

## Acceptance criteria

### Source control and boundaries

- [ ] The manifest records the verified exact HTTPS URL, host, official area name, derived
      service-area identifier, source name, landing page, validity window, accepted content types,
      and declared waste types for at least one area.
- [ ] No request parameter, header, or body can influence the upstream URL or host.
- [ ] No runtime code fetches an HTML page or a PDF.
- [ ] All Koblenz-specific names, URLs, and mappings live inside the provider adapter;
      `packages/domain` is unchanged.
- [ ] Node-only provider code is reachable only through `@abfall-radar/data-providers/node` and is
      not reachable from the package root export.
- [ ] Only the `node-ical` string-parsing API is used; no library helper fetches a URL.

### Contract behavior

- [ ] `GET /api/v1/providers` lists `koblenz-servicebetrieb` with `sourceKind: "official_ics"` and
      still lists the demo provider with `sourceKind: "demo"`.
- [ ] `GET /api/v1/providers/koblenz-servicebetrieb/service-areas` returns only verified areas,
      using official naming.
- [ ] The collection-events route returns documented fresh events with full provenance for a range
      inside the source's validity window.
- [ ] `coverage.wasteTypes` comes from the manifest and is never derived from the returned events.
- [ ] An empty in-range result returns `200` with an empty `data` array and unchanged coverage.
- [ ] Events are filtered to the inclusive `from`/`to` range.
- [ ] Missing `from`, missing `to`, a non-ISO date, `from` after `to`, and a range over 366 days
      each return the documented `400`.
- [ ] Each error in the error contract is reachable and returns exactly its documented status,
      `type`, and `code`.
- [ ] No response contains an upstream URL, an upstream payload, a stack trace, or a library error
      message.
- [ ] Response schemas prevent an undocumented field from being serialized.
- [ ] Every response carries `x-request-id`, and every Problem Details body's `requestId` matches
      it.

### Ingestion behavior

- [ ] A `VALUE=DATE` all-day event yields the same calendar date regardless of the process time
      zone.
- [ ] Identifiers are byte-identical across repeated refreshes of unchanged source content.
- [ ] A combined official entry yields two events with distinct waste types and distinct
      identifiers.
- [ ] Duplicate identical normalized events collapse to one.
- [ ] A malformed event, an unknown summary, or a domain-validation failure fails the refresh and
      produces no partial schedule.
- [ ] Retrieval aborts at 5 seconds and at 1 MiB, and refuses a redirect leaving the host allowlist.
- [ ] A content type outside the recorded allowlist is rejected.
- [ ] A second request inside the fresh TTL performs no upstream request.
- [ ] Concurrent requests for one source cause exactly one upstream request.
- [ ] A failed refresh with a valid cached value returns `200` with `freshness: "stale"`, the
      preserved last-success `retrievedAt`, and a structured warning log.
- [ ] A failed refresh with no cached value returns `502` or `503` and never a value labelled stale.
- [ ] A cached value older than 7 days is not served.

### Documentation and checks

- [ ] OpenAPI documents the operation with a summary, operation identifier, tags, and schemas, plus
      examples for success, fresh, stale, validation, provider-not-found, service-area-not-found,
      range-not-covered, invalid-upstream, and unavailable-upstream responses.
- [ ] Swagger UI at `/docs` and `/openapi.json` show the operation and every documented response.
- [ ] `apps/api/README.md` and `packages/data-providers/README.md` describe the new route, provider,
      error codes, and the `./node` boundary.
- [ ] No municipal calendar file is committed and no test performs network access.
- [ ] `pnpm --filter @abfall-radar/extension build` succeeds and extension behavior is unchanged.
- [ ] `pnpm --filter @abfall-radar/api build` succeeds with `node-ical` bundled and the existing
      externals guard still passing.
- [ ] `pnpm check` passes.

## Test requirements

All tests use small synthetic ICS fixtures written for this repository and a mocked fetch boundary.

Parsing and normalization, in `packages/data-providers`:

- [ ] a minimal valid calendar parses into the expected events;
- [ ] folded lines are unfolded correctly;
- [ ] escaped characters (`\,`, `\;`, `\n`, `\\`) resolve correctly;
- [ ] a leading UTF-8 BOM is handled;
- [ ] all-day `VALUE=DATE` events keep their calendar date, asserted with the test process pinned to
      a non-UTC time zone in both hemispheres of UTC;
- [ ] identifiers are deterministic across two parses of identical content;
- [ ] a combined entry maps to two events;
- [ ] duplicate identical events collapse;
- [ ] a malformed event fails the refresh;
- [ ] an unknown summary fails the refresh.

Retrieval and cache, in `packages/data-providers`:

- [ ] a request exceeding 5 seconds aborts and reports unavailable;
- [ ] a body exceeding 1 MiB aborts and reports invalid;
- [ ] a redirect inside the allowlist is followed; one leaving it is refused;
- [ ] a content type outside the allowlist is rejected;
- [ ] a non-2xx status reports unavailable;
- [ ] a second call inside the fresh TTL does not call fetch;
- [ ] concurrent calls coalesce into one fetch;
- [ ] a failed refresh returns the cached value with `freshness: "stale"` and the preserved
      `retrievedAt`;
- [ ] a failed refresh with no cached value returns a failure and no stale value;
- [ ] a cached value past the 7-day maximum is not served.

Contract, in `apps/api`:

- [ ] the fresh success response, its schema, and its provenance;
- [ ] the stale success response and its structured warning log, asserted with the existing log
      collector;
- [ ] range filtering at both inclusive boundaries;
- [ ] every validation rejection listed in the acceptance criteria;
- [ ] `PROVIDER_NOT_FOUND`, `SERVICE_AREA_NOT_FOUND`, `SCHEDULE_RANGE_NOT_COVERED`,
      `UPSTREAM_SOURCE_INVALID`, `UPSTREAM_SOURCE_UNAVAILABLE`, and a sanitized
      `INTERNAL_SERVER_ERROR`;
- [ ] `x-request-id` present on success and matching `requestId` on every Problem Details response;
- [ ] the provider catalogue and service-area routes still return the demo provider unchanged.

## Verification

Automated:

```bash
pnpm --filter @abfall-radar/data-providers test
pnpm --filter @abfall-radar/api test
pnpm --filter @abfall-radar/api typecheck
pnpm --filter @abfall-radar/api build
pnpm --filter @abfall-radar/extension build
pnpm check
```

Manual scenarios, with `pnpm dev:api` running and `AREA` set to the verified service-area
identifier:

```bash
curl --fail-with-body http://localhost:3000/api/v1/providers
curl --fail-with-body http://localhost:3000/api/v1/providers/koblenz-servicebetrieb/service-areas
BASE="http://localhost:3000/api/v1/providers/koblenz-servicebetrieb/service-areas"
curl --fail-with-body "$BASE/$AREA/collection-events?from=2026-08-01&to=2026-08-31"
curl --include "$BASE/$AREA/collection-events?from=2026-08-31&to=2026-08-01"
curl --include "$BASE/unknown-area/collection-events?from=2026-08-01&to=2026-08-31"
curl --include "$BASE/$AREA/collection-events?from=2026-08-01"
```

- Retrieve the exact official calendar URL once by hand and confirm the response status, content
  type, size, validity window, and waste types match the manifest. Do not commit the file or any
  excerpt of its schedule.
- Compare the API response for the verified area against that manual retrieval and confirm the dates
  and waste types agree.
- Confirm a second identical request inside the TTL performs no upstream request, using the API's
  structured logs.
- Force a retrieval failure — point the manifest host at an unreachable local address in a scratch
  run — and confirm the response is a labelled stale `200` with a warning log while a cached value
  exists, and a `503` once none does.
- Open `http://localhost:3000/docs`, execute the new operation, and confirm every documented
  response and example is present.
- Open `http://localhost:3000/openapi.json` and confirm it matches the interactive reference.
- Load the built extension and confirm its dashboard and settings behave exactly as before.

## Risks and decisions

- **Upstream fragility.** A changed URL, renamed area, or new event wording breaks one source. This
  is deliberate: failing loudly is safer than a silently shortened schedule. Recovery is a manifest
  or mapping update.
- **`node-ical` inside the API bundle.** `apps/api` bundles workspace packages and their
  implementation dependencies and fails the build if anything else stays external, so `node-ical`
  and its transitive dependencies must bundle cleanly as ESM for `node24`. If they cannot,
  externalizing `node-ical` would require adding it to `apps/api` and widening the build allowlist —
  a dependency and contract change that needs human approval, not a unilateral fix.
- **`strict-peer-dependencies` is enabled.** An unmet `node-ical` peer must be declared explicitly,
  as was done for `openapi-types` in AR-002, rather than by relaxing the setting.
- **Process-local cache.** Restarts lose it and multiple instances multiply upstream requests. A
  shared cache or refresh job is out of scope per ADR 0003.
- **Unrecorded reuse terms.** Public deployment or redistribution of municipal datasets stays out of
  scope. Public availability of the file is not a licence and must not be described as one.
- **Official versus demo area naming.** Official areas may not correspond to the demo districts.
  Official naming is preserved; the demo provider's identifiers are not reused or renamed, and the
  extension's default district is not changed.
- **Residual and bio remain absent.** The source covers only the waste types recorded in step 1.
  Nothing in this task generates the odd/even week or holiday-shift rules from the printed guide.
- **Range semantics.** `SCHEDULE_RANGE_NOT_COVERED` is derived from declared validity only, so a
  source that legitimately contains no collection in a covered range returns an empty list rather
  than an error.

## Implementation boundaries

- Implement only this task. Ask before adding a dependency beyond `node-ical@0.27.1` and the
  `vitest` configuration for `packages/data-providers`, before changing a public contract beyond the
  additions above, or before expanding scope.
- Do not modify `packages/domain`, the demo provider, or the extension.
- Do not commit any municipal calendar file, excerpt, or downloaded fixture.
- All code, comments, documentation, examples, and identifiers are written in English.

Implementation starts only after this task and
[ADR 0003](../decisions/0003-official-schedule-ingestion.md) are reviewed, committed, and pushed,
because Codex discovers task context from the repository rather than from a prompt.
