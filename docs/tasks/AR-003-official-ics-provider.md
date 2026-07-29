# AR-003: Official ICS collection-schedule provider

- Status: Ready
- Owner: Claude Code

## Goal

Serve real official waste collection dates through the documented HTTP API for the verified Koblenz
Stadtmitte collection area, by ingesting the municipal calendar file server-side behind a bounded,
allowlisted retrieval boundary. Every response states where its data came from, when it was
retrieved, which period the source covers, whether it is fresh or stale, which waste types the
source declares, and for each event whether it is a curbside collection on a date or a mobile
drop-off inside a time window at a place.

## User outcome

A person who selects the verified official collection area sees the dates the responsible municipal
operator published, not generated sample data. For a mobile drop-off they also see the window and
the location, because "hazardous waste on 21 March" without "10:00 to 12:00 at this corner" is not
actionable. When the municipal source is temporarily unavailable, they can still see the last
successfully retrieved schedule, explicitly labelled as stale. When nothing trustworthy is
available, they see an error rather than a plausible-looking guess. At no point is demo, partial,
estimated, or stale data presented as complete current official data.

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
| `packages/domain/src/waste.ts` | `WasteTypeSchema` and `CollectionEventSchema`. The waste vocabulary is unchanged; the event model gains timing, mode, and location |
| `packages/domain/src/schedule.ts` | `getUpcomingEvents`, `findReminderEvent`, `getRelativeDateLabel`. All keep working, because `date` keeps its name and meaning |
| `packages/data-providers/src/provider.ts` | The `ScheduleProvider` contract the demo provider implements |
| `packages/data-providers/src/demo-provider.ts` | The normalization style to follow; it gains all-day and curbside metadata and keeps its identifiers |
| `apps/api/src/providers/provider-catalogue.ts` | `ProviderCatalogueEntry`, `findProviderEntry`, `toServiceArea` |
| `apps/api/src/routes/v1/providers.schemas.ts` | `ProviderSourceKindSchema`, `ServiceAreaSchema`, `PROVIDER_ID_PATTERN`, `PROVIDER_ID_MAX_LENGTH` |
| `apps/api/src/http/problem-details.ts` | `problemCatalogue`, `ApiProblem`, `ProblemDetailsSchema`, `buildProblem` |
| `apps/api/src/http/error-handler.ts` | The single centralized error boundary. Do not add a second error path |
| `apps/api/src/http/openapi.ts` | Generated-contract passes; OpenAPI stays generated from route schemas |
| `apps/api/src/test/build-test-app.ts`, `apps/api/src/test/log-collector.ts` | Injection-based app construction and structured-log assertions |
| `packages/domain/package.json` | The `vitest` script and dependency shape to mirror in `data-providers` |

## Source verification record

Verified by hand on 2026-07-29 against the live source with read-only requests. No part of the
calendar was saved to the repository.

| Manifest field | Recorded value |
| --- | --- |
| `providerId` | `koblenz-servicebetrieb` |
| `serviceAreaId` | `koblenz-stadtmitte` |
| `locality` | `Koblenz` |
| Official area name | `Stadtmitte` |
| Allowed origin | `https://servicebetrieb.koblenz.de`, hostname `servicebetrieb.koblenz.de`, effective port 443 |
| Accepted content types | `text/calendar` |
| Expected calendar zone | `Europe/Berlin`, checked against the calendar's declared zone on every refresh |
| Source name and attribution | `Kommunaler Servicebetrieb`, the operator name the site publishes |
| Landing page | <https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/> |
| Validity window | `2026-01-01` through `2026-12-31` |

The manifest URL is the stable form without a query:

```text
https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/entsorgungstermine-2026-digital/ics-stadtmitte.ics
```

Observations of that one retrieval, recorded as evidence and not as manifest values:

| Observation | Value |
| --- | --- |
| Redirect | `302` to the same origin and pathname with a `cid` query parameter added (`cid=3kuw`) |
| Final status | `200` |
| Content type | `text/calendar`, with no `charset` parameter |
| Body size | 22301 bytes |
| `ETag` | `"3kuw"` |
| Calendar metadata | Exactly one `X-WR-TIMEZONE:Europe/Berlin`, no `VTIMEZONE`, no `TZID` parameter, `METHOD:PUBLISH` |
| Upstream entries | 46 `VEVENT` entries: 44 all-day `DTSTART;VALUE=DATE` and 2 timed, no `RRULE` |
| Event date range | `2026-01-07` through `2026-12-21` |
| Normalized result | 48 `CollectionEvent` values: the 44 all-day entries, plus 4 timed events from the 2 combined entries |
| Identity check | 48 distinct waste-type-and-date pairs, zero collisions |

The `cid` value and the `ETag` are volatile and belong to neither the manifest nor the public
contract. The official area name and the validity window are derived from the URL path and the
landing page, not from the payload: `X-WR-CALNAME` is the single character `2`, so the file attests
neither. The file is a third-party calendar export, not a purpose-built municipal feed.

### Summary mapping

| Official summary | Count | Waste type | Timing | Collection mode |
| --- | --- | --- | --- | --- |
| `Altpapier` | 17 | `paper` | all-day | curbside |
| `Gelber Sack` | 17 | `yellow_bag` | all-day | curbside |
| `Grünschnitt` | 8 | `green_waste` | all-day | curbside |
| `Tannenbäume` | 2 | `christmas_tree` | all-day | curbside |
| `Schadstoffe / Elektrokleinteile` | 2 | `hazardous` **and** `small_electronics` | time window | mobile drop-off |

Declared coverage is therefore `paper`, `yellow_bag`, `green_waste`, `christmas_tree`, `hazardous`,
and `small_electronics`. `residual` and `bio` are not covered: no such summary exists in the source,
and this task does not generate them.

The counts in the table are upstream entries. Because each `Schadstoffe / Elektrokleinteile` entry
normalizes into two events, the 46 upstream entries produce 48 `CollectionEvent` values: 17 `paper`,
17 `yellow_bag`, 8 `green_waste`, 2 `christmas_tree`, 2 `hazardous`, and 2 `small_electronics`. Keep
the two numbers apart when reading or asserting anything about this source.

### Verified timed events

| Local date | Window | Location |
| --- | --- | --- |
| `2026-03-21` | `2026-03-21T10:00:00Z` to `2026-03-21T12:00:00Z` | `Rizzastraße Ecke Südallee` |
| `2026-11-07` | `2026-11-07T10:00:00Z` to `2026-11-07T12:00:00Z` | `Rizzastraße Ecke Südallee` |

These are the two upstream entries. Each normalizes into a `hazardous` event and a
`small_electronics` event, so they produce four timed normalized events in total, sharing their
date, window, and location within each pair.

Both instants fall in `Europe/Berlin` standard time, so their Berlin date happens to equal their UTC
date. That coincidence must not be relied on, which is why a synthetic event whose UTC and Berlin
dates differ is a required test. The source location value carries a trailing space, so trimming is
required rather than cosmetic.

### Observed `LOCATION` usage

The source populates `LOCATION` on **every** entry, but means two different things by it:

| Entries | `LOCATION` value | Meaning |
| --- | --- | --- |
| All 44 all-day | `Stadtmitte` | The collection area, identical to the manifest `areaName` |
| Both timed | `Rizzastraße Ecke Südallee ` | An actual street corner to bring waste to |

The curbside value is therefore redundant with `meta.serviceArea`, while the timed value is essential.
`DESCRIPTION` is also present on all 46 entries and is never exposed. Treating a curbside `LOCATION`
as an error would reject the whole source; ignoring any curbside `LOCATION` would risk discarding a
real place. Scope step 4 resolves this by accepting exactly the area label and rejecting anything
else.

### Identifier note

The verified official `serviceAreaId` is `koblenz-stadtmitte`, which is also the identifier of a
demo district. This is a coincidence of official naming, not a reuse of the demo identifier: the
official area is named Stadtmitte, and the same slug follows from it. Service-area identifiers are
namespaced by provider, so the two never collide, and the demo entry is left exactly as it is.

## Scope

Source verification above is complete. Implement in this order.

### 1. Domain contract change

Extend `packages/domain/src/waste.ts` so a normalized collection event can represent both verified
timing forms **and cannot represent an incomplete one**. Model the currently supported variants as a
discriminated union on `collectionMode`, not as three independent fields:

- **All-day curbside.** `collectionMode: 'curbside'`, `timing: { kind: 'all_day' }`, and no
  `location`.
- **Timed mobile drop-off.** `collectionMode: 'mobile_drop_off'`,
  `timing: { kind: 'time_window', startsAt, endsAt, timeZone }` with all three members required and
  RFC 3339 instants where `endsAt` is not before `startsAt`, and `location: { name }` required, with
  a non-empty name that carries no leading or trailing whitespace.

`CollectionEventSchema` keeps its exported name and becomes that union, so every existing consumer
keeps compiling against the members the variants share. Add one schema per variant for producers
that need to be explicit.

These combinations must fail `CollectionEventSchema.safeParse`, rather than being merely discouraged
by convention:

- `mobile_drop_off` with an `all_day` timing;
- `mobile_drop_off` without a location, or with an empty, whitespace-only, or untrimmed location
  name;
- `mobile_drop_off` with a time window missing `startsAt`, `endsAt`, or `timeZone`;
- `curbside` with a `time_window` timing, or carrying a location;
- any unknown collection mode.

A half-populated mobile drop-off is the dangerous case: a surface would render "bring this
somewhere" without saying where or when.

`WasteTypeSchema`, the `source` values, and the field name and meaning of `date` are unchanged, so
`getUpcomingEvents`, `findReminderEvent`, and `getRelativeDateLabel` need no change; they read only
`id`, `date`, and `type`, which every variant carries. Neither `timing` nor `collectionMode` is
optional with a default: an absent value would have to be inferred as all-day, and silent inference
is what ADR 0003 exists to prevent.

Update the two producers this makes incomplete, and nothing else:

- `packages/data-providers/src/demo-provider.ts` — every demo event gains `{ kind: 'all_day' }` and
  `collectionMode: 'curbside'`. Demo identifiers, dates, and waste types are unchanged.
- `packages/domain/src/schedule.test.ts` — its event literals and its `safeParse` case gain the new
  members.

No extension file constructs or persists a `CollectionEvent`: `dashboard-view.tsx` only types a
prop, `background.ts` reads `id`, `date`, and `type`, and `AppSettingsSchema` persists waste types
only. Extension source and behavior therefore do not change.

### 2. Source metadata types

Add `packages/data-providers/src/source.ts` with the manifest, provenance, freshness, coverage, and
upstream-failure types, exported from the package root so `apps/api` can type its responses without
importing Node-only code.

### 3. Node-only retrieval and cache

Add a Node-only area, `packages/data-providers/src/node/`, reached through a new `"./node"` entry in
the package `exports` map and **never** re-exported from `src/index.ts`:

- an injectable fetch boundary typed against the Node 24 built-in `fetch`;
- bounded retrieval: a 5-second deadline for the whole retrieval including every redirect hop, not a
  fresh 5 seconds per hop; a 1 MiB response-body limit; and rejection of a content type outside the
  recorded allowlist;
- **origin-pinned, hop-bounded redirect handling.** Redirects are handled manually. The initial
  manifest URL and every redirect target must keep HTTPS, the exact manifest hostname, and the
  manifest effective port. A hop that downgrades to HTTP, changes hostname, or changes port is
  refused rather than followed. Compare the parsed origin; never a hostname substring or a
  `String.prototype.endsWith` check, which `evil-koblenz.de` would defeat. Follow at most 3 hops and
  treat a repeated target as a loop; exceeding the limit or detecting a loop stops the retrieval.
  Every one of these outcomes fails as `UPSTREAM_SOURCE_UNAVAILABLE` when no valid cached value
  exists;
- a process-local per-source cache: 6-hour fresh TTL, 7-day stale-if-error maximum, coalesced
  concurrent refreshes, preserved last-success timestamp, `freshness: "fresh" | "stale"`, and no
  manufactured stale value when no successful retrieval exists;
- an injectable clock so TTL and staleness are tested without waiting.

Add `node-ical@0.27.1` to `packages/data-providers` dependencies and to the root pnpm catalog. Use
only its string-parsing API; do not use any helper that fetches a URL.

### 4. Koblenz adapter

Add the `koblenz-servicebetrieb` adapter beside its manifest, containing all Koblenz-specific names,
URLs, and mappings.

**Timing and mode.** The timing form follows the calendar value type: an all-day `VALUE=DATE` entry
becomes an `all_day` timing, and an entry with start and end instants becomes a `time_window` timing
carrying `startsAt`, `endsAt`, and the source time zone. The collection mode follows the mapping
table. When the two disagree — a mobile-drop-off mapping arriving as an all-day entry, or the
reverse — the refresh fails, because the source has changed in a way the mapping no longer
describes. The same applies whenever upstream data cannot produce one of the valid domain variants,
for example a mobile drop-off whose entry has no `DTEND` or no usable `LOCATION`: fail the refresh
rather than emit a half-populated event or drop the entry. A curbside entry whose `LOCATION` is
neither absent nor the redundant area label fails for the same reason; see **Location** below.

**Calendar zone.** Before normalizing any timed event, require that the calendar declares exactly
one usable zone and that it equals the manifest zone. A declaration that is missing, empty,
duplicated, malformed, or different from `Europe/Berlin` fails the refresh as
`UPSTREAM_SOURCE_INVALID`. Never fall back to the manifest zone for a file that does not attest it:
the manifest value is the expectation to check, not a default to substitute, and substituting it
would apply an assumption the source has stopped supporting.

**Calendar date.** An all-day date is preserved exactly. A timed event's top-level `date` is derived
in the validated zone with `Intl.DateTimeFormat` and **`formatToParts`**, reading the `year`,
`month`, and `day` parts, with the calendar pinned to `gregory` and the numbering system to `latn`.
Never parse a formatted string, and never derive the date in UTC or in the server's local zone.

**Location.** Every `LOCATION` value is first unwrapped from any property parameters, RFC 5545
unescaped, trimmed, internally whitespace-collapsed, and Unicode NFC normalized. What happens next
depends on the timing form, because the verified source uses the property for two different things.

*Timed mobile drop-off.* The normalized name is required, must be non-empty, and is preserved as
`location.name`. An entry with no usable location fails the refresh rather than emitting a
half-populated event.

*All-day curbside.* A curbside event carries no location, because there is nowhere to go. The
property is nevertheless present on every verified curbside entry, where it repeats the collection
area:

- `LOCATION` absent — accept the entry.
- `LOCATION` present and exactly equal to the manifest `areaName`, comparing both sides after the same
  normalization — accept the entry and omit `location`, because this is only the redundant
  service-area label a response already carries as `meta.serviceArea`.
- `LOCATION` empty, whitespace-only, or different from the manifest `areaName` — fail the complete
  refresh as `UPSTREAM_SOURCE_INVALID`.

The asymmetry is deliberate. Silently discarding a curbside location that is *not* the area label
would present "bring this to a place" as "put the bin out", which is the one substitution this
ingestion must never make. Tolerating exactly the redundant label avoids failing on data the source
has published all along.

Nothing else from the source entry is exposed: `DESCRIPTION`, `UID`, and `DTSTAMP` stay internal.

**Identity.** A deterministic identifier is derived from the normalized event identity, not from its
position in the file. The identity tuple has nine members, in this fixed order, with absent members
as explicit nulls:

1. `providerId`
2. `serviceAreaId`
3. `wasteType`
4. local `date`
5. timing kind
6. `startsAt`, or null
7. `endsAt`, or null
8. `timeZone`, or null
9. normalized location name, or null

An all-day event carries nulls in members 6 to 9. `collectionMode` is not a member: the closed
variant set makes it a function of the timing kind, so it would only restate member 5.

- The canonical representation is a JSON array of those nine members in that order, so arbitrary
  official text cannot forge a boundary the way it could in a delimiter join.
- Instants are serialized in one UTC form, and the location name is NFC-normalized before hashing,
  so the same official name cannot hash two ways.
- The zone is part of identity even though the instants are absolute: the same instants under a
  different zone describe a different local appointment, so a zone change must produce a new
  identifier rather than silently reuse the old one.
- The identifier is the readable prefix `providerId-serviceAreaId-wasteType-date` followed by a
  truncated SHA-256 hex digest of the canonical representation, using `node:crypto` inside the Node
  subpath.
- The identifier is opaque; document that clients must not parse it.
- Two events differing in timing, zone, or location get different identifiers and are both returned.
  Only fully identical normalized events collapse. Do not fail a refresh over an identifier
  collision that identity-derived hashing already prevents.
- The upstream `UID` is never an identity input and never leaves the adapter except as untrusted
  source metadata in a log.

**Validation.** Every event is validated through `CollectionEventSchema`. A malformed entry, an
unmapped summary, or a validation failure fails the refresh instead of producing a partial schedule.

### 5. API wiring

- Extend `ProviderSourceKindSchema` with `official_ics` and register the official provider in the
  catalogue with its verified service area.
- Add the collection-events route with its request and response schemas, range filtering, and
  transport mapping (`districtId` → `serviceAreaId`, `type` → `wasteType`).
- Filter by the top-level local `date`, not by instant, so a timed event belongs to the day a person
  would look for it under.
- Expose `timing`, `collectionMode`, and `location` on each event.
- Reject an unknown service area for a known provider with `SERVICE_AREA_NOT_FOUND`.
- Keep the demo provider listed and labelled as demo data.

### 6. Error contract and documentation

- Extend `problemCatalogue` and `ProblemCode` with the codes in the error contract below, each with
  a fixed diagnostic `detail` that interpolates no request input and no upstream payload.
- Document success, fresh, stale, validation, both not-found cases, range, invalid-upstream, and
  unavailable-upstream responses in the generated OpenAPI contract with realistic examples.
- Document the event as a `oneOf` discriminated on `collectionMode`, one branch per supported
  variant, so the contract shows which fields travel together instead of listing independent
  optionals. The curbside branch has an `all_day` timing and no location; the mobile-drop-off branch
  requires the window, the zone, and the location. Give each branch its own example and describe the
  invalid combinations the API will never return.

### 7. Tests

Add a `vitest` configuration, `test`, and `test:watch` scripts to `packages/data-providers`,
mirroring `packages/domain`. Cover everything in [Test requirements](#test-requirements).

### 8. Documentation updates

Update `apps/api/README.md` (new route, new provider, timing forms, new error codes),
`packages/data-providers/README.md` (the `./node` boundary and why it exists), and the provider
section of `docs/architecture/repository-structure.md` if the implemented boundary reveals a gap. Do
not restate the ADR; link it.

## Non-goals

- Migrating the browser extension to the API or to `@abfall-radar/api-client`.
- Any change to extension product behavior, its default district, or its persisted settings.
- Generating `@abfall-radar/api-client` or any client code.
- Web application or mobile application work.
- Cataloguing every Koblenz collection area.
- Generating, estimating, or inferring `residual` or `bio` events, odd/even week rules, or holiday
  shifts.
- Recurrence or `RRULE` support: the verified source contains none.
- A time-zone library. `Intl` is built in and sufficient.
- Exposing `UID`, `DTSTAMP`, `DESCRIPTION`, or any other upstream field beyond the normalized
  timing, mode, and location.
- Presenting a mobile drop-off as if it were a curbside collection, or the reverse.
- Addresses, geocoding, map data, or recycling-point endpoints.
- Database, migrations, Redis, another shared cache, or scheduled refresh jobs.
- Authentication, accounts, or cross-device synchronization.
- Deployment, container images, CI deployment, rate limiting, or a monitoring backend.
- Any product UI or design-system change.
- Any domain change beyond the timing, mode, and location members described in scope step 1.

## HTTP contract

```text
GET /api/v1/providers/{providerId}/service-areas/{serviceAreaId}/collection-events
    ?from=YYYY-MM-DD&to=YYYY-MM-DD
```

`providerId` and `serviceAreaId` reuse the existing transport constraint: lowercase ASCII letters
and digits with internal hyphens, starting and ending alphanumeric, at most 64 characters. A
violation is `400`; a well-formed but unregistered value is `404`.

`from` and `to` are required ISO calendar dates. `from` must not be after `to`, and the inclusive
range must not exceed 366 days. Events are filtered on their local `date`.

An event is one of two variants, discriminated by `collectionMode`. A curbside event has an
`all_day` timing and no location. A mobile-drop-off event has a `time_window` timing with
`startsAt`, `endsAt`, and `timeZone`, plus a location. No other combination exists in the contract,
so a client can switch on `collectionMode` and rely on the rest of the shape.

In the examples below, the timed event, its window, its location, and every official summary are
verified values. The all-day event's date is illustrative, because all-day collection dates were not
recorded during verification, and the hash suffixes are illustrative rather than computed.

### Fresh success

```json
{
  "data": [
    {
      "id": "koblenz-servicebetrieb-koblenz-stadtmitte-paper-2026-08-14-9f2c1d7ab3e45608",
      "serviceAreaId": "koblenz-stadtmitte",
      "wasteType": "paper",
      "date": "2026-08-14",
      "title": "Altpapier",
      "source": "municipal_ics",
      "collectionMode": "curbside",
      "timing": { "kind": "all_day" }
    },
    {
      "id": "koblenz-servicebetrieb-koblenz-stadtmitte-hazardous-2026-03-21-4b81e0c6f2a97d35",
      "serviceAreaId": "koblenz-stadtmitte",
      "wasteType": "hazardous",
      "date": "2026-03-21",
      "title": "Schadstoffe / Elektrokleinteile",
      "source": "municipal_ics",
      "collectionMode": "mobile_drop_off",
      "timing": {
        "kind": "time_window",
        "startsAt": "2026-03-21T10:00:00Z",
        "endsAt": "2026-03-21T12:00:00Z",
        "timeZone": "Europe/Berlin"
      },
      "location": { "name": "Rizzastraße Ecke Südallee" }
    }
  ],
  "meta": {
    "provider": {
      "id": "koblenz-servicebetrieb",
      "name": "Kommunaler Servicebetrieb",
      "sourceKind": "official_ics"
    },
    "serviceArea": {
      "id": "koblenz-stadtmitte",
      "locality": "Koblenz",
      "name": "Stadtmitte"
    },
    "source": {
      "name": "Kommunaler Servicebetrieb",
      "landingPageUrl": "https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/",
      "attribution": "Kommunaler Servicebetrieb, Koblenz",
      "timeZone": "Europe/Berlin"
    },
    "retrievedAt": "2026-07-29T08:14:02.000Z",
    "validFrom": "2026-01-01",
    "validTo": "2026-12-31",
    "freshness": "fresh",
    "coverage": {
      "wasteTypes": [
        "paper",
        "yellow_bag",
        "green_waste",
        "christmas_tree",
        "hazardous",
        "small_electronics"
      ]
    },
    "range": { "from": "2026-01-01", "to": "2026-12-31" }
  }
}
```

The same combined source entry also produces a `small_electronics` event with identical `date`,
`timing`, `collectionMode`, and `location`. Only `wasteType` differs, so identity differs and the
two identifiers differ.

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
| `UPSTREAM_SOURCE_INVALID` | 502 | `urn:abfall-radar:problem:upstream-source-invalid` | The source was retrieved but is unusable — content type outside the allowlist, body limit exceeded, RFC parse failure, a calendar zone that is missing, empty, duplicated, malformed, or not the manifest zone, unknown or unmapped summary, timing and mode disagreement, an entry that cannot produce a valid event variant, or domain validation failure — and no valid cached value exists |
| `UPSTREAM_SOURCE_UNAVAILABLE` | 503 | `urn:abfall-radar:problem:upstream-source-unavailable` | The source could not be retrieved — the retrieval deadline elapsed, a connection error, a non-2xx status, a redirect that leaves the manifest origin by downgrading to HTTP or changing hostname or port, more than 3 redirect hops, or a redirect loop — and no valid cached value exists |
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
  "instance": "/api/v1/providers/koblenz-servicebetrieb/service-areas/koblenz-stadtmitte/collection-events?from=2026-03-01&to=2026-03-31",
  "code": "UPSTREAM_SOURCE_UNAVAILABLE",
  "requestId": "req-1"
}
```

Every response, success or failure, carries an `x-request-id` header. For a Problem Details response
it equals the body's `requestId`, and the same value appears as `requestId` on that request's
structured log line.

## Acceptance criteria

### Source control and boundaries

- [ ] The manifest holds exactly the values in the source verification record, including the allowed
      origin, accepted content type, source time zone, validity window, and declared waste types.
- [ ] The manifest URL and every redirect target are checked against the approved origin: HTTPS, the
      exact hostname, and the approved effective port. The check compares parsed origins, not
      hostname substrings or suffixes.
- [ ] At most 3 redirect hops are followed, a repeated target is treated as a loop, and the 5-second
      budget is a deadline for the whole retrieval rather than a fresh timeout per hop.
- [ ] The manifest URL is the stable no-query form; no `cid` value appears in the manifest, in any
      response, or in any test.
- [ ] No request parameter, header, or body can influence the upstream URL or host.
- [ ] No runtime code fetches an HTML page or a PDF.
- [ ] All Koblenz-specific names, URLs, and mappings live inside the provider adapter.
- [ ] Node-only provider code is reachable only through `@abfall-radar/data-providers/node` and is
      not reachable from the package root export.
- [ ] Only the `node-ical` string-parsing API is used; no library helper fetches a URL.

### Domain and demo provider

- [ ] `CollectionEventSchema` accepts the all-day curbside variant and the timed mobile-drop-off
      variant.
- [ ] `CollectionEventSchema` rejects every invalid combination listed in scope step 1: a mobile
      drop-off with an all-day timing, without a location, or with an empty, whitespace-only, or
      untrimmed location name; a mobile drop-off whose window is missing `startsAt`, `endsAt`, or
      `timeZone`, or whose `endsAt` precedes its `startsAt`; a curbside event carrying a window or a
      location; and an unknown collection mode.
- [ ] `WasteTypeSchema`, the `source` values, and the name and meaning of `date` are unchanged.
- [ ] Demo events carry an all-day timing and a curbside mode, with unchanged identifiers, dates,
      and waste types.
- [ ] No file under `apps/extension` is modified, and the extension's behavior and persisted
      settings are unchanged.
- [ ] `pnpm --filter @abfall-radar/domain test` and `pnpm --filter @abfall-radar/extension test`
      pass.

### Contract behavior

- [ ] `GET /api/v1/providers` lists `koblenz-servicebetrieb` with `sourceKind: "official_ics"` and
      still lists the demo provider with `sourceKind: "demo"`.
- [ ] `GET /api/v1/providers/koblenz-servicebetrieb/service-areas` returns the verified area with
      official naming.
- [ ] The collection-events route returns documented fresh events with full provenance for a range
      inside the validity window.
- [ ] An all-day event exposes an all-day timing and a curbside mode and no location, including when
      the upstream entry carried the redundant area label in `LOCATION`.
- [ ] A timed event exposes `startsAt`, `endsAt`, `timeZone`, a mobile-drop-off mode, and a trimmed
      location name.
- [ ] `coverage.wasteTypes` comes from the manifest and is never derived from the returned events.
- [ ] An empty in-range result returns `200` with an empty `data` array and unchanged coverage.
- [ ] Events are filtered on their local `date`, not on their instant.
- [ ] Missing `from`, missing `to`, a non-ISO date, `from` after `to`, and a range over 366 days
      each return the documented `400`.
- [ ] Each error in the error contract is reachable and returns exactly its documented status,
      `type`, and `code`.
- [ ] No response contains `UID`, `DTSTAMP`, `DESCRIPTION`, an upstream URL, an upstream payload, a
      stack trace, or a library error message.
- [ ] Response schemas prevent an undocumented field from being serialized.
- [ ] Every response carries `x-request-id`, and every Problem Details body's `requestId` matches
      it.

### Ingestion behavior

- [ ] An all-day event yields the same calendar date regardless of the process time zone.
- [ ] A timed event yields its `Europe/Berlin` calendar date, derived with `formatToParts`, and the
      two verified windows resolve to `2026-03-21` and `2026-11-07`.
- [ ] The combined entry yields two events, `hazardous` and `small_electronics`, sharing date,
      timing, mode, and location, with different identifiers.
- [ ] Counts are asserted at the right level: upstream `VEVENT` entries and normalized
      `CollectionEvent` values are never conflated. For the source as verified on 2026-07-29, 46
      upstream entries normalize into 48 events — 44 all-day and 4 timed — with 48 distinct
      waste-type-and-date pairs and no collision. This is confirmed by manual verification, because
      no automated test may reach the network.
- [ ] Identifiers are byte-identical across repeated refreshes of unchanged source content and
      across process time zones.
- [ ] The identity tuple contains all nine members in the documented order, with nulls for members 6
      to 9 on an all-day event, and `collectionMode` is not a member.
- [ ] Two events with the same waste type and date but a different window, zone, or location receive
      different identifiers and are both returned.
- [ ] Fully identical normalized events collapse to one.
- [ ] No refresh fails because of an identifier collision.
- [ ] Identifiers are documented as opaque, and no client-facing documentation invites parsing them.
- [ ] A malformed event, an unmapped summary, a timing and mode disagreement, or a domain-validation
      failure fails the refresh and produces no partial schedule.
- [ ] Retrieval aborts at the 5-second deadline and at 1 MiB.
- [ ] A same-origin HTTPS redirect is followed; an HTTP downgrade, a hostname change, and a port
      change are each refused and reported as `UPSTREAM_SOURCE_UNAVAILABLE`.
- [ ] A chain of 3 same-origin hops succeeds; a fourth hop and a redirect loop each stop retrieval
      and report `UPSTREAM_SOURCE_UNAVAILABLE`.
- [ ] The calendar's declared zone is validated against the manifest zone before any timed event is
      normalized, and a missing, empty, duplicated, malformed, or mismatching declaration fails the
      refresh as `UPSTREAM_SOURCE_INVALID`.
- [ ] No code path falls back to the manifest zone when the calendar does not attest it.
- [ ] A curbside entry with no `LOCATION`, or with a `LOCATION` equal to the manifest `areaName` after
      unescaping, trimming, whitespace collapse, and NFC normalization, is accepted, and the event
      exposes no location.
- [ ] A curbside entry whose `LOCATION` is empty, whitespace-only, or any value other than the manifest
      `areaName` fails the complete refresh as `UPSTREAM_SOURCE_INVALID`. No differing curbside location
      is ever silently discarded.
- [ ] An upstream entry that cannot produce a valid event variant fails the refresh rather than
      producing a half-populated event or silently dropping the entry.
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
- [ ] OpenAPI documents the event as a `oneOf` discriminated on `collectionMode`, with an example
      per branch, and no branch that permits an incomplete mobile drop-off.
- [ ] Swagger UI at `/docs` and `/openapi.json` show the operation and every documented response.
- [ ] `apps/api/README.md` and `packages/data-providers/README.md` describe the new route, provider,
      timing forms, error codes, and the `./node` boundary.
- [ ] No municipal calendar file is committed and no test performs network access.
- [ ] `pnpm --filter @abfall-radar/extension build` succeeds and extension behavior is unchanged.
- [ ] `pnpm --filter @abfall-radar/api build` succeeds with `node-ical` bundled and the existing
      externals guard still passing.
- [ ] `pnpm check` passes.

## Test requirements

All tests use small synthetic ICS fixtures written for this repository and a mocked fetch boundary.

Domain, in `packages/domain`:

- [ ] an all-day curbside event is accepted;
- [ ] a timed mobile drop-off with a full window and a location is accepted;
- [ ] a mobile drop-off with an `all_day` timing is rejected;
- [ ] a mobile drop-off without a location is rejected;
- [ ] a mobile drop-off with an empty or whitespace-only location name is rejected;
- [ ] a mobile drop-off with an untrimmed location name is rejected;
- [ ] a time window missing `startsAt`, `endsAt`, or `timeZone` is rejected;
- [ ] a time window whose `endsAt` precedes its `startsAt` is rejected;
- [ ] a curbside event carrying a `time_window` timing is rejected;
- [ ] a curbside event carrying a location is rejected;
- [ ] an unknown collection mode is rejected;
- [ ] the existing schedule rules keep working against both variants.

Parsing, timing, and identity, in `packages/data-providers`:

- [ ] a minimal valid calendar parses into the expected events;
- [ ] folded lines are unfolded correctly;
- [ ] escaped characters (`\,`, `\;`, `\n`, `\\`) resolve correctly;
- [ ] a leading UTF-8 BOM is handled;
- [ ] a calendar declaring exactly `Europe/Berlin` is accepted;
- [ ] a calendar with no declared zone is rejected, and the failure maps to invalid rather than
      unavailable;
- [ ] a calendar with an empty, duplicated, or malformed declared zone is rejected;
- [ ] a calendar declaring another zone, such as `Europe/Paris`, is rejected rather than normalized
      against the manifest zone;
- [ ] a timed event close to midnight derives its local date only after zone validation succeeds, so
      a fixture with a bad zone produces no event at all rather than a plausible date;
- [ ] all-day `VALUE=DATE` events keep their calendar date, asserted with the test process pinned to
      a non-UTC time zone in both hemispheres of UTC;
- [ ] UTC timed events convert to the correct `Europe/Berlin` calendar date;
- [ ] a synthetic timed event at `2026-06-30T22:30:00Z` yields the local date `2026-07-01`, so a UTC
      or server-local derivation fails the test;
- [ ] `startsAt`, `endsAt`, `timeZone`, and `collectionMode` are preserved exactly;
- [ ] a location name with a trailing space and a doubled internal space is trimmed and collapsed;
- [ ] with the process time zone pinned to `Europe/Berlin`, a one-day all-day event crossing the
      spring-forward boundary and one crossing the fall-back boundary are both accepted, and an omitted
      `DTEND` on the fall-back date is accepted, so an elapsed-time span check fails the test;
- [ ] a multi-day all-day span is still rejected, and an end date before the start date is rejected,
      which an elapsed-time comparison against 24 hours would let through;
- [ ] a curbside entry with no `LOCATION` is accepted and exposes no location;
- [ ] a curbside entry whose `LOCATION` is exactly the manifest `areaName` is accepted and exposes no
      location;
- [ ] the same area label with surrounding whitespace, a doubled internal space, and an equivalent NFD
      spelling is accepted, so an encoding difference nobody can see cannot take a source out;
- [ ] a curbside entry with an empty or whitespace-only `LOCATION` fails the refresh;
- [ ] a curbside entry whose `LOCATION` is a different place, such as a street corner, fails the refresh
      rather than being silently discarded, and one such entry fails the whole refresh rather than being
      dropped from an otherwise complete schedule;
- [ ] a whitespace variant that would collapse across a word boundary, such as `Stadt  mitte` against
      `Stadtmitte`, still fails;
- [ ] the same street-corner value that a curbside entry is rejected for is preserved on a timed
      mobile-drop-off entry;
- [ ] one combined upstream event produces two normalized events;
- [ ] a fixture with two combined entries on different dates produces four timed events with four
      distinct identifiers, so an upstream entry count is never mistaken for a normalized event
      count;
- [ ] those two events have distinct deterministic identifiers and identical timing and location;
- [ ] two events with the same waste type and date but different windows get different identifiers;
- [ ] two events with the same waste type, date, and window but different `timeZone` values get
      different identifiers, so dropping the zone from the tuple fails the test;
- [ ] two events with the same waste type, date, and window but different locations get different
      identifiers;
- [ ] identifiers are stable across two parses and across process time zones;
- [ ] a location name supplied in NFD yields the same identifier as the same name in NFC;
- [ ] fully identical events collapse to one;
- [ ] a malformed event fails the refresh;
- [ ] an unknown summary fails the refresh;
- [ ] a mobile-drop-off mapping arriving as an all-day entry fails the refresh;
- [ ] a mobile-drop-off entry with no end instant fails the refresh;
- [ ] a mobile-drop-off entry with no location fails the refresh;
- [ ] no upstream `UID` appears in a normalized event.

Retrieval and cache, in `packages/data-providers`:

- [ ] a retrieval exceeding the 5-second deadline aborts and reports unavailable;
- [ ] the deadline covers a redirect chain as a whole, so hops that are individually fast but
      collectively slow still abort;
- [ ] a body exceeding 1 MiB aborts and reports invalid;
- [ ] the verified single same-origin HTTPS hop is followed;
- [ ] a chain of 3 same-origin hops is followed;
- [ ] a chain of 4 hops stops and reports unavailable;
- [ ] a same-origin redirect loop stops and reports unavailable;
- [ ] a redirect that downgrades to HTTP is refused and reports unavailable;
- [ ] a redirect to another hostname is refused and reports unavailable, including a hostname that
      merely ends with the approved one;
- [ ] a redirect to another port on the approved hostname is refused and reports unavailable;
- [ ] a content type outside the allowlist is rejected, and the response body is cancelled exactly once
      without being consumed, asserted with a streaming body carrying a cancellation spy;
- [ ] a cancellation that itself throws does not change the reported reason;
- [ ] every other branch that abandons a response before consuming it — a followed redirect, a refused
      redirect, a non-2xx status, an over-limit `Content-Length`, and a stream crossing the limit —
      cancels the body or the reader;
- [ ] a non-2xx status reports unavailable;
- [ ] a second call inside the fresh TTL does not call fetch;
- [ ] concurrent calls coalesce into one fetch;
- [ ] a failed refresh returns the cached value with `freshness: "stale"` and the preserved
      `retrievedAt`;
- [ ] a failed refresh with no cached value returns a failure and no stale value;
- [ ] a cached value past the 7-day maximum is not served.

Contract, in `apps/api`:

- [ ] the fresh success response, its schema, and its provenance;
- [ ] both variants serialized as documented, including the trimmed location and the absence of a
      location on a curbside event;
- [ ] the stale success response and its structured warning log, asserted with the existing log
      collector;
- [ ] range filtering at both inclusive boundaries, including a timed event at a boundary;
- [ ] every validation rejection listed in the acceptance criteria;
- [ ] `PROVIDER_NOT_FOUND`, `SERVICE_AREA_NOT_FOUND`, `SCHEDULE_RANGE_NOT_COVERED`,
      `UPSTREAM_SOURCE_INVALID`, `UPSTREAM_SOURCE_UNAVAILABLE`, and a sanitized
      `INTERNAL_SERVER_ERROR`;
- [ ] `x-request-id` present on success and matching `requestId` on every Problem Details response;
- [ ] the provider catalogue and service-area routes still return the demo provider unchanged.

## Verification

Automated:

```bash
pnpm --filter @abfall-radar/domain test
pnpm --filter @abfall-radar/data-providers test
pnpm --filter @abfall-radar/api test
pnpm --filter @abfall-radar/api typecheck
pnpm --filter @abfall-radar/api build
pnpm --filter @abfall-radar/extension test
pnpm --filter @abfall-radar/extension build
pnpm check
```

Manual scenarios, with `pnpm dev:api` running:

```bash
BASE="http://localhost:3000/api/v1/providers/koblenz-servicebetrieb/service-areas"
AREA="koblenz-stadtmitte"
curl --fail-with-body http://localhost:3000/api/v1/providers
curl --fail-with-body "http://localhost:3000/api/v1/providers/koblenz-servicebetrieb/service-areas"
curl --fail-with-body "$BASE/$AREA/collection-events?from=2026-03-01&to=2026-03-31"
curl --fail-with-body "$BASE/$AREA/collection-events?from=2026-11-01&to=2026-11-30"
curl --include "$BASE/$AREA/collection-events?from=2026-03-31&to=2026-03-01"
curl --include "$BASE/$AREA/collection-events?from=2025-01-01&to=2025-12-31"
curl --include "$BASE/unknown-area/collection-events?from=2026-03-01&to=2026-03-31"
curl --include "$BASE/$AREA/collection-events?from=2026-03-01"
```

- Confirm the March and November responses each contain the mobile drop-off with the window,
  `Europe/Berlin`, and the trimmed location, and that the `hazardous` and `small_electronics` events
  share timing and location while carrying different identifiers.
- Retrieve the exact official calendar URL once by hand and confirm the status, content type, size,
  and waste types still match the source verification record, that the chain is still one
  same-origin hop, and that the file still declares exactly one `Europe/Berlin` zone. Do not commit
  the file or any excerpt of its schedule.
- Compare the API response against that retrieval and confirm the dates, windows, and waste types
  agree.
- Request the full validity window and confirm the response holds 48 events for the source as
  verified — 44 all-day and 4 timed — against 46 upstream `VEVENT` entries, and that no two events
  share a waste type and date. A count of 46 would mean the combined entries were not expanded.
- Confirm a second identical request inside the TTL performs no upstream request, using the API's
  structured logs.
- Force a retrieval failure — point the manifest host at an unreachable local address in a scratch
  run — and confirm the response is a labelled stale `200` with a warning log while a cached value
  exists, and a `503` once none does.
- Open `http://localhost:3000/docs`, execute the new operation, and confirm both timing branches and
  every documented response are present.
- Open `http://localhost:3000/openapi.json` and confirm it matches the interactive reference.
- Load the built extension and confirm its dashboard and settings behave exactly as before.

## Risks and decisions

- **The domain contract change is the notable one.** It is required because the verified source
  contains a timed mobile drop-off that a date-only model cannot represent without discarding
  official window, location, and mode semantics. It is bounded to three additive members, and its
  ripple is two producer files. If it grows beyond that during implementation, stop and ask.
- **The variant set is closed.** Only all-day curbside and timed mobile drop-off exist, because only
  those are verified. Adding a third variant later is a contract change for every client that
  switches on `collectionMode`, which is the intended cost of making invalid combinations
  unrepresentable.
- **Origin pinning is stricter than the source needs today.** The verified redirect stays on the
  same origin, so nothing legitimate is lost; the rule exists so a future upstream change cannot
  quietly move retrieval to another host, another port, or plain HTTP. The 3-hop limit leaves the
  operator room to add a hop without an outage while still refusing an endless chain.
- **Zone attestation is a hard dependency.** If the operator stops publishing a declared zone, or
  publishes a different one, ingestion stops for that source until the manifest is re-verified. That
  is the intended trade: a silent fallback to the manifest zone would shift every timed date by a
  day the moment the assumption stopped holding, and nothing would signal it.
- **Identity covers the whole normalized event.** All nine tuple members contribute, including the
  zone, so any change a person would notice — a moved date, a retimed window, a corrected zone, a
  relocated drop-off — yields a new identifier instead of silently reusing the old one.
- **Identifiers are hashed, so they are opaque.** They cannot be read as a date-and-type pair while
  debugging, and an occurrence the source moves or re-times becomes a new identifier. The readable
  prefix mitigates the first; the second is inherent to identifying an occurrence by what it is.
- **Digest truncation.** A truncated SHA-256 is documented as collision-negligible at this scale. If
  a future source makes that assumption uncomfortable, lengthening the digest changes every
  identifier and is a contract change, not a tweak.
- **Upstream fragility.** A changed URL, renamed area, retimed collection, or new event wording
  breaks one source. This is deliberate: failing loudly beats a silently shortened schedule. The
  source being a third-party calendar export raises this risk.
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
- **Derived rather than attested facts.** The area name and validity window come from the URL path
  and the landing page, because `X-WR-CALNAME` is the character `2`. If the operator republishes the
  file under a different path, that derivation has to be re-verified.
- **Residual and bio remain absent.** The source covers six waste types and neither of those two.
  Nothing here generates the odd/even week or holiday-shift rules from the printed guide.
- **Range semantics.** `SCHEDULE_RANGE_NOT_COVERED` is derived from declared validity only, so a
  source that legitimately contains no collection in a covered range returns an empty list rather
  than an error.

## Approved implementation clarifications

- Date: 2026-07-29
- Approved by: repository owner
- Scope: task-level implementation detail only. ADR 0003 is unchanged except where noted in item 5,
  which narrows one of its statements rather than reversing it.

### 1. New problem code for a provider without an official calendar

The error contract above has no code for a registered provider that publishes no official calendar for
an area, which is exactly what `GET /api/v1/providers/demo/service-areas/{serviceAreaId}/collection-events`
is. `COLLECTION_EVENTS_NOT_AVAILABLE` is added with status `404` and type
`urn:abfall-radar:problem:collection-events-not-available`.

`404` because the resource does not exist for that pair; `501` would claim the whole server lacks the
capability. Serving demo events instead was rejected: it would require inventing a retrieval time and a
validity window, which is demo data in official clothing.

### 2. Range coverage means fully contained

`SCHEDULE_RANGE_NOT_COVERED` is returned unless the requested range lies entirely inside the declared
validity window. A range straddling the boundary is rejected rather than answered in part, so a
response is never silently incomplete.

### 3. Provider-runtime dependency seam in `apps/api`

`provider-catalogue.ts` exposes `createProviderCatalogue(runtime)` instead of a module-level constant,
and `buildApp` accepts an optional `providerRuntime` of `{ fetch, clock }` and decorates the built
catalogue onto the instance. `listProviders` and `findProviderEntry` take the catalogue as a parameter.

This is what makes stale responses, an initial `502` and `503`, cache expiry, and refresh coalescing
deterministically testable. Both members default to the real implementations, so production configures
nothing, and no production-only switch, mutable global, environment backdoor, or manifest override was
added.

### 4. Dependency and manifest changes

- `node-ical` `0.27.1` added to the root pnpm catalog and to `packages/data-providers` dependencies.
- `@types/node` and `vitest` added to `packages/data-providers` development dependencies, both already
  in the catalog. `@types/node` is required for `node:crypto` typings in the `./node` boundary.
- `packages/data-providers` gains a `"./node"` entry in its `exports` map plus `test` and `test:watch`
  scripts, and its `tsconfig.json` gains `"types": ["node"]`.
- `pnpm-lock.yaml` gains `node-ical` and four transitive packages: `rrule-temporal`,
  `temporal-polyfill`, `temporal-spec`, and `temporal-utils`. None is declared directly and none has a
  peer dependency, so `strict-peer-dependencies` needed no exception.

No other dependency was added. `apps/api` declares nothing new: `node-ical` is bundled, so the build's
external allowlist is unchanged.

### 5. A digest collision fails the refresh

This narrows two statements above: "Do not fail a refresh over an identifier collision that
identity-derived hashing already prevents" in scope step 4, and the acceptance criterion "No refresh
fails because of an identifier collision".

Identity-derived hashing prevents a *semantic* collision — two events that differ in what they are can
never be handed the same identity tuple. It does not prevent a **truncated digest** collision between
two different canonical identities. That is negligible at this scale but not impossible, and collapsing
it would silently drop a real collection, which is the failure mode ADR 0003 exists to prevent.

The rule implemented is therefore: equal identifier **and** equal canonical identity collapse; equal
identifier and **different** canonical identity fails the refresh. No new public problem code — a new
internal reason `identity-collision` maps to the existing `UPSTREAM_SOURCE_INVALID` `502`. The identity
module accepts an injected digest function, defaulting to the real truncated SHA-256, so the collision
path is covered by a deterministic test rather than left unexercised.

### 6. One 404 response, not three

An OpenAPI operation permits a single entry per status code, so registering `PROVIDER_NOT_FOUND`,
`SERVICE_AREA_NOT_FOUND`, and `COLLECTION_EVENTS_NOT_AVAILABLE` as three 404 responses would have them
overwrite each other. The operation documents one 404 whose schema is a `oneOf` over the three,
discriminated on `code`, with a named example for each.

### 7. Failure scenarios are verified by injected tests, not by the manual boot

This replaces the manual step "Force a retrieval failure — point the manifest host at an unreachable
local address in a scratch run". Forcing cache age, an upstream failure, or an empty cache against a
production artifact would require either a six-hour wait or a production-only switch.

Stale `200`, an initial `502` and `503`, cache expiry, and refresh coalescing are covered by tests using
the injected fetch and clock. The manual production boot check verifies what a real artifact can honestly
show: that `dist/server.js` starts, that health, documentation, and the OpenAPI document work, that the
official happy path works, that range and not-found responses work, that a second identical request
returns the identical `retrievedAt`, and that shutdown is graceful.

### 8. Additional loud failures in the adapter

Three guards beyond the letter of the original scope were added, each preventing a silently incomplete
schedule rather than adding a feature:

- **A positive window is required for a mobile drop-off**, not merely a present end instant. `node-ical`
  synthesizes an end equal to the start when a source attests no `DTEND`, so "no window" and
  "zero-length window" are indistinguishable, and neither is actionable. Asserting only a missing `end`
  would have passed against the synthesized value.
- **An all-day entry spanning more than one calendar day fails**, because emitting a single event for it
  would under-report the collection. The span is measured in **whole calendar days**, using
  `differenceInCalendarDays` from the `date-fns` dependency the package already declares — never
  `differenceInDays`, `differenceInMilliseconds`, or a 24-hour constant. A one-day all-day event is 23
  hours long across a spring-forward date and 25 across a fall-back one, so an elapsed-time comparison
  both rejects a valid event across the fall-back date and accepts an end date that precedes its start.
  A zero-day and a one-day span are both accepted: for a `VALUE=DATE` entry with no `DTEND` the parser
  applies the RFC 5545 one-day default rather than setting the end equal to the start, so the check stays
  independent of which defaulting rule applied. This comparison is the only place calendar-day arithmetic
  is used; the normalized event date is still read from the local components directly. The timed
  mobile-drop-off window remains an instant comparison, which is the correct semantics for two instants.
- **Entries sharing a `UID` fail.** The parse result is keyed by `UID`, so duplicates would collapse and
  shorten the schedule; the raw `VEVENT` count is compared against the parsed count to catch it.

The curbside `LOCATION` rule went through two wrong answers before the current one, which is worth
recording because both failure modes are tempting:

1. **Rejecting any curbside `LOCATION`** was implemented first. It rejected the entire verified source:
   all 44 all-day entries carry `LOCATION:Stadtmitte`.
2. **Ignoring any curbside `LOCATION`** replaced it. That passed the live source but would silently
   discard a genuine place if the operator ever put one there — presenting "bring this somewhere" as
   "put the bin out".

The rule now implemented is the narrow exception: accept an absent `LOCATION`, accept one that is
exactly the manifest `areaName` after unescaping, trimming, whitespace collapse, and NFC normalization,
and fail the complete refresh on anything else. Scope step 4 **Location**, the source verification
record, the acceptance criteria, and the test requirements above were all updated to state this, so the
task no longer contradicts this clarification.

### 9. Runtime validation of the parse result uses type guards, not Zod

`packages/data-providers` does not declare `zod`, and adding it would exceed the dependency changes
approved in item 4. The `node-ical` result is narrowed with explicit hand-written guards instead. Every
normalized event is still validated through `CollectionEventSchema`, which the domain owns.

### 10. `timeZone` is not IANA-validated in the domain

`packages/domain` validates `timing.timeZone` as a non-empty string only. Adding a resolvability check
would put `Intl` inside the domain, and the official adapter already requires the zone to equal the
attested manifest zone before any event is constructed.

## Implementation boundaries

- Implement only this task. Ask before adding a dependency beyond `node-ical@0.27.1` and the
  `vitest` configuration for `packages/data-providers`, before changing a public contract beyond the
  additions above, or before expanding scope.
- The only permitted `packages/domain` change is the timing, mode, and location addition in scope
  step 1, plus its test updates.
- The only permitted demo-provider change is the additive all-day and curbside metadata.
- Do not modify any file under `apps/extension`.
- Do not commit any municipal calendar file, excerpt, or downloaded fixture. Keep `cid` values out
  of the manifest, the source code, and the tests; the source verification record above is the only
  place a `cid` observation belongs.
- All code, comments, documentation, examples, and identifiers are written in English.

Implementation starts only after this task and
[ADR 0003](../decisions/0003-official-schedule-ingestion.md) are reviewed, committed, and pushed,
because Codex discovers task context from the repository rather than from a prompt.