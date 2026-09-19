# ADR 0005 addendum 1: A city-first selection flow

- Status: Accepted
- Date: 2026-09-16
- Amends: [ADR 0005](0005-responsive-web-schedule.md)

## Context

[ADR 0005](0005-responsive-web-schedule.md) specified a two-step selection — provider, then service
area — because the catalogue it was written against offered one official provider serving one area.
The follow-up product scope adds the operator's complete published area list and makes the flow
**city → district → confirm → schedule**, which is how a person actually looks for their collection
dates: they know their city and their district, and they do not necessarily know which organisation
collects there.

That change puts two of ADR 0005's statements under pressure.

**A provider step between the city and the district asks a question with one answer.** Koblenz is
served by one official provider. Showing a screen whose only content is `Kommunaler Servicebetrieb`
adds a tap, a focus stop, and a screen-reader announcement, and it asks the person to confirm
something they did not choose and cannot change. ADR 0005's rule — *"a single offered provider is
still not preselected … 'there is only one' is a fact about today's catalogue, not consent"* — was
written when the provider step was the **first** step, and was therefore the point at which consent
was given. In a city-first flow it no longer is.

**The first read is no longer the provider catalogue.** The city catalogue is, and it carries the
official providers behind each city, so the provider list for a chosen city needs no separate
question of the user.

## Decision

### A city served by exactly one official provider shows no provider step

The provider is **resolved** from the chosen city and held in application state, where it continues to
carry every request, the provenance, and the schedule output. It is not hidden and not implied: the
header and the source section both show it, and the provider identity is what the service-area and
collection-events requests are made with.

This supersedes ADR 0005's "a single offered provider is still not preselected" **for the provider
only**, and only because the consent it protected has moved one step earlier:

- **The city choice is the consent.** Choosing Koblenz is an explicit statement about which
  municipality is being asked about — exactly what the original rule existed to require. A provider
  that follows necessarily from that choice is a consequence of it, not a second decision made on the
  person's behalf.
- **Nothing else is preselected.** A single available **area** is still never preselected, a city is
  never chosen automatically even when only one is offered, and no collection-events request exists
  before explicit confirmation of an available pair.
- **More than one provider still gets a step.** The provider surface is unchanged and appears whenever
  a city offers more than one, so introducing a second provider needs no redesign.
- **Demo providers remain filtered** and cannot be selected or reached.

### Recovery never resolves a provider automatically

After a `PROVIDER_NOT_FOUND` answer the refreshed catalogue always waits for an explicit choice, even
when it offers exactly one provider.

This is not a preference. The areas read that reported `PROVIDER_NOT_FOUND` is what triggers the
catalogue refresh, so resolving the same single provider again would request its areas again and
receive the same answer, without end. The guard is what makes the documented "recovered, not retried"
behaviour terminate.

### The city read is reported in the existing selection phase

`listCities` is the selection flow's first read. Its failures are reported under
`phase: 'selection_providers'`, because that phase answers one question — *which official service can
be chosen* — and Retry must re-read exactly that. The failure keeps `listCities` as its truthful
transport `operation`, so no diagnostic claims a request that was never made.

No new phase is introduced, and the phase-aware Retry contract, the reconciliation budget, range
recovery, and the source-date gate are unchanged.

### `Zurück` goes back exactly one step

From the area step the person returns to whatever opened it: the provider choice when a provider step
was shown, and the city choice when it was not. Focus lands on that control, not on the first control
of the surface.

## Consequences

- One tap and one focus stop fewer in the common case, and no screen that asks a question with a
  single answer.
- The provider remains a first-class identity in state, requests, provenance, and output, so a second
  provider in a city is a data change rather than a redesign.
- ADR 0005's area-level rule, its demo-provider exclusion, its "no events before confirmation" rule,
  and its session-only selection are all unchanged.
- The `/api/v1/cities` route and the `cityId` member on `ServiceArea` are additive; no existing field
  changed meaning.

[AR-005](../tasks/AR-005-responsive-web-schedule.md) remains the accepted task record for the original
slice; its
[implementation handoff](../tasks/AR-005-implementation-handoff.md) records the follow-up stage that
implements this addendum.
