# ADR 0004 addendum 1: Settings version 3, the city catalogue, and the popup's presentation

- Status: Accepted (independent review, 2026-09-23)
- Date: 2026-09-22
- Amends: [ADR 0004](0004-extension-api-integration.md)
- Task: [AR-006](../tasks/AR-006-extension-web-alignment.md)

## Context

AR-006 aligns the extension with the web application (see
[ADR 0005](0005-responsive-web-schedule.md) and its addenda). Doing that changes three contracts
ADR 0004 accepted:

- the persisted settings, which gain a language and an appearance;
- the popup–worker messages, which gain a city read and a narrow presentation write;
- the popup's selection flow, which becomes city-first.

Everything else in ADR 0004 still applies unchanged:

- the worker-owned network boundary, the import-graph rule and the configured origin;
- the host permission, the offline cache and the withdrawal sequence;
- the serialized settings repository.

## Decision

### Settings version 3

```ts
interface AppSettings {
  version: 3;
  selection: { providerId: string; serviceAreaId: string } | null; // unchanged from v2
  remindersEnabled: boolean;
  reminderDaysBefore: number;
  reminderTime: string;
  visibleWasteTypes: WasteType[];
  locale: 'de' | 'en' | 'uk' | 'ru'; // new
  appearance: 'light' | 'dark' | 'system'; // new
}
```

- **The migration runs locally and makes no request.** It turns v2 into v3 by keeping every v2 value
  exactly and adding `locale: 'de'` and `appearance: 'system'`.
- The unversioned legacy path gains the same two defaults.
- The migration is idempotent: a stored v3 value is returned as it is, so reopening the popup never
  resets a preference.
- An unsupported newer version is still reported and never overwritten, as before.
- **The selection shape is unchanged.** The city is not stored. It is derived when the selection is
  revalidated (below).

### Presentation preferences have their own write

`save_presentation { locale?, appearance? }` is a settings intent handled by
`persistPresentation`, which runs inside the repository's serialized mutation queue.

- It rereads the stored value and writes only the fields it was given.
- The Settings draft save (`save_settings`) keeps the *stored* language and appearance, never the
  draft's.
- So neither write can revert the other, including one made from another extension context.
- The popup applies a choice at once, then adopts what the worker stored. If the write fails, the
  previous values are shown again.

These are the extension's own preferences. **They are not synchronised with the website**, which keeps
its own in a different storage context. The two applications behave the same, but nothing is shared at
runtime.

### The city catalogue

- **`list_cities`** is a read message, coalesced in the worker like the other reads. It maps
  `GET /api/v1/cities` to `CitySummary { id, name, providers }`.
- **`ServiceAreaSummary` gains `cityId`**, taken from the API's area `cityId`. It is a transport field
  and is never persisted.

### City-first selection and revalidation

- **Selection order.** Onboarding and Settings ask for the city, then the operator, then the district.
  - The operator step appears only when more than one operator is offered for the city, meaning the
    city lists it *and* a successful provider catalogue offers it as non-demo.
  - Districts are narrowed by `cityId`, never by a display name.
  - No city is ever preselected.
- **Revalidating a stored selection** derives its city in three steps:
  1. find the district by its id in its provider's successful district list;
  2. take the district's `cityId`;
  3. find that city in a successful city catalogue, which must list the stored provider.
- **A failed or missing read is not evidence.** While any of those reads is loading or has failed, the
  result is `pending`, and the selection is kept with Retry available.
- **Only a contradiction from a successful city catalogue withdraws the selection.** That is either
  "the city is absent" or "the city no longer lists the provider". The withdrawal uses the existing
  ordered sequence: invalidate the cache, then compare-and-clear the selection.
- A district missing from its provider's successful list is still handled by the schedule's own
  capability check, so the same withdrawal is never started from two places.
- **The place shown in the header** comes from the schedule's provenance (`locality · areaName`), as it
  did before.

### A Settings draft leaves the confirmed selection alone

Settings is transactional, and that covers the **reads** a draft causes as well as the draft itself.
Exploring another city asks that city's operator for its districts, and the confirmed selection's own
district list is what its city is derived from — so the two must coexist:

- service-area answers are held **per provider**, not in one shared slot;
- a reply is filed under the provider it was asked about, so a late answer for a draft that has been
  abandoned cannot land on the confirmed selection's entry;
- cancelling discards the draft and reopening starts again from what is stored, with the derived city
  already in place.

Without this, cancelling a provider change left the confirmed selection with no district list: its city
could not be derived, so the city field opened blank and the saved district was not offered.

### One event order, shared with the reminder

The popup and the reminder both order events with `compareEvents` from
[`@abfall-radar/schedule-format`](0006-schedule-format-package.md).

- Order: date; then an all-day collection before a timed one; then the start instant; then the id.
- The extension's previous comparator also broke same-day ties by waste type, and compared start times
  as strings. Dropping it keeps the rule that the notification names the collection the popup calls
  next, now with the same order the website uses.
- The reminder's drop-off window uses the shared `formatCollectionWindow`. The notification now states
  each end's UTC offset — `10:00 UTC+01:00–12:00 UTC+01:00 (Europe/Berlin)` — exactly as the popup
  does.

### Popup presentation

- **Copy.** Every popup string lives in a typed catalogue for the four languages
  (`src/i18n/messages.ts`). The copy it shares with the website — waste names, countdown,
  collection-day status, window labels and source details — comes from `SCHEDULE_MESSAGES`.
- **Language and theme on the document.** `lang` and `data-theme` are set on the popup document by the
  same rules as the website: `system` leaves `data-theme` unset.
- **Timestamps.** Instants such as the retrieval and storage times are written in labelled UTC, as on the
  website, rather than in the device's zone.
- **The district list is one choice, so it is one tab stop.** It is a listbox with a roving tab stop:
  `Tab` enters at the chosen district or the first selectable one, the arrows, `Home` and `End` move
  within it, and the next `Tab` reaches the confirmation. Focus moves without choosing — `Enter`, `Space`
  or a pointer chooses — and an unavailable district stays a genuinely disabled control the arrows step
  over. Onboarding carries the website's sticky confirmation bar, adapted to the popup, so the action and
  the name of what is chosen stay in view however far down the list the choice was made.
- **A restored schedule makes no freshness claim.** It shows neither "current" nor the source's "stale"
  label; the cached notice says what it is instead. `ScheduleSourceDetails.freshness` accepts `null` for
  this.

### Non-goals kept explicit

- **Reminder notifications stay German.** Localizing them is a follow-up.
- **No dates are generated for Bioabfall or Restabfall.** The Koblenz digital calendars do not publish
  them, and Grünschnitt is not renamed. The coverage statement keeps saying so.

## Consequences

- A v2 installation upgrades on first read, with no request and no visible change other than the new
  controls.
- Rolling back to a v2 build reports the v3 value as an unsupported newer version and leaves it intact,
  which is the behaviour ADR 0004 already specified.
- The popup makes one more read on open (`list_cities`). It is coalesced, and it does not gate the
  schedule.
