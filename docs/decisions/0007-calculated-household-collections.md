# ADR 0007: Calculated household collections, from published rules and a confirmed weekday

- Status: Accepted (independent review, 2026-09-24)
- Date: 2026-09-23
- Task: [AR-007](../tasks/AR-007-household-bin-schedules.md)
- Relates to: [ADR 0003](0003-official-schedule-ingestion.md) (official ingestion),
  [ADR 0002](0002-shared-http-api.md) (the API contract)

## Context

Koblenz empties two household bins — Braune Tonne (Bioabfall) and Graue Tonne (Restabfall) — that appear
in **no** machine-readable source. The operator's digital calendars exclude them by name. What it does
publish is:

- a week-parity rule, in prose, for a named year;
- the year's holiday date replacements, as a **JPEG image** (and as text on page 23 of the annual
  brochure);
- nothing at all about which weekday a given household is collected on — that is available by telephone.

Every other schedule in this product is *retrieved and validated*. These two can only be *calculated*.
That is a different kind of claim, and the whole decision is about not letting the two blur.

## Decision

### The server serves rules; the client calculates dates

`GET /api/v1/providers/{providerId}/household-rules` returns the parity rule, the table of replacements,
the period they cover, and their provenance. It returns **no dates**, and it is asked per provider, never
per household: the weekday is the one input the API cannot have, so it never leaves the client and no
address is sent to obtain rules.

A provider with no transcribed rules answers `404`. That is a statement that this API cannot calculate
them — never a licence for a client to invent them.

### The rules are a maintained transcription, and say so

A person read two official publications and wrote the rows into
`packages/data-providers/src/node/koblenz/household-rules.ts`. Nothing parses the image. The transcription
carries its own identity (`revision`), the sources it came from, and the date through which the
operator's announcements were read.

### Three automatic checks, reported separately

On every read the server fetches the published documents and reports three independent checks:

| Check | What it establishes |
| --- | --- |
| `table` | The linked image is byte-for-byte the one transcribed. |
| `parityRule` | The page still states the same parity, **for the same year**. |
| `tableLink` | The page still links *that* table rather than a newer one. |

`verification` summarises them: `changed` if any changed, `verified` only if all three verified,
`unverified` otherwise. **A partly checked schedule is never reported as verified**, because the two
realistic failure modes are precisely partial: the sentence changing while the image does not, and a new
year's table appearing at a new URL with the old file left in place.

`changed` withholds the dates everywhere — dashboard, list and reminder — and the surface explains why.
`unverified` is evidence of nothing, so the rules stand and the surface says they could not be checked.

**The operator's announcements are not checked at all.** They are free prose, and a notice that amends a
row looks exactly like one that restates it. Reading them is a documented human responsibility, recorded
as `announcementsReviewedThrough` and shown in both applications.

### Coverage is a hard boundary and a conservative one

Generation stops at the last day the published rows describe (currently 2026-12-26). Beyond it both
applications report limited coverage. The parity rule is **not** extrapolated: the operator states it for
a named year, and the holiday replacements are exactly what cannot be guessed. Where that boundary comes
from, and what remains unverified about it, is recorded in AR-007 rather than implied by the code.

### The calculation is pure and shared

`@abfall-radar/schedule-format` holds it: ISO weeks, Europe/Berlin calendar dates, the waste type from the
**nominal** week, one replacement per nominal date, and a search window widened by the largest published
displacement so a collection moved *into* a range is found. No network, no parsing, no storage — those
stay in the provider package and the applications, exactly as ADR 0003 requires.

### Calculated collections are marked, everywhere they appear

They carry the domain's existing `source: 'user_rule'`, which the shared components render as a
"calculated" badge, and the reminder states in words that the date was calculated from the operator's
rules and a confirmed weekday. They are merged into the one ordered list with official events and never
deduplicated against them: they are different statements, and an operator that does publish a calendar
for these bins elsewhere would be describing the same day for a different reason.

Official events are never re-dated, re-labelled or re-ordered by this feature.

### The weekday is bound to the location that confirmed it

Stored with its `providerId` and `serviceAreaId` — in the website's own `localStorage` record and in the
extension's settings (version 4) — and ignored when it does not name the current selection. Changing
district switches the calculated bins off until a weekday is confirmed for the new one, because a weekday
is a fact about one address on one route.

The two applications keep separate storage, as ADR 0004 addendum 1 already established for language and
appearance. Nothing synchronises them.

## Consequences

- The product shows two bins it previously could not, without claiming they were retrieved.
- A new year is deliberate work: read the new table, record its digest and the page's parity claim, set
  the coverage window, and review the announcements. Until then the applications report limited coverage
  rather than extrapolating.
- One more optional read per visit, coalesced in the extension's worker and independent of the schedule.
- A failure of this feature — unreachable rules, a changed transcription, an unsupported provider —
  changes nothing about the official schedule, and never deletes the person's configuration.
