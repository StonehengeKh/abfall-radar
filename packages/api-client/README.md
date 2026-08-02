# API client

`@abfall-radar/api-client` is the typed transport boundary for the AbfallRadar HTTP API. The browser
extension consumes it today; the web and mobile applications are its next consumers.

See [ADR 0004](../../docs/decisions/0004-extension-api-integration.md) for the decisions this package
implements and [ADR 0002](../../docs/decisions/0002-shared-http-api.md) for the contract rules that
stay in force.

## Boundary

This package is **browser-safe and transport-only**.

| It owns | It does not own |
| --- | --- |
| Transport contracts and request functions | Application state |
| Request construction, deadlines, cancellation | A cache |
| Translation of an HTTP outcome into a failure | A product retry policy |
| Base URL validation and normalization | UI behavior or user-visible copy |

- `zod` is the single runtime dependency. There is no Fastify, no `node:*` built-in, nothing from
  `apps/api`, and no `@abfall-radar/data-providers`.
- It deliberately does **not** depend on `@abfall-radar/domain`. This package owns the wire shape and
  the domain owns the business model; neither is expressed in terms of the other. Mapping between them
  belongs to whichever consumer needs it — for the extension, that is one explicit adapter that renames
  `serviceAreaId` to `districtId` and `wasteType` to `type` and validates the result through
  `CollectionEventSchema`.
- `src/import-graph.test.ts` asserts the **complete** set of bare specifiers reachable from the barrel
  rather than the absence of a few known-bad ones, so a new dependency cannot slip in unnoticed.
- `@types/node` is a **test-only** devDependency: the guard reads source files to walk them. It carries
  no runtime code, but it does make Node globals type-visible package-wide, so the compiler alone would
  no longer reject a stray `node:crypto` import in production code. The guard replaces that check by
  asserting no source file outside itself imports a Node built-in at all.

## Generated types, hand-written validators

OpenAPI is the canonical contract. The two representations in this package are kept honest by two
checks rather than by discipline.

`src/generated/api.ts` is **generated and must never be edited by hand.**

```bash
pnpm --filter @abfall-radar/api generate:contract
```

That command belongs to `apps/api` because `apps/api` owns the contract: it builds the application in
process, writes `apps/api/openapi.json`, and re-emits this module from those exact bytes. Nothing
listens on a port and no development server is required. The dev-time coupling therefore points from an
application to a package, which the [architecture](../../docs/architecture/repository-structure.md)
allows; a script here reaching into `apps/api` would point the other way.

Runtime **validators are hand-written**, in Zod, under `src/contracts/`, and scoped to the untrusted
HTTP boundary only: the three responses this client reads plus RFC 9457 Problem Details. They exist
because generated types vanish at runtime and the shared rules require external data to be parsed
rather than asserted.

- **`src/contracts/compatibility.ts` pins each validator's output to its generated type at compile
  time.** A validator that drifts is a type error, not a runtime surprise.
- **A drift test in `apps/api` rebuilds both artifacts and fails when either committed file is stale.**
  A hand edit is therefore a review blocker rather than a merge conflict.
- Both artifacts are excluded from Biome so formatting cannot fight the generator. `tsc --noEmit` still
  typechecks the generated module.

### Forward compatibility

Every API response validator **requires and validates every known member** and **tolerates unknown
members by stripping them**, so an additive server field can neither break an installed extension nor
be forwarded into a cache or a UI by a build that does not understand it.

Three deliberate exceptions:

- an `unavailable` capability carrying a `timeZone` or a `validity` is **rejected**, because a window
  alongside "this source publishes no calendar" describes a period that does not exist. That is a
  contradiction, not an additive field.
- a problem `code` is validated as a string rather than as today's closed set, so a newer code degrades
  to a generic message instead of failing validation.
- a genuinely new `collectionMode` **fails validation loudly**. ADR 0003 chose a closed variant set
  precisely so that adding one is a contract change for every client, and that failure is the intended
  cost of making an incomplete event unrepresentable.

## Failures

`createApiClient` returns a result rather than throwing, so no caller can forget that a request fails.
The failure taxonomy is a **strict discriminated union**:

| Kind | Members — exactly these | Request identifier |
| --- | --- | --- |
| `problem` | `kind`, `operation`, `status`, `code`, `requestId` | Present, from the validated body |
| `network` | `kind`, `operation` | None |
| `timeout` | `kind`, `operation`, `timeoutMs` | None |
| `cancelled` | `kind`, `operation` | None |
| `invalid_response` | `kind`, `operation`, `status` | None |

A `requestId` exists on `problem` alone, and it is never generated, defaulted, or replaced by a
placeholder: an identifier that matches no server log is worse than none. A discriminated union is what
makes that enforceable — a failure that never had an identifier cannot be typed as though it might.

A Problem Details body is validated in full and then **projected at the parse site** onto the members
above. `detail`, `instance`, `errors`, and every server-supplied message string are discarded there and
never returned to a caller: `detail` is diagnostic API copy rather than product copy, `instance` is an
internal request path, `errors` can carry request input, and a browser console is not a private place to
put any of them.

`timeoutMs` is **the configured deadline** — a positive integer, `8000` by default — and never a
measured elapsed duration. A missing, fractional, zero, or negative value is rejected rather than
defaulted, because each describes a deadline that could never have been enforced. No synonym exists
anywhere: not `deadlineMs`, not `elapsed`, not `elapsedMs`.

A timeout and a caller cancellation are reported distinctly. Collapsing them would either show an error
for work the user themselves superseded or hide a real stall.

The extension adds one boundary failure of its own, `unsupported_message`, for an inbound message that
failed envelope validation. It is built from the branch schemas exported here rather than restated, so
the two unions cannot drift.

## Base URL

`parseApiBaseUrl` validates and normalizes a configured base URL. It is pure and performs no
environment access, so the extension's build configuration and its application code both call it and
cannot disagree about the origin.

It requires an **origin only** — scheme, host, and optional port — and rejects credentials, a path, a
query, a fragment, an unusable scheme, and a malformed value. Nothing is trimmed or repaired: silently
discarding the extra part would leave the author believing it took effect. It reports whether the origin
is loopback and whether it is HTTPS, which is what lets a release build refuse a development
configuration.

A default port is dropped, so `https://host:443` and `https://host` normalize to one origin and a
consumer's cache cannot key one server under two names. A non-default port is preserved, and every
request URL is built from the exact configured origin including that port.

## Usage

```ts
import { createApiClient } from '@abfall-radar/api-client';

const client = createApiClient({ baseUrl: 'http://127.0.0.1:3000' });

const providers = await client.listProviders();

if (!providers.ok) {
  // providers.failure is the discriminated union above.
  return;
}

const areas = await client.listServiceAreas('koblenz-servicebetrieb');
const schedule = await client.listCollectionEvents({
  providerId: 'koblenz-servicebetrieb',
  serviceAreaId: 'koblenz-stadtmitte',
  range: { from: '2026-03-01', to: '2026-05-30' },
});
```

`fetch` and `timeoutMs` are injectable, so no test needs the network or a wait. Each request accepts an
optional `AbortSignal`; `runtime.sendMessage` offers the extension popup no cancellation, so that
support exists for the web and mobile consumers that can use it.

## Verification

```bash
pnpm --filter @abfall-radar/api-client test
pnpm --filter @abfall-radar/api-client typecheck
```

No test in this package performs network access. `apps/api/src/contract/client-contract.test.ts`
additionally parses real injected API responses through these validators, so the fixtures here cannot
quietly diverge from the running contract.
