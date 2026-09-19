# ADR 0005 addendum 2: The confirmed selection is remembered locally

- Status: Accepted
- Date: 2026-09-18
- Amends: [ADR 0005](0005-responsive-web-schedule.md)

## Context

[ADR 0005](0005-responsive-web-schedule.md) decided that the confirmed selection would live in React
state and nowhere else, and recorded the cost in the same breath: *"a person who reloads has to choose
again."* That was accepted for the first slice because persistence carried four questions the slice was
not ready to answer well — where the value lives, what happens when a stored district is later
withdrawn, whether the state should be shareable, and what the migration story is when the shape
changes.

Two of those answers arrived with the work that followed, and the third stopped being hypothetical.

**The withdrawal question is answered.** The controller already revalidates a confirmed pair against a
fresh catalogue on every schedule run, and already routes an invalidated city, provider or district to
the step that has to be decided again. A restored selection needs exactly that machinery and nothing
new.

**The shape question is answered.** The extension's `AppSettingsSchema`
([ADR 0004](0004-extension-api-integration.md)) established the pattern this product uses for a stored
selection: a versioned record of identifiers, validated on read, never migrated in place.

**The cost stopped being theoretical.** Refreshing the page — a reload, a restored tab, an accidental
gesture — returned a person who had already chosen their district to the city step, with no way to get
back other than choosing again. For a page whose whole purpose is answering *"what goes out next?"*,
that is the most common interaction there is.

Sharing a selection by URL remains out of scope. It is a routing decision, not a storage one, and ADR
0005's reasoning about a router is unchanged.

## Decision

### The confirmed selection context is stored locally, and only the context

One `localStorage` key, `abfall-radar.confirmed-selection`, holding a versioned record:

```json
{ "version": 1, "cityId": "…", "providerId": "…", "serviceAreaId": "…" }
```

Stable identifiers and a version. **No schedule is stored** — no collection events, dates, waste types,
provenance or retrieval instants — no API response, and nothing transient: no draft, no search text, no
loading or error state, no menu state, no scroll position and no focus. No cookie, no `IndexedDB`, no
service worker, no server-side persistence and no account.

ADR 0005's rule that **no schedule is persisted** in `localStorage`, `IndexedDB`, cookies, a service
worker or an offline cache is therefore unchanged and still binding. What is remembered is which
question to ask, never an answer to it.

A district is never stored, or returned, without its city and its provider. All three identifiers are
required together, because a district under the wrong city — or under none — is a different place.

### It is written only when a schedule has been accepted

Persistence follows acceptance, not intention. A draft, an abandoned reopen and a confirmation whose
schedule failed all leave the previous record exactly as it was, and confirming a different district
replaces it in a single write once that schedule is real.

### Startup revalidates the record; it never trusts it

A run that finds a record makes the same reads a person's own flow makes — cities, that city's
providers, then that provider's districts in that city — with the same validation at each step, and
requests the schedule afresh. There is one pipeline and no read is repeated for having been restored
rather than chosen.

A restore takes no focus, because the page has only just loaded and the person has not acted. A step it
*stops* at keeps its own focus, as it always has.

### An invalid record ends at a choice, never at a substitution

- The city is no longer published → the record is cleared and the city step is the entry state.
- The provider or the district is gone, or the district is unavailable → the record is cleared and the
  person lands on the step that has to be decided again, with whatever city context still holds. No
  other provider and no other district is ever confirmed in its place.
- The record is malformed, incomplete or of another version → it is discarded as it is read and removed,
  and the visit starts at the city step.
- A read **fails** → the record is kept, because a catalogue that could not be read says nothing about
  whether the district still exists. `Erneut versuchen` resumes the remembered selection by revalidating
  it from the top; the same rules above still decide where that ends.
- Storage is unavailable or refused — a private window, blocked site data, a full quota → nothing is
  remembered, and the ordinary selection flow is what happens.

### This supersedes "session-only selection"

ADR 0005's *"the confirmed selection lives in React state and nowhere else"* and *"reload returns to
needs-selection"* are superseded by this addendum. The original decision and its recorded cost stay in
ADR 0005 as the history of the first slice; they describe what was true then, not what the product does
now.

## Consequences

- Reloading returns a person to their schedule instead of to the city step, which is the common case
  this product exists for.
- A stale record costs one extra visit to the selection step — the intended outcome, and preferable to
  a silent substitution.
- `localStorage` is per-browser and per-origin: nothing synchronises between devices, and a browser that
  refuses storage degrades to the previous behaviour rather than failing.
- The stored value is a district a person chose, not a position, an address or an identifier that
  follows them; it is the same coarse grain the header already shows on screen.
- One versioned shape means a later change is a version bump and a discard, not a migration table.
- The extension is untouched: it keeps its own settings repository and its own schema.

[AR-005](../tasks/AR-005-responsive-web-schedule.md) remains the accepted task record for the original
slice; its [implementation handoff](../tasks/AR-005-implementation-handoff.md) records this change and
its verification.
