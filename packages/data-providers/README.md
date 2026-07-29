# Data providers

Provider contracts and adapters that translate external municipal data into domain models.

Provider code may understand a source format or municipality. Consumers must depend on provider
contracts and normalized domain data rather than provider-specific fields.

See [ADR 0003](../../docs/decisions/0003-official-schedule-ingestion.md) for the ingestion decisions
this package implements.

## Two entry points

| Import | Contains | Safe in a browser bundle |
| --- | --- | --- |
| `@abfall-radar/data-providers` | The `ScheduleProvider` contract, the demo provider, and the source metadata types | Yes |
| `@abfall-radar/data-providers/node` | Bounded retrieval, RFC 5545 parsing, identity hashing, caching, and the official municipal adapters | No |

The split exists because the browser extension resolves the package root. Official ingestion needs
`node:crypto` and a calendar parser, and neither belongs in a browser bundle: it would grow the
extension, put a third-party parser inside the extension's trust boundary, and imply that a client
parses municipal formats when the whole point of the API is that none of them do.

`src/index.ts` therefore never re-exports anything under `src/node/`.
`src/browser-boundary.test.ts` walks the root export's static import graph and fails if a `node:`
built-in, the calendar parser, or any module under `./node/` becomes reachable — a stray `export *`
would otherwise pass every other test.

## The source catalogue

The set of ingestible sources is data the server owns. A **source manifest** records, per service
area, the exact allowlisted HTTPS calendar URL, the allowed origin as scheme, hostname, and effective
port, the official area name, the operator name and attribution, the public landing page, the validity
window, the accepted content types, the zone the calendar must attest, and the waste types the source
declares.

Every manifest value comes from a manual verification of the real source. None is inferred from a URL
pattern, a naming convention, or another area's entry, so adding an area is a verification step rather
than a configuration guess.

A client may select a provider and a service area. It can never supply, influence, or override an
upstream URL, host, or path: no request parameter, header, or body reaches the retrieval boundary.

## Trust boundaries

Every byte from a municipal host is untrusted input and crosses these checks before it becomes a
domain event.

| Boundary | Rule |
| --- | --- |
| Retrieval | One 5-second deadline for the whole retrieval, a 1 MiB response-body limit, and only the manifest origin |
| Redirects | At most 3 hops, each keeping HTTPS, the exact hostname, and the effective port; a repeated target is a loop |
| Content type | Only the narrow set recorded during verification |
| Calendar zone | Exactly one usable declared zone, and it must equal the manifest zone |
| Structure | RFC 5545 parsing, then domain validation of every normalized event |

The allowlist is an **origin**, not a hostname, and it is compared as parsed components. A
`hostname.endsWith('koblenz.de')` check would be satisfied by `evil-koblenz.de`, and a bare hostname
comparison would still permit an HTTP downgrade or a different port on the same name.

The 5 seconds are a deadline for the entire retrieval rather than a fresh timeout per hop, so a chain
of individually fast responses cannot add up to an unbounded wait.

Every branch that abandons a response before consuming it — a redirect it follows or refuses, a non-2xx
status, a rejected content type, an over-limit `Content-Length`, or a stream that grows past the limit —
cancels the body or the reader first, so a refused response never leaves a socket open. Those
cancellations deliberately swallow their own failures: the failure *reason* is contract-visible, since it
decides whether a client sees a `502` or a `503`, and a cleanup error must never replace it with an
incidental one.

The declared calendar zone is checked for **equality** with the manifest zone and is never substituted
by it. Falling back would apply an assumption the source has stopped supporting, which is exactly how
every timed date in a schedule shifts by a day with nothing to signal it.

## Failing loudly

An unmapped event summary, a malformed entry, a timing and mode disagreement, a missing window or
location on a mobile drop-off, or a domain-validation failure fails the **whole** refresh. Ingestion
never drops an entry it does not understand, because a partial schedule is indistinguishable from a
complete one to the person reading it, and that is the most damaging thing this package could do.

The trade is deliberate: an upstream wording change causes a visible outage for that source until the
mapping is updated, rather than a silently shortened schedule.

Two parser behaviors are load-bearing rather than incidental, and both are pinned by tests:

- A `VALUE=DATE` start is built from local time components, so an all-day calendar date is read from
  those components. Reading the instant in UTC would move the date a day earlier for any process zone
  east of UTC.
- An entry with no `DTEND` is given a default end: equal to the start for a timed value, and the next
  calendar date for a `VALUE=DATE` one, per RFC 5545. A mobile drop-off therefore requires a
  **positive** window rather than a merely present one: an unattested window and a zero-length one are
  indistinguishable, and neither is something a person could act on.
- An all-day span is validated in **whole calendar days** with `differenceInCalendarDays` from
  `date-fns`, never as elapsed milliseconds. A one-day all-day event is 23 hours long across a
  spring-forward date and 25 across a fall-back one, so an elapsed-time check against 24 hours would
  reject a valid event on the fall-back date and accept an end date preceding its start. Zero-day and
  one-day spans are both accepted, so the check does not depend on which `DTEND` default applied. A timed
  window is still compared as instants, which is the right semantics there.

The parse result is also keyed by `UID`, so entries sharing a `UID` would collapse. The raw `VEVENT`
count is compared against the parsed count to make that loud instead of silent.

### The `LOCATION` asymmetry

The verified source populates `LOCATION` on every entry but means two different things by it: on a
curbside entry it repeats the collection area, and on a timed entry it names a real street corner.

Every value is unwrapped from its parameters, unescaped, trimmed, whitespace-collapsed, and NFC
normalized first. Then:

| Timing form | `LOCATION` | Outcome |
| --- | --- | --- |
| Mobile drop-off | Non-empty | Preserved as `location.name` |
| Mobile drop-off | Absent or empty | Refresh fails |
| Curbside | Absent | Accepted |
| Curbside | Exactly the manifest `areaName` | Accepted, and omitted from the event |
| Curbside | Anything else | Refresh fails |

Neither simpler rule works. Rejecting any curbside `LOCATION` rejects the real source outright.
Ignoring any curbside `LOCATION` would silently discard a genuine place if the operator ever put one
there, presenting "bring this somewhere" as "put the bin out" — the one substitution this package must
never make. Comparing after normalization means an invisible encoding difference cannot take a source
out, while a different place still stops the refresh.

## Caching and freshness

Each source gets a process-local cache entry with a 6-hour fresh time-to-live, a 7-day stale-if-error
maximum, coalesced concurrent refreshes so simultaneous requests cause one upstream request, and the
timestamp of the last successful retrieval preserved across failed refreshes.

A failed refresh may serve an existing valid value as `freshness: "stale"` with that preserved
timestamp. Stale data is never manufactured: when no successful retrieval has ever produced a value,
the read fails instead of returning something merely labelled stale. A failure that is *not* an
upstream failure — a defect in this package — is rethrown rather than masked behind stale data, so it
surfaces as an internal error.

Waste-type coverage is declared by the manifest and never inferred from the absence of events. An
empty result with a non-empty coverage list means "no collection in this range", which is a different
statement from "this source does not carry this waste type".

The cache is lost on restart and is not shared between instances, so a horizontally scaled deployment
multiplies upstream requests. A shared cache or a scheduled refresh job is out of scope per ADR 0003.

## Event identity

An official event is identified by what it is, not by where it sits in a calendar file. Identity is a
nine-member tuple — provider, service area, waste type, local date, timing kind, `startsAt`, `endsAt`,
`timeZone`, and normalized location name — serialized as a JSON array, hashed with SHA-256, and
truncated. The identifier is a readable `providerId-serviceAreaId-wasteType-date` prefix followed by
that digest.

**The identifier is opaque.** The prefix exists for operator legibility; clients must not parse it.

Details that are deliberate rather than incidental:

- A JSON array rather than a delimiter join, because official text is arbitrary and a location name
  containing the delimiter could otherwise forge a member boundary.
- The zone is part of identity even though the instants are absolute, because the same instants under
  a different zone describe a different local appointment.
- `collectionMode` is *not* a member: the closed variant set makes it a function of the timing kind.
- A location name is trimmed, its internal whitespace collapsed, and NFC applied, so the same official
  name cannot hash two ways depending on how the source encoded its diacritics.
- The upstream `UID` is never an identity input and never leaves an adapter except as untrusted
  metadata in a log: one upstream entry can produce two events, and an upstream identifier can change
  between refreshes.
- Two events differing in timing, zone, or location get different identifiers and are both returned.
  Only fully identical events collapse, and a digest collision between two genuinely different
  identities fails the refresh rather than silently dropping one of them.

## Injected dependencies

`fetch` and a `Clock` are constructor parameters with the real implementations as defaults. Tests
script retrieval and advance time directly, so no test reaches the network or waits on a real
time-to-live, and production configures nothing.

No municipal calendar file, excerpt, or downloaded fixture is committed. Every test fixture is a small
synthetic calendar written for this repository.

## Verification

```bash
pnpm --filter @abfall-radar/data-providers typecheck
pnpm --filter @abfall-radar/data-providers test
```
