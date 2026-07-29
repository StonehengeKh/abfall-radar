# API

The AbfallRadar API is the only municipal-data boundary for the browser extension, web application,
and mobile application. It normalizes provider data behind one documented HTTP contract so no client
parses a municipal format itself.

See [ADR 0002](../../docs/decisions/0002-shared-http-api.md) for the runtime, contract, and error
decisions this application implements, and
[ADR 0003](../../docs/decisions/0003-official-schedule-ingestion.md) for how official municipal
schedules are ingested.

> The API serves official collection schedules for verified service areas alongside the demo provider.
> A provider whose `sourceKind` is `demo` returns generated sample data, which must never be presented
> as official municipal data.

## Requirements

- Node.js 24
- pnpm 11

## Local development

From the repository root:

```bash
pnpm dev:api
```

Or from this workspace:

```bash
pnpm --filter @abfall-radar/api dev
```

The server restarts on change and listens on `http://localhost:3000` by default.

## Configuration

Configuration is validated at startup. An invalid value stops the process before the server is
constructed and prints a message naming the offending variable.

| Variable | Values | Default |
| --- | --- | --- |
| `NODE_ENV` | `development`, `test`, `production` | `development` |
| `HOST` | any non-empty host | `127.0.0.1` |
| `PORT` | integer, 1–65535 | `3000` |
| `LOG_LEVEL` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` | `info` |
| `API_DOCS_ENABLED` | `true`, `false` | enabled unless `NODE_ENV=production` |

The default host is loopback; binding a public interface is an explicit deployment decision. No
`.env` file is read and no configuration dependency is added. Node 24 can load one natively when that
is convenient locally:

```bash
node --env-file=.env --import tsx src/server.ts
```

## Routes

| Route | Purpose |
| --- | --- |
| `GET /health` | Operational liveness. Unversioned, per ADR 0002. |
| `GET /api/v1/providers` | The provider catalogue. |
| `GET /api/v1/providers/{providerId}/service-areas` | The normalized service areas of a provider. |
| `GET /api/v1/providers/{providerId}/service-areas/{serviceAreaId}/collection-events` | Official collection events in a date range, with provenance. |

`providerId` and `serviceAreaId` accept lowercase ASCII letters and digits with internal hyphens only,
start and end with an alphanumeric character, and are at most 64 characters. A value that violates this
transport constraint returns `400`; a well formed but unregistered identifier returns `404`.

`service area` is the location-neutral transport term for the domain `District` model. The domain
model keeps its own name; renaming it is a separate contract-change task.

### Collection events

`from` and `to` are required ISO calendar dates. `from` must not be after `to`, and the inclusive range
must not exceed 366 days. The range must lie entirely inside the validity window the source declares;
a range that straddles it returns `422` rather than being answered in part.

Events are filtered on their local `date`, not on their instant, so a timed drop-off belongs to the day
a person would look for it under.

An event is one of exactly two variants, discriminated by `collectionMode`:

| `collectionMode` | `timing` | `location` | Meaning |
| --- | --- | --- | --- |
| `curbside` | `{ "kind": "all_day" }` | absent | Put the bin out that day. |
| `mobile_drop_off` | `{ "kind": "time_window", "startsAt", "endsAt", "timeZone" }` | required | Bring something to a named place inside a window. |

No other combination exists in the contract, so a client can switch on `collectionMode` and rely on the
rest of the shape. There is no curbside event carrying a window, and no mobile drop-off missing its
window or its location: "hazardous waste on 21 March" without "10:00 to 12:00 at this corner" is not
something a person can act on, so the contract cannot express it.

A single official entry may produce more than one event. A combined hazardous and small-electronics
collection appears as two events sharing their date, window, and location while carrying different
identifiers.

`meta` states the provider, the service area under its official naming, the source and its public
attribution page, the retrieval time, the validity window, the freshness state, the declared
waste-type coverage, and the range that was filtered on.

- `freshness: "stale"` means the last refresh failed and a previously retrieved schedule is being
  served. `retrievedAt` then remains the timestamp of that last successful retrieval, so a response
  never claims to be newer than it is, and a structured warning is logged with the request identifier.
- `coverage.wasteTypes` is the source's own declaration, never derived from the events returned. An
  empty `data` array with a non-empty coverage list means "no collection in this range", which is a
  different statement from "this source does not cover this waste type".
- The direct calendar download URL is never part of a response, so retrieval can change without
  breaking a client and the API does not advertise a deep link into municipal infrastructure.

**Event identifiers are opaque.** The readable `providerId-serviceAreaId-wasteType-date` prefix exists
for operator legibility and is followed by a digest of the event's identity. Do not parse them. An
occurrence the source moves or re-times becomes a new identifier rather than an edited one.

## Contract documentation

With documentation enabled:

- interactive reference: <http://localhost:3000/docs>
- machine-readable document: <http://localhost:3000/openapi.json>

The OpenAPI document is generated from the runtime route schemas and is the only source of truth. Do
not maintain a specification by hand. Set `API_DOCS_ENABLED=false` to disable both endpoints without
changing route code; they then return a Problem Details `404` like any other unknown route.

## Error contract

Expected failures use RFC 9457 Problem Details with the `application/problem+json` media type:

```json
{
  "type": "urn:abfall-radar:problem:provider-not-found",
  "title": "Provider not found",
  "status": 404,
  "detail": "No schedule provider exists for the supplied identifier.",
  "instance": "/api/v1/providers/unknown/service-areas",
  "code": "PROVIDER_NOT_FOUND",
  "requestId": "req-1"
}
```

| `code` | Status | `type` | Cause |
| --- | --- | --- | --- |
| `VALIDATION_ERROR` | 400 | `urn:abfall-radar:problem:validation-error` | The request did not match the documented request schema. Adds `errors` with stable field paths and machine-readable codes. |
| `REQUEST_ERROR` | 400–499 | `urn:abfall-radar:problem:request-error` | A client error raised by the HTTP framework itself, such as an unsupported media type. `status` carries the actual code. No implemented operation can currently return it, so it is not documented per operation. |
| `PROVIDER_NOT_FOUND` | 404 | `urn:abfall-radar:problem:provider-not-found` | The identifier is well formed but no provider is registered for it. |
| `SERVICE_AREA_NOT_FOUND` | 404 | `urn:abfall-radar:problem:service-area-not-found` | The provider exists but does not serve a service area with that identifier. |
| `COLLECTION_EVENTS_NOT_AVAILABLE` | 404 | `urn:abfall-radar:problem:collection-events-not-available` | The provider and the area both exist, but this provider publishes no official calendar for that area. The demo provider never publishes one. |
| `SCHEDULE_RANGE_NOT_COVERED` | 422 | `urn:abfall-radar:problem:schedule-range-not-covered` | The requested range is not fully inside the validity window the source declares. Decided from that declared window alone, never from an empty result. |
| `ROUTE_NOT_FOUND` | 404 | `urn:abfall-radar:problem:route-not-found` | The route does not exist. |
| `INTERNAL_SERVER_ERROR` | 500 | `urn:abfall-radar:problem:internal-server-error` | An unexpected failure. Logged in full, returned sanitized. |
| `UPSTREAM_SOURCE_INVALID` | 502 | `urn:abfall-radar:problem:upstream-source-invalid` | The official source was reached but is unusable, and no valid cached schedule exists. |
| `UPSTREAM_SOURCE_UNAVAILABLE` | 503 | `urn:abfall-radar:problem:upstream-source-unavailable` | The official source could not be retrieved, and no valid cached schedule exists. |

Where a valid cached schedule *does* exist, a retrieval or content failure produces a stale `200`
instead of a `502` or `503`. A `502` or `503` therefore means nothing trustworthy is available at all,
which is why it is returned rather than a plausible-looking guess.

The collection-events operation documents **one** 404 response whose schema is a `oneOf` over
`PROVIDER_NOT_FOUND`, `SERVICE_AREA_NOT_FOUND`, and `COLLECTION_EVENTS_NOT_AVAILABLE`, discriminated on
`code`. An OpenAPI operation permits a single entry per status code, so three separately registered 404
schemas would overwrite each other.

`detail` is fixed diagnostic API copy. It never interpolates request input, upstream responses, or
framework internals, and no response contains a stack trace, an upstream payload, an upstream URL, a
library error message, or infrastructure details. An upstream failure is logged in full — including its
underlying cause — and returned sanitized. `detail` is not localized product UI copy.

## Request correlation

Every response carries an `x-request-id` header. Identifiers are always generated by the server: an
inbound header would be untrusted input echoed into responses and logs.

- For any Problem Details response, `x-request-id` equals the `requestId` member of the body.
- The same value is logged as `requestId` on the structured log line for that request, so a
  client-reported failure can be traced directly to its server log entry.

## Production build

```bash
pnpm --filter @abfall-radar/api build
pnpm --filter @abfall-radar/api start
```

`build` runs `scripts/build.ts` with esbuild and writes `dist/server.js` plus a source map;
`start` runs it with Node source-map support enabled.

The bundling boundary is deliberate and enforced:

- `@abfall-radar/*` workspace packages and their implementation dependencies are **bundled**, because
  those packages publish TypeScript sources and are not resolvable as runtime packages from this
  workspace;
- only the third-party runtime packages this workspace declares itself stay **external**: `fastify`,
  `zod`, `@fastify/type-provider-zod`, `@fastify/swagger`, and `@fastify/swagger-ui`.

After bundling, the build reads the esbuild metafile in memory and fails if anything other than a
Node built-in or one of those five packages is still external. A bundle that would depend on an
undeclared runtime package therefore never reaches `dist`.

The calendar parser reaches the artifact this way too: `node-ical` is declared by
`@abfall-radar/data-providers` and is bundled rather than externalized, which is why the artifact is
larger than the route code alone would suggest and why a third-party parser sits inside the trust
boundary. Externalizing it instead would mean declaring it here and widening the allowlist — a
dependency and contract change, not a build tweak.

## Architecture

```text
src/
  app.ts                     Application factory: no port, no signal handlers, no ready()
  server.ts                  Process entrypoint: configuration, listen, graceful shutdown
  config/env.ts              Startup configuration validation
  http/problem-details.ts    RFC 9457 schemas, problem catalogue, ApiProblem
  http/error-handler.ts      The single centralized error boundary
  http/openapi.ts            OpenAPI generation and Swagger UI registration
  providers/                 Provider catalogue and District -> ServiceArea adaptation
  routes/                    Route plugins with their request and response schemas
  test/                      Shared test setup
```

`buildApp` never touches the process, so tests exercise the real application through Fastify
injection without opening a socket. `server.ts` owns the runtime lifecycle.

The provider catalogue is built once per instance and decorated onto it, not held as module state, so
each test application owns its own provider cache and no cached schedule leaks between tests.
`BuildAppOptions.providerRuntime` optionally supplies a `fetch` and a `Clock` to the provider adapters;
both default to the real implementations. That is how stale responses, an initial `502` or `503`, cache
expiry, and refresh coalescing are tested deterministically — without a production-only switch, a
mutable global, an environment backdoor, or a six-hour wait. The API knows nothing about a municipal
host: parsing, retrieval, caching, and normalization all live in
[`@abfall-radar/data-providers/node`](../../packages/data-providers/README.md).

Registration order matters: the validator and serializer compilers and the error boundary are
installed on the root instance before any route, and `@fastify/swagger` is registered before the
routes because it collects schemas through the `onRoute` hook.

Relative imports are extensionless, matching every other workspace. Types are checked independently
of the bundler with `tsc --noEmit`.

## Verification

```bash
pnpm --filter @abfall-radar/api typecheck
pnpm --filter @abfall-radar/api test
pnpm --filter @abfall-radar/api build
pnpm check
```

Manual checks with the server running:

```bash
curl --fail-with-body http://localhost:3000/health
curl --fail-with-body http://localhost:3000/api/v1/providers
curl --fail-with-body http://localhost:3000/api/v1/providers/demo/service-areas
curl --include http://localhost:3000/api/v1/providers/unknown/service-areas
curl --include http://localhost:3000/api/v1/providers/Invalid_ID/service-areas
curl --include http://localhost:3000/nope
```

Official collection events, which reach the real municipal source:

```bash
BASE="http://localhost:3000/api/v1/providers/koblenz-servicebetrieb/service-areas/koblenz-stadtmitte"
curl --fail-with-body "$BASE/collection-events?from=2026-03-01&to=2026-03-31"
curl --fail-with-body "$BASE/collection-events?from=2026-11-01&to=2026-11-30"
curl --include "$BASE/collection-events?from=2026-03-31&to=2026-03-01"   # 400
curl --include "$BASE/collection-events?from=2025-01-01&to=2025-12-31"   # 422
curl --include "$BASE/collection-events?from=2026-03-01"                 # 400
curl --include "http://localhost:3000/api/v1/providers/koblenz-servicebetrieb/service-areas/unknown-area/collection-events?from=2026-03-01&to=2026-03-31"  # 404
curl --include "http://localhost:3000/api/v1/providers/demo/service-areas/koblenz-stadtmitte/collection-events?from=2026-03-01&to=2026-03-31"              # 404
```

Confirm the March and November responses each contain the mobile drop-off with its window,
`Europe/Berlin`, and the trimmed location, and that the `hazardous` and `small_electronics` events
share their timing and location while carrying different identifiers. A second identical request inside
the fresh time-to-live returns the identical `retrievedAt`, which is the observable proof the cache
served it without another upstream request.

Failure behavior — a stale `200`, an initial `502` or `503`, cache expiry, and refresh coalescing — is
covered by the injected-fetch and injected-clock tests rather than by hand: forcing it against a
running server would need either a six-hour wait or a production-only switch, and no such switch
exists.
