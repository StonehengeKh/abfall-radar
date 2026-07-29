# ADR 0003: Ingest official collection schedules server-side from allowlisted calendar sources

- Status: Accepted
- Date: 2026-07-29

## Context

AbfallRadar has a browser extension foundation ([ADR 0001](0001-monorepo.md)) and a documented HTTP
API ([ADR 0002](0002-shared-http-api.md)), but every schedule it can serve today is generated demo
data. The product exists to answer one question — which bin goes out on which day — and that answer
is only useful when it comes from the responsible municipal authority.

The first official source is the Koblenz municipal waste operator, which publishes downloadable
calendar files per collection area:

- <https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/>
- <https://servicebetrieb.koblenz.de/downloads/broschueren/ksk-abfallratgeber-26-ai.pdf?cid=3mpk>

Four constraints shape this decision.

**The product stays location-neutral.** `docs/ai/shared-rules.md` requires that product UI and
`packages/domain` never depend on a city's names, URLs, calendar formats, or administrative
hierarchy. A municipal integration is an adapter, not a product feature.

**Municipal sources are untrusted and unstable.** A published calendar file is external input of
unknown size, encoding, and structure. Its URL, its event wording, and its area boundaries can
change without notice or versioning, and the site can be slow or unreachable.

**Official data must never be confused with anything else.** The shared rules forbid presenting
demo, cached, stale, estimated, or community data as official current data, and require that source,
retrieval time, validity, and freshness travel with the data.

**Reuse terms are not yet recorded.** The calendar files are publicly downloadable, but public
availability is not a licence to redistribute a dataset from a hosted service.

## Decision

Ingest official collection schedules exclusively on the server, from exact allowlisted HTTPS
calendar URLs held in a server-controlled source catalogue, and expose the result through the
versioned HTTP contract as normalized events plus explicit provenance.

### Server-controlled source catalogue

The set of ingestible sources is data the server owns.

- A client may select a provider identifier and a service-area identifier. A client may never
  supply, influence, or override an upstream URL, host, or path. There is no proxy, no URL
  parameter, and no request header that reaches the retrieval boundary.
- The first official provider identifier is `koblenz-servicebetrieb`. The existing `demo` provider
  keeps its identifier and behavior.
- Each entry of the catalogue is a **source manifest** that declares, per service area: the exact
  allowlisted HTTPS calendar URL, the allowed host, the official area name and the derived
  service-area identifier, the human-readable source name, the public landing page used for
  attribution, the validity window the file covers, the accepted response content types, and the
  waste types the source actually contains.
- Manifest values are recorded from a manual verification of the real source. They are never
  inferred from a URL pattern, a naming convention, or another area's entry.

### Ingestion boundary

- Retrieval uses the exact URL from the manifest. URL patterns are never constructed or guessed.
- Runtime HTML scraping and runtime PDF scraping are prohibited. The published PDF guide is a
  document for humans verifying the source; it is not a runtime input.
- RFC 5545 parsing uses the maintained `node-ical` library, version `0.27.1`, as a runtime
  dependency of `packages/data-providers`. Only its string-parsing API is used. Library helpers that
  fetch a URL are not used, because retrieval must stay inside the bounded, allowlisted boundary
  described below.
- HTTP retrieval uses the Node 24 built-in `fetch`, reached through an injectable boundary so tests
  never touch the network and no test fixture is a downloaded municipal file.
- Node-specific provider code is reachable only through an explicit `./node` subpath export of
  `@abfall-radar/data-providers`. The package root export stays browser-safe, so nothing in this
  decision enters the browser extension dependency graph.

### Ownership of each step

Bounded retrieval, caching, RFC parsing, normalization, and runtime validation belong to the
provider adapter, because `docs/architecture/repository-structure.md` makes every adapter
responsible for returning validated data together with its source metadata and an explicit freshness
state.

`apps/api` orchestrates: it resolves provider and service area, filters the requested date range,
maps domain names onto transport names, and translates failures into Problem Details. It does not
parse calendar formats and it does not know a municipal host.

The provenance, freshness, and manifest types live in `packages/data-providers`. `packages/domain`
does not change: `CollectionEventSchema` already accepts `source: 'municipal_ics'`, and a location-
and transport-neutral domain has no reason to learn about retrieval metadata before a second
consumer needs it.

### Normalization

- An official event summary is mapped to a `WasteType` through a mapping table that lives inside the
  Koblenz adapter. The domain waste vocabulary does not change.
- A single official entry may normalize into more than one collection event when it announces more
  than one collection, for example hazardous waste together with small electronics.
- Collection dates are calendar dates. All-day `VALUE=DATE` semantics are preserved exactly, with no
  conversion through UTC or a local time zone that could shift a date by a day.
- Event identifiers are derived deterministically from provider, service area, waste type, and date,
  so the same official occurrence keeps the same identifier across refreshes and processes. The
  upstream `UID` is not used as the public identifier, because one upstream entry can produce two
  events.
- Official area naming is preserved. Existing demo identifiers are not forced onto official data
  when the official source uses different boundaries or different names. Where the two disagree, the
  official naming wins and the demo entry is left alone.

### Trust boundaries

Every byte from a municipal host is untrusted input and crosses four checks before it becomes a
response.

| Boundary | Rule |
| --- | --- |
| Retrieval | 5-second upstream timeout; 1 MiB response-body limit; only the manifest host is allowed |
| Redirects | A redirect that leaves the explicit host allowlist is refused, not followed |
| Content type | Only the narrow content-type set observed and recorded during source verification is accepted |
| Structure | RFC 5545 parsing, then runtime domain validation of every normalized event |

An invalid or unmapped official summary fails the refresh. Ingestion never silently drops an entry
it does not understand, because a partial schedule is indistinguishable from a complete one to a
user and would be the most damaging possible failure mode. A previously retrieved valid value may
still be served while the refresh is failing.

### Caching and freshness

Each source gets a process-local cache entry:

- a fresh time-to-live of 6 hours;
- a stale-if-error maximum of 7 days;
- coalesced concurrent refreshes, so simultaneous requests for one source cause one upstream
  request;
- the timestamp of the last successful retrieval, preserved across failed refreshes.

A failed refresh may serve an existing valid value with `freshness: "stale"` and a structured
warning log. Stale data is never manufactured: when no successful retrieval has ever produced a
value, the request fails instead of returning something labelled stale.

Waste-type coverage is declared by the manifest. It is never inferred from the absence of events,
because an empty result can mean "no collection in this range" or "this source does not contain this
waste type", and those must not be conflated.

### HTTP surface

One resource is added to the versioned contract:

```text
GET /api/v1/providers/{providerId}/service-areas/{serviceAreaId}/collection-events
    ?from=YYYY-MM-DD&to=YYYY-MM-DD
```

- `from` and `to` are required ISO calendar dates, `from` is not after `to`, and the inclusive range
  is at most 366 days.
- The transport uses `serviceAreaId` and `wasteType`. Provider-specific calendar fields — `UID`,
  `DTSTAMP`, `SUMMARY` internals, recurrence rules — are not exposed.
- A response carries the normalized events plus source name, retrieval time, source validity window,
  freshness state, and the explicitly declared waste-type coverage.
- Public attribution links the official landing page. The direct calendar download URL is not part
  of the public API contract, so the project can change how it retrieves a source without breaking a
  client and does not advertise a deep link into municipal infrastructure.

### Data flow

```mermaid
flowchart TD
  Source["Official municipal calendar"] --> Fetch["Bounded retrieval"]
  Manifest["Server-controlled source manifest"] --> Fetch
  Fetch --> Cache["Process-local cache"]
  Cache --> Parse["RFC 5545 parsing"]
  Parse --> Normalize["Mapping, calendar dates, deterministic identifiers"]
  Normalize --> Validate["Runtime domain validation"]
  Validate --> Api["API orchestration"]
  Api --> Response["Events plus provenance and freshness"]
  Api --> Problem["RFC 9457 Problem Details"]
  Response --> Clients["Extension, web, and mobile"]
  Problem --> Clients
```

Bounded retrieval enforces the timeout, the body limit, and the host allowlist. The cache enforces
the fresh time-to-live, stale-if-error, and refresh coalescing. API orchestration filters the
requested range and maps domain names onto transport names.

## Consequences

### Positive

- clients receive official dates through one contract, with no municipal host permission, no
  calendar parser, and no upstream instability of their own;
- a municipal quirk stays in one adapter, so the product and the domain remain location-neutral;
- provenance and freshness travel with the data, so a surface can label what it shows honestly;
- the allowlist plus the bounded retrieval boundary means a compromised or slow municipal host
  cannot turn into a request-forgery vector, a memory exhaustion vector, or an indefinite hang;
- caching keeps the API responsive and keeps request volume against a municipal host low;
- because an unmapped entry fails loudly, an upstream wording change is a visible error rather than
  a silently shortened schedule.

### Trade-offs

- the API depends on the availability of a municipal host for fresh data;
- an exact URL per service area does not scale by convention: adding an area is a verification step,
  not a configuration guess;
- a process-local cache is lost on restart and is not shared between instances, so a horizontally
  scaled deployment multiplies upstream requests;
- `node-ical` and its transitive dependencies are bundled into the API production artifact, which
  enlarges it and puts a third-party parser inside the trust boundary;
- strict failure on unknown input means an upstream wording change causes an outage for that source
  until the mapping is updated, rather than degraded output.

## Alternatives considered

### Clients parse municipal calendars themselves

Rejected. It would require municipal host permissions in the extension, duplicate the parser across
extension, web, and mobile, expose every client release to upstream changes, and make the "never
present partial data as complete" rule unenforceable across surfaces. ADR 0002 already rejected this
for the same reasons.

### Request-time HTML or PDF scraping

Rejected. The landing page and the printed guide are presentation artifacts for humans. Their markup
and layout change for editorial reasons, so a scraper turns an editorial change into a data
incident. Both are also far weaker sources than a structured calendar file: the PDF states general
odd/even week rules and holiday shifts in prose, which is not a schedule for a specific area.

### Client-supplied upstream URLs

Rejected. Accepting a URL from a client makes the API a request-forgery proxy into any network it
can reach, makes the response impossible to attribute or validate against a known manifest, and
moves the trust boundary to the least trustworthy participant. The server-controlled catalogue is
the entire security model.

### Committed official snapshots

Rejected. Committing a downloaded municipal calendar puts a third-party dataset in the repository
with no recorded reuse terms, guarantees the data ages into being wrong, and creates a schedule that
looks official while nothing refreshes it. Tests therefore use small synthetic fixtures written for
this project.

### Handwritten ICS parsing

Rejected. RFC 5545 is not a line-oriented format that a small reader can honestly approximate: line
folding, escaping, character sets, value types, time-zone components, and recurrence rules are all
places where a naive parser silently produces a plausible wrong date. A maintained parser is the
safer dependency, and it is confined behind the adapter so it can be replaced.

## Unresolved operational risks

- **Source reuse terms are unrecorded.** Public deployment or redistribution of municipal datasets
  stays out of scope until reuse terms are established and written down. Public availability of a
  file is not a licence, and this decision must not be read as granting one.
- **Residual and bio schedules are not solved.** The official 2026 guide expresses these as general
  odd/even week rules with holiday shifts rather than as per-area dates. This decision does not
  generate or estimate them; an estimated date would be exactly the kind of unofficial data the
  shared rules forbid presenting as official.
- **Coverage is intentionally narrow.** The first implementation proves the path with at least one
  manually verified official collection area. Cataloguing every Koblenz area is later work, and
  until then the API must not imply that unlisted areas are unsupported by the municipality rather
  than merely unverified here.
- **Scaling changes the caching decision.** A shared cache, a scheduled refresh job, or persistence
  becomes necessary once more than one instance runs; ADR 0002 deliberately deferred that choice to
  a slice that defines its data lifecycle.
- **Upstream fragility is accepted, not eliminated.** A changed URL, a renamed area, or new event
  wording breaks one source loudly. Monitoring that surfaces the resulting structured warnings and
  errors is not part of this decision.
