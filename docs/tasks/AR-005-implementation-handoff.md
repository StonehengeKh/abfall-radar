# AR-005 implementation handoff

Scope, as accepted: `apps/web` only, plus the root `scripts/` outer verifier and the catalogue entries
listed under [Dependencies](#dependencies). A follow-up stage now in the same working tree widens that
to `packages/domain`, `packages/data-providers`, `packages/api-client`, `apps/api` and
`apps/extension` — see [Follow-up stage](#follow-up-stage-in-progress-2026-09-16). Working tree
uncommitted. Branch `feat/web-schedule-foundation`,
baseline `0a97274`. No normative document was changed to accommodate an implementation defect.

This is the record after **review round 3**. Round 1 returned twelve findings, of which the second
review confirmed nine resolved and three resolved in part; round 2 closed those three plus the two
findings the second review raised (R2-3 and R2-5). Round-1 resolutions that the second review
independently confirmed are summarised in [Round 1](#round-1-disposition) and are not re-argued here.

## Follow-up stage in progress (2026-09-16)

A follow-up product scope is implemented **on top of** this accepted AR-005 work: official Koblenz
district coverage, a city-first selection flow, localization in four languages, and a light/dark design
refresh. All of it is in the working tree, uncommitted. The full record is
`/Users/alex/Downloads/AbfallRadar-next-stage-report.md`.

Nothing below is retracted: the AR-005 acceptance record stands as written. Two AR-005 behaviours are
**superseded** by the city-first brief, and the reasoning is recorded in
[ADR 0005 addendum 1](../decisions/0005-addendum-1-city-first-selection.md), which ADR 0005 now links
from both its header and the amended rule itself:

1. A city served by exactly one official provider now selects that provider without showing a provider
   screen. AR-005 required that nothing be preselected even with one provider offered. The service area
   is still never preselected.
2. The selection flow's first read is `listCities`, reported in the existing `selection_providers`
   phase with `listCities` as its truthful transport operation.

### Official source and retrieval

Retrieved **2026-09-16** from
`https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/` and the per-area
calendars under `.../entsorgungstermine-2026-digital/`. The operator publishes **34** official areas.
Each area's own calendar was requested individually; no URL, identifier, date, interval or coverage
value is inferred from a pattern.

- **33** areas have a 2026 calendar. `Industriegebiet Rheinhafen` is published as
  `ics-industriegebiet.ics`, which no naming rule would produce.
- **`Horchheimer Höhe` has no 2026 calendar** under any probed spelling. It stays in the catalogue with
  `availability: 'unavailable'`, carrying no invented zone or window.
- Coverage is recorded per area from that area's own file. `Industriegebiet Rheinhafen` publishes only
  paper, yellow bag and green waste.

### Coverage — 32 of 34 areas return a schedule

Verified live against the running API. Two of the three original ingestion failures were unambiguous
once the source was measured and are now fixed; one upstream anomaly and one missing calendar remain.

| Cause | Areas | Outcome |
| --- | --- | --- |
| `event-invalid`: the curbside `LOCATION` is the area name plus the operator's own description of the round | Güls 1, Güls 2, Karthause 1–3, Metternich 1, Metternich 2, Niederberg, Rübenach 1, Rübenach 2 | **Fixed.** 1578 of 1578 curbside locations across all 33 calendars begin with the area name — 1128 exactly, the rest followed by ` (` or ` / `, one in lower case. The rule accepts exactly that and still refuses every real drop-off place |
| `summary-unmapped`: separate `Schadstoffe` and `Elektrokleinteile` entries | Rauental | **Fixed.** Both added to the verified summary table, each mapped to its own waste type as a timed drop-off |
| `timing-mode-mismatch` | Pfaffendorfer Höhe | **Open.** One `Gelber Sack` entry is published timed (`20261217T230000Z`–`20261218T000000Z`) while every other yellow-bag entry in the source is all-day. Reading it as the 18 December collection would interpret the operator's intent, which is an AR-003 decision, not a guess made here |
| No 2026 calendar | Horchheimer Höhe | **Open.** `availability: 'unavailable'`, carrying no invented zone or window |

The curbside location rule was **relaxed with measured evidence, not weakened**: a location that does not
begin with the area name still fails the whole refresh, so "bring this somewhere" can still never become
"put the bin out".

**Neuendorf evidence:** exposed as `koblenz-neuendorf`, `cityId: koblenz`, available,
`2026-01-01`…`2026-12-31`; its calendar URL is asserted exactly and asserted different from
Stadtmitte's; live it returns 12 events on dates distinct from Stadtmitte's 13.

### City catalogue and API shape

`GET /api/v1/cities` returns each city with the official providers behind it; a city appears only when
an official provider serves it, so the demo provider is structurally absent from the official flow.
`ServiceArea` gains `cityId`; `District` gains `cityId` in the domain. Both additions are additive, and
`openapi.json` and the generated client types were regenerated by `generate:contract`.

### Localization and appearance

Four locales — German (the fallback), English, Ukrainian, Russian — in a small typed resource layer
under `apps/web/src/i18n/`; no dependency was added. Negotiation matches the browser's language subtag,
an explicit choice wins and is persisted through guarded storage accessors that degrade to "no stored
choice" rather than throwing, and `document.documentElement.lang` follows the locale. Dates and relative
day labels are formatted by `Intl`, including each locale's own plural forms — nothing concatenates a
number to a noun.

Source-authored text is never translated: provider and service-area names, localities, attribution,
source titles, drop-off addresses and the source link are reproduced exactly as published. The
source-local date remains derived from the provider's time zone with a fixed internal formatter, so the
interface language cannot move a collection to another day.

The dark palette re-points the same semantic tokens in `packages/ui/src/styles.css`, declared for the
system preference (guarded so an explicit light choice still wins) and for an explicit dark choice, with
the light palette unconditional. `system` is the default and stamps no attribute. **Three things are
stored, and only these: the appearance preference, the language preference, and a versioned record of
the confirmed city, provider and district** (see
[Restoring a confirmed selection](#restoring-a-confirmed-selection-across-a-reload-2026-09-18)). No
schedule, no API response and nothing transient — asserted by reading back the whole of `localStorage`
after a complete schedule flow, against the real store rather than a no-op substitute.

Changing either the language or the appearance issues **no** request and preserves the city, district,
controller, schedule and lifecycle owner — asserted directly on the gateway call count and the
controller's own state.

### Tests and checks for the follow-up stage

`pnpm check` exit 0. Web **325**, extension **1154**, api-client **381**, data-providers **171**,
api **155**, domain **23**. `turbo run test:build-output` **6/6** with `cache bypass`. Fresh build:
`lang="de"`, one unrestricted viewport, 0 emitted-URL violations, 0 unresolved, and both dark paths
present in the emitted CSS with the light palette unconditional — now asserted post-build.

### Manual checks for the follow-up stage

**None performed.** The owner reports having checked the mobile version once; that check covers the
**pre-city-first, German-only, light-only** version and is not validation of anything in this stage.

Outstanding, and needing a real browser: 320/390/768/1280 px in **both** appearances and **each** of the
four languages; 200 % zoom; long content (German and Ukrainian run materially longer than English);
visible keyboard focus including the two `<select>` controls; measured 44 × 44 px targets; WCAG AA
contrast in both palettes; reduced motion — the global rule is present in the emitted CSS but a browser
must confirm nothing animates; screen-reader announcements per language; and no horizontal overflow at
320 px with the header controls present.

---

## Full review corrective pass (2026-09-17)

The independent full implementation review of the accumulated working tree
(`/Users/alex/Downloads/AbfallRadar-full-code-review-2026-09-17.md`) returned **`CHANGES_REQUESTED`**
with nine findings. Each is addressed in the working tree, uncommitted, on baseline `0a97274`. The
per-finding record — root cause, changed files, regression coverage, actual validation and limits — is
`/Users/alex/Downloads/AbfallRadar-review-fixes-2026-09-17.md`. **The corrective pass has not been
re-reviewed; no approval is claimed.**

| Finding | Resolution in one line |
| --- | --- |
| R1 — invalidation left an endless city spinner | The controller keeps the last loaded city catalogue across schedule mode; invalidation publishes the city's remaining providers or districts (or its empty state) with focus on the mounted surface, and re-reads cities under a new owner when no city context exists |
| R2 — reopen continuation could overwrite a newer draft | The reopen operation has its own owner, superseded by every user selection action; the provider read restores the confirmed pair through a single area read; stale-provider recovery ends at an explicit choice |
| R3 — enlarged text collapsed the sticky header | Brand unit and text column carry `rem` flex bases so the controls, then the text column, reflow; the header stays sticky only while it takes at most a third of the viewport height. Follow-up: `scroll-padding` reserves the pinned header and the district confirmation bar, so Tab and Shift+Tab no longer scroll focused controls entirely underneath them (measured in Chrome) |
| R4 — `image-set()` strings bypassed the dependency guard | String candidates of `image-set()` and `-webkit-image-set()`, and the string source of `image()`, are resolved and boundary-checked like `url()`; metadata strings are ignored; `src()` and every unmodelled vendor spelling of a resource-bearing function are refused fail-closed |
| R5 — districts not scoped to the city | Uniqueness is checked on the whole response, then districts are narrowed to the chosen city; drafting, confirmation and revalidation all require the chosen city |
| R6 — no Back from the provider step | Back is shown on the provider step, including its loading, recovery, empty and failed presentations |
| R7 — header targets 42 × 42 px | Trigger overlays are inset from the padding box so the effective target is 44 × 44 px; popover options are 44 × 44 px buttons with the visible circle inside |
| R8 — Tab left menus open | Menu items leave the Tab sequence; a menu closes when focus leaves it, without returning focus |
| R9 — Retry dropped focus to `body` | A user-initiated city Retry directs focus to the city heading on success and to the state heading on failure; bootstrap still takes no focus |

Required checks on the final tree, after a same-day follow-up: `pnpm check` exit 0;
`turbo run test typecheck --force` **13/13 tasks, 0 cached**, **2388 tests** (web 504, extension 1154,
api-client 381, data-providers 171, api 155, domain 23); the build-output verifier's two uncached
executions passed, each with 7 artifact tests.

When the chosen city's only official provider disappears, the terminal state is, by owner decision, the
existing no-official-providers surface with Retry and Back — asserted by rendered tests. Rendered Chrome checks were
performed for R3, R7, R8 and R9; the record distinguishes the root-font-size text enlargement that was
simulated from native page zoom, which was not tested.

Optional maintenance the review listed separately from its findings — stale README and handoff wording
about three reads and provider-first selection, browser-locale negotiation, and an unused legacy
relative-day helper — is **not** part of this pass and remains outstanding. In particular, the
[Localization and appearance](#localization-and-appearance) paragraph above still describes
browser-language negotiation, which the later German-by-default change superseded.

The one item on that list that is now **closed** is the "nothing is persisted" wording: the README, ADR
0005 and this document were corrected on 2026-09-18, and the contract they now state is the one in
[Restoring a confirmed selection](#restoring-a-confirmed-selection-across-a-reload-2026-09-18).

---

## Second review corrective pass (2026-09-17)

The independent review of the corrective pass
(`/Users/alex/Downloads/AbfallRadar-second-code-review-2026-09-17.md`) returned **`REQUEST_CHANGES`**
with a single finding: at 320 px with enlarged text, the fixed back-to-top control could cover featured
title glyphs and the corner of a focused card, which the header and action-bar `scroll-padding` cannot
reserve. The fix is in the working tree, uncommitted, on the same baseline `0a97274`. The measured
record is in `/Users/alex/Downloads/AbfallRadar-review-fixes-2026-09-17.md`. **This fix has not been
re-reviewed either.**

Measuring first showed the defect was wider than reported: text was covered at normal text size as well
(up to 6 glyphs at 390 px), and focused district cards were covered at 320 px and 390 px.

`apps/web/src/app/floating-control.ts` (new) hides the control — `visibility: hidden`, still mounted,
still in place — for exactly as long as its own footprint overlaps a visible text line box, a visible
`svg`/`img`, or the focused element grown by its focus ring. The decision is made inside the scroll,
resize and focus handlers, so no frame is painted with the control over content, and a control that
holds focus is never hidden. `ScrollToTop` in `apps/web/src/app/app.tsx` adds a ref and one hook call;
its classes, its offer rules near the top and the footer, its safe-area and confirmation-bar offsets and
its reduced-motion behaviour are unchanged. Nothing is clipped, no `overflow` is added and no focus is
suppressed.

Across twelve rendered Chrome configurations — the schedule and district screens at 320 px and 390 px,
normal and 200 % root text, scrolled end to end and tabbed forwards and backwards — covered text, covered
graphics and covered focus all went to **0**, from up to 210 affected scroll positions and 32 covered
focused cards. The trade-off is availability: at 320 px with 200 % text the control is offered at 9–17
scroll positions instead of 158–227. Ordinary scrolling and the `Home` key remain.

Checks after this fix: `pnpm check` exit 0; `turbo run typecheck test --filter=@abfall-radar/web --force`
**5/5 tasks, 0 cached**, web **512 tests** (504 before, +8); the build-output verifier's two uncached
executions passed with 7 artifact tests, the `html` scroll-padding assertions unchanged; boundaries 42.

---

## Collection-day status and countdown target (2026-09-18)

A focused refinement of the schedule surface, implemented on top of the corrective passes and still
uncommitted on baseline `0a97274`. It separates two questions that were previously one derivation.

### Behaviour

- **The featured card keeps today's collection.** When the featured event is an **all-day** collection
  whose date is the source-local today, the circular day badge is replaced by the status
  `Abholung läuft` / `In progress` / `Вивезення триває` / `В процессе`. The waste type, weekday and date
  stay; the relative label (`heute`) is dropped, because the status already says it. This is a calendar
  statement about the day — no start time, no progress share and no completion is implied or invented.
- **A published window is unaffected.** A mobile drop-off keeps its `Heute` badge, its window and its
  place on its own collection day: the source states its hours, so it is a timed appointment, not a day
  that is under way.
- **The countdown derives its own target** from the same ordered schedule:
  - an all-day collection qualifies only on a date **strictly after** the source-local today, so another
    all-day entry for today can never become the target;
  - a timed collection qualifies while its **published start** is still in the future, which is the
    existing reading of an explicit time, and it is passed over once that instant has gone by;
  - the panel **names what it counts** — the waste types and the weekday with the date — because the
    target is no longer, by definition, the card above it;
  - waste types sharing the next all-day date are named together under **one** countdown, in the
    language's own list form, and so are the split events of one drop-off appointment, which share a
    published start;
  - with nothing further published the panel says
    `Keine weiteren Abfuhrtermine veröffentlicht` rather than showing a zero, a negative or an invented
    date. The existing captions for what the countdown measures are unchanged.
- **Ordering and the list are untouched.** Only the featured event is withheld from the list, so other
  collections on the same date keep their rows.
- **No new timer, request or polling.** Both panels are derived from the existing source-local date and
  the existing minute clock. A source-local midnight updates both without a reload, including when the
  tab was in the background while the date changed.

### Files

| File | Change |
| --- | --- |
| `apps/web/src/schedule/collection-day.ts` | **new**: `isCollectionInProgress` and `nextCountdownTarget`, with the `counting` / `no_future_collection` / `undeterminable` outcome |
| `apps/web/src/features/schedule/schedule-surface.tsx` | featured-card status area, countdown target panel, first-row stretch, the removed local `countdownTarget` helper |
| `apps/web/src/i18n/format.ts` | `formatNameList`, an `Intl.ListFormat` conjunction |
| `apps/web/src/i18n/messages.ts` | `schedule.inProgress` and `countdown.noFurtherDates` in all four locales |
| `apps/web/src/schedule/collection-day.test.ts` | **new**, 11 derivation cases |
| `apps/web/src/features/schedule/collection-day.test.tsx` | **new**, 5 rendered cases including the midnight rollover |
| `apps/web/src/features/schedule/countdown.test.tsx`, `weekday.test.tsx` | four cases restated for the intentionally changed behaviour |

### Design decision recorded

The status is **prominent text**, not a bordered chip and not the circular badge. Measured in Chrome at
320 px with 200 % root text, the card offers its content **190 px**; a chip's border and padding leave
**140 px**, while `Вивезення` alone measures **165 px**, so a box could only be had by breaking a word in
half. Without one, every shipped phrase wraps between its words: `Abholung läuft`, `In progress`,
`Вивезення триває`, `В процессе` — verified per line box, with no horizontal page scroll.

### Verification

| Check | Result |
| --- | --- |
| `pnpm check` | **exit 0.** Web **536** tests (512 before this work, **+24**); extension 1154, api-client 381, data-providers 171, api 155, domain 23. 3 lint warnings, all pre-existing unused imports in untouched tests |
| Rendered Chrome 151, **controlled clock** | The page `Date` was shifted to `2026-09-22T08:00:00Z` (10:00 in Berlin) so that a **live** Stadtmitte all-day collection — Gelber Sack, 22.09.2026 — falls on the simulated today. Live API data throughout; only the clock was substituted |
| 320 px, 390 px, 1280 px, normal text | Status shown, badge absent, card date `Di., 22.09.2026`, countdown target `Altpapier · Di., 29.09.2026`, `6 Tage 13 Std. 59 Min.`, caption `bis der Abfuhrtag beginnt`. No horizontal scroll at any width |
| 320 px at simulated 200 % root text, `de` and `uk` | Status wraps between words, is not clipped, and stays inside the card; the countdown target line is not clipped |
| All four locales at 320 px / 200 % | `de`, `uk`, `ru` wrap between words; `en` fits one line. No word split, no page overflow |
| Source-local midnight, live | Started at 23:59:20 Berlin. Before: badge `1Tag`, target `Gelber Sack · Di., 22.09.2026`. After 00:00: status `Abholung läuft`, target `Altpapier · Di., 29.09.2026`, `6:23:59`. `performance.getEntriesByType('navigation').length` stayed **1** — no reload |
| Returning to the tab | With the page hidden across midnight, nothing changed while hidden; on `visible` both panels updated in the same session, again without a reload |
| Console | No errors in any run |

Screenshots: `/private/tmp/abfall-collection-day-20260918/`,
`/Users/alex/Downloads/AbfallRadar-screenshots/v10-collection-day-*.png` (first pass) and
`v11-card-*.png` (this pass).

### Card hierarchy and equal panel heights (same day, second pass)

The first pass put the status where the day badge had been, ahead of the icon and the waste type. That
reordered the card's hierarchy. The status now has its own area instead:

- **The collection reads as it always has.** The `Nächste Abfuhr` label, the waste icon, the waste type
  and the weekday with the date stay together in the main content area, in that order, on today as on
  any other day. The day badge keeps the leading slot when there is a day count to show.
- **The status is a separate area at the end of the card**, after the collection in the DOM and in the
  reading order, end-aligned and centred against the content beside it. It is the same localized string
  as before, from `schedule.inProgress`; no second wording was introduced.
- **The content column carries a `rem` flex basis** (`flex-[1_1_12rem]`) rather than `flex-1`. A zero
  basis can never overflow its line, so the status would have been squeezed into a sliver beside a long
  waste type; with a basis that grows with the text size, a narrow or enlarged card puts the status on
  its own row, still against the end.
- **The featured card and the countdown share the first grid row's height** through `xl:self-stretch` on
  those two panels, not `items-stretch` on the grid: the row below pairs the event list with the source
  panel, and stretching that row would leave the source card as tall as the whole schedule. The source
  panel is unchanged. No fixed height was introduced, and the card centres its content in the shared
  height.
- **Accessibility unchanged:** the status is a `<p>` with no `role` and no `aria-live`, so the minute
  tick announces nothing; the card keeps its single `h3`, and focus order follows the DOM order above.

#### Rendered measurements

Chrome 151, live Stadtmitte data, page clock shifted to `2026-09-22T08:00:00Z`; German unless stated.
Heights are the panels' outer boxes.

| Width | Featured card | Countdown | Δ | Status |
| --- | --- | --- | --- | --- |
| 320 px | 158 px | 156 px | stacked, one column | own row, 17 px from the card's end |
| 390 px | 158 px | 156 px | stacked | own row, 17 px from the end |
| 768 px | 126 px | 156 px | stacked | same row, centred (Δ 0 px), 21 px from the end |
| 1279 px (below the breakpoint) | 126 px | 156 px | stacked | same row, centred (Δ 0 px) |
| **1280 px** (side by side) | **156 px** | **156 px** | **0 px** | same row, centred (Δ 0 px), 21 px from the end |
| **1440 px** | **156 px** | **156 px** | **0 px** | same row, centred (Δ 0 px) |
| 1280 px, 200 % text, `de` | 362 px | 362 px | **0 px** | own row inside the card |
| 1280 px, 200 % text, `uk` | 450 px | 450 px | **0 px** | own row inside the card |
| 320 px, 200 % text, `de` / `uk` | 530 / 586 px | stacked | — | own row, wraps between words |

At every width and text size measured: the status never overlaps the icon or title, the waste type and
the date each appear exactly once in the card, and `document.documentElement.scrollWidth` never exceeds
`clientWidth` — no horizontal page scroll.

The floating back-to-top control was re-swept against the changed card: **12 of 12** configurations
(schedule and district screens, 320 and 390 px, normal and 200 % text, scrolled end to end and tabbed
both ways) report **0** positions with covered text and **0** covered focused elements, unchanged from
the second-review fix. Log: `/private/tmp/abfall-collection-day-20260918/fab-sweep-v11.log`.

#### Regressions added for this pass

`apps/web/src/features/schedule/collection-day.test.tsx` — the status follows the heading and the date
in the DOM and is the card's last element, the day badge is absent, the type and date are named once
each, the status is plain text with no `role` or `aria-live` beside the card's single `h3`, the content
column keeps its `rem` basis and the card keeps `flex-wrap`, and both first-row panels carry
`xl:self-stretch` while the source panel does not. Rendered geometry is browser evidence, recorded
above, because jsdom performs no layout.

### Stamp treatment for the status (same day, third pass)

Visual only: the status text, its position in the card and every data rule above are unchanged.

- **The status is the card's visual anchor** on a wide card: an outlined, tilted stamp — `border-2` in
  `ar-brand`, a `bg-ar-brand/10` wash and the text in `ar-text` — at `text-4xl`, rotated `-5deg`. A
  high-contrast outline over a low-opacity fill, so nothing about the sentence itself is faint.
- **One text node.** The outline, the wash and the tilt are presentation; no second copy, visible or
  hidden, exists, and the accessibility tree still carries the localized sentence exactly once.
- **Three steps, keyed to the card and not to the viewport.** The thresholds are `@container` queries in
  `rem`, so what decides the treatment is the card's width *measured against the text size*:
  - under `26rem`: plain, upright text, as before this pass;
  - `26rem` and up: outlined stamp, `text-2xl`, `-3deg`;
  - `38rem` and up: `text-4xl`, `-5deg`, wider padding.

  A viewport breakpoint would have put a 36 px stamp into the 272 px card that 1280 px with 200 % text
  produces. Under container queries that case falls back to the plain text automatically.
- **Static.** A `rotate`, not an animation or a transition: there is no motion for a reduced-motion
  preference to suppress, and none was added.
- Existing padding, radius, border language, card layout, equal heights and the countdown are untouched.

#### Rendered measurements

Chrome 151, live data, page clock shifted to `2026-09-22T08:00:00Z`. Every combination below was
measured; none overlapped the icon, title, waste type or date, every status box stayed inside the card,
and `scrollWidth` never exceeded `clientWidth`.

| Case | Treatment | Card / countdown height |
| --- | --- | --- |
| 320 px, 390 px — dark and light | plain text, 18 px, no rotation, no border | stacked |
| 520–680 px | stamp, 24 px, `-3deg`, 2 px outline | stacked |
| 768 px, 1024 px | stamp, 36 px, `-5deg` | stacked |
| **1280 px, 1440 px** | stamp, 36 px, `-5deg` | **155.6 px = 155.6 px, Δ 0** |
| 1280 px at 200 % text | plain text (container below `26rem`) | **362 px = 362 px, Δ 0** |
| 320 px at 200 % text | plain text, wraps between words | stacked |
| `de`, `en`, `uk`, `ru` at 1280 px | stamp, Δ 0 in every language | **Δ 0** |

Contrast of the status against what is actually painted behind it (page, card and the stamp's own wash
composited): **14.42:1** dark and **10.09:1** light for the text; the outline measures **11.21:1** dark
and **4.56:1** light against the card, above the 3:1 required of a non-text boundary. The sentence
itself, not the colour, carries the meaning.

Log: `/private/tmp/abfall-collection-day-20260918/stamp-measurements.log`. Screenshots:
`/Users/alex/Downloads/AbfallRadar-screenshots/v12-stamp-*.png`.

One regression was added for the contract this changed — one text node, no hidden copy, `@container` on
the card, the stamp classes present only behind container thresholds, and no animation class — in
`apps/web/src/features/schedule/collection-day.test.tsx`. Web tests: **534**.

### Label and date typography (same day, fourth pass)

Typography only, and only on the collection day; the stamp, the card geometry, the equal heights and
every data rule are untouched.

- `Nächste Abfuhr` moves from `text-xs` to `text-sm`, and the weekday-and-date line from `text-sm` to
  `text-base` — one step each along the existing scale, no one-off values.
- Both keep `text-ar-text-muted`, and both stay below the waste type's `text-lg`, so the type is still
  the primary line and these two are still secondary. The date is still one `next-collection-date`
  element, rendered once.
- **Any other day the card is exactly as accepted** (`text-xs` and `text-sm`): the increase is scoped to
  the state that carries the stamp, which is what it balances.

#### Rendered measurements

Chrome 151, live data, page clock shifted to `2026-09-22T08:00:00Z`; 320, 390, 768, 1280 and 1440 px,
dark and light, all four languages, each also at 200 % simulated root text — 30 combinations.

| Measure | Result |
| --- | --- |
| Type sizes | label **14 px**, date **16 px**, waste type **18 px** (28 / 32 / 36 px at 200 %) — the order holds everywhere |
| Hierarchy | label and date smaller than the type, and in the muted colour, in every combination |
| Overlap | none between the label, date, icon, waste type and the stamp, at any width or text size |
| Inside the card | every measured box within the card's bounds |
| Equal heights | **Δ 0 px** wherever the card and countdown share a row, in both themes and all four languages |
| Horizontal overflow | **0 px** everywhere |
| Date elements | exactly **1**, and the date string appears **once** in the card |
| Left column centring | Δ 0 px against the card from 768 px up; above centre at 320 and 390 px, where the stamp takes its own row below |

Log: `/private/tmp/abfall-collection-day-20260918/typography.log`. Screenshots:
`/Users/alex/Downloads/AbfallRadar-screenshots/v13-type-*.png`.

Two regressions were added in `apps/web/src/features/schedule/collection-day.test.tsx`: the collection
day's label and date carry the larger step while staying muted and under the type, and any other day
keeps `text-xs` and `text-sm`. Web tests: **536**.

### Limits and follow-ups

- **The collection-day state was reached with a substituted page clock**, not by waiting for a real
  collection day. The schedule, the provider and every date came from the live API.
- Text enlargement was simulated by setting the root font size. Native page zoom, OS text scaling,
  Safari, Firefox, touch and assistive technology remain unverified, as elsewhere in this document.
- The `no further dates` state was verified by tests only: the live range always ends with published
  collections ahead of it, and a clock past the published range produces `range_not_covered` instead.
- In the last minute before a date-only collection day the countdown reads `0 Tage 0 Std. 0 Min.`, the
  floor of a remainder under a minute. That is the existing display rule, not an invented value.
- The card heading still reads `Nächste Abfuhr` while the status says the collection is under way. The
  wording was left as accepted; changing it was not part of this refinement.
- The featured waste name can still break inside a word at 320 px with 200 % text — the pre-existing R3
  limitation, unchanged by this work.

---

## Restoring a confirmed selection across a reload (2026-09-18)

Refreshing the browser used to return to the city step. A confirmed selection is now remembered and
revalidated on the next run, so the schedule comes back on its own.

### What is stored, and what is not

- One versioned record under `abfall-radar.confirmed-selection`: **city id, provider id, service-area
  id** and the schema version. Nothing else.
- **No schedule, no provenance, no dates.** Published data is re-read on every visit, so a collection
  date from a previous visit can never be shown as current.
- No draft, no search text, no scroll position, no focus, no menu state, no loading or error state.
- A district is never returned without its city and its provider: all three identifiers are required
  together, because a district restored under the wrong city is a different place.
- The language and appearance preferences are untouched, in their own keys as before.

### When it is written and forgotten

| Moment | Effect |
| --- | --- |
| A confirmed schedule is **accepted** | The record is written, replacing any previous one in a single write |
| A draft, an abandoned reopen, `Zurück` without confirming | Nothing is written; the last confirmed selection stays restorable |
| A confirmation whose schedule fails | The previous record stands |
| A restore where the catalogue no longer offers the city, the provider or the district | That record is cleared, and the user is left on the step that has to be decided again |
| An authoritative invalidation of the confirmed pair in session | The record is cleared |
| A transport failure while restoring | The record is **kept** — a catalogue that could not be read says nothing about whether the district still exists |
| A record that is corrupt, of another version, or incomplete | Ignored and removed as it is read; the visit starts at the city step |

### How the restore runs

`AppController.start()` reads the record and, when there is one, runs the same reads a person's own flow
makes — cities, then that city's providers, then that provider's districts in that city — with the same
validation at each step, then confirms. It reuses the existing reopen machinery, so there is one
coherent pipeline and nothing is read twice for having been restored: a regression asserts the restored
run's requests are **identical** to those of a manual confirmation of the same district. The restore
takes no focus at any step, because the page has only just loaded and the person has not acted; a step
it *stops* at keeps its own focus, as it always has.

### Files

| File | Change |
| --- | --- |
| `apps/web/src/adapters/confirmed-selection-store.ts` | **new**: the versioned record, its parser, a guarded `localStorage` store, and a no-op store |
| `apps/web/src/hooks/app-controller.ts` | restore on `start()`, write on acceptance, clear on invalidation, a silent (focus-free) restore path |
| `apps/web/src/hooks/use-app-controller.ts` | the browser store in the composition root |
| `apps/web/src/test/harness.ts` | a store can be injected; omitted, nothing is remembered, so every earlier test is unchanged |
| `apps/web/src/i18n/locale.ts` | its comment no longer claims that no selection is stored |
| `apps/web/src/adapters/confirmed-selection-store.test.ts` | **new**, 16 cases |
| `apps/web/src/hooks/selection-restore.test.ts` | **new**, 14 controller cases |
| `apps/web/src/app/app.integration.test.tsx` | two mounted-app reload cases, and `localStorage` cleared between cases |

### Verification

| Check | Result |
| --- | --- |
| `pnpm check` | **exit 0.** Web **568** tests (536 before, **+32**); the other workspaces unchanged. 3 lint warnings, all pre-existing |
| `turbo run typecheck test --filter=@abfall-radar/web --force` | **exit 0, 5/5 tasks, 0 cached** |
| Rendered Chrome 151, live API | Koblenz and **Neuendorf** confirmed, then a real `Page.reload` at **390, 1280 and 320 px**: the header reads `Koblenz · Neuendorf`, the schedule renders, no city or district choice is shown, and the record is intact |
| Requests after a reload | `cities`, `providers`, `service-areas`, then the pipeline's own `providers`, `service-areas`, `collection-events` — the same sequence a confirmation makes. The **two** `cities` entries are React Strict Mode's double-mounted effect in dev: a run with **no** stored record issues the same two |
| Invalid record — district that does not exist | The district step with all 34 districts offered, a heading, no spinner, and the record cleared |
| Corrupt record (`{not json`) and version `0` | The city step, record removed |
| Themes and languages | Restored in `de`/`dark`, `en`/`light`, `uk`/`dark`, `ru`/`light`; language and appearance preferences survive untouched |
| Reopen, `Zurück` without confirming, reload | The confirmed schedule returns |
| Console | No errors in any run |

Log and screenshots: `/private/tmp/abfall-restore-20260918/`, and
`/Users/alex/Downloads/AbfallRadar-screenshots/v14-reload-*.png`.

### Limits

- A record is validated against the catalogue, never trusted: a stale one costs one extra visit to the
  selection step, which is the intended outcome rather than a silent substitution.
- `localStorage` is per-browser and per-origin; nothing is synchronised between devices, and a private
  window or blocked site data simply remembers nothing.
- Not verified: Safari, Firefox, touch hardware, native zoom and assistive technology, as elsewhere here.

---

## Corrective pass after the final review (2026-09-18)

The final independent review
(`/Users/alex/Downloads/AbfallRadar-final-code-review-2026-09-18.md`, verdict **`REQUEST_CHANGES`**)
found **no runtime defect**. Its three `major` findings were statements about the product that the
persistence change had made false, and two `minor` ones. All are addressed here, on the same baseline
`0a97274`, uncommitted. **Not re-reviewed.**

| Finding | Resolution |
| --- | --- |
| 1 `[major]` — `apps/web/README.md` claimed nothing is persisted | The "Session-only selection" section is replaced by "What is remembered between visits": the one versioned record and its three identifiers, the presentation preferences beside it, the explicit list of what is **not** stored, when the record is written, how it is revalidated, and what clearing storage does |
| 2 `[major]` — ADR 0005 still specified React state only | New `docs/decisions/0005-addendum-2-confirmed-selection-persistence.md` (Accepted, 2026-09-18). ADR 0005 links it from the header, marks the amended rule beside the original, and keeps the superseded section with a `> Superseded by` note — the first-slice decision and its recorded cost stay visible |
| 3 `[major]` — `theme.test.tsx` asserted the opposite of shipped behaviour through a no-op store | Replaced by `writes the appearance and the confirmed selection, and no schedule`, which injects `createConfirmedSelectionStore(window.localStorage)` — the real implementation — and asserts the exact key set, the record's exact members, the absence of any event, date, waste type, provenance or transient key, and a companion case proving an unconfirmed draft writes nothing |
| 4 `[minor]` — handoff repeated the stale claim | The paragraph now states the three stored values and points at the persistence section |
| 5 `[minor]` — Retry after a failed startup dropped the remembered selection | Fixed; see below |
| 6 `[minor]` — `turbo-env.test.ts` concurrency flake | Untouched, as the review directed. It did not reappear in this pass's runs |

### The Retry fix

`AppController` now holds the restore **intent** — `#pendingRestore` — for exactly as long as it is
still reachable:

- set when a restore begins, immediately after the supersede that clears it;
- **kept** when a catalogue read *fails*, because a read that never arrived contradicts nothing;
- cleared when the catalogue answers and contradicts the record, when the restore confirms, when the
  catalogue is empty, and — through `#supersedeReopen` — by every user selection action, so an intent
  can never outlive a choice the person made themselves.

`retry()` reads that intent before superseding and, on an error surface, re-enters `#restoreSelection`
instead of the bootstrap city read. The resumed run revalidates city, provider and district from the top
and then requests the schedule, so nothing is auto-selected, no provider is switched, and no request is
duplicated. With no intent, `retry()` behaves exactly as before.

### Verification

| Check | Result |
| --- | --- |
| Focused tests first | `selection-restore.test.ts` **19**, `theme.test.tsx` **9**, `confirmed-selection-store.test.ts` **16**, `app.integration.test.tsx` **21** — 65 passed |
| New Retry cases against the **pre-fix** controller | 3 of 5 fail (`resumes the remembered selection…`, `resumes through one pipeline…`, `ends at the district step…`); the other two are preservation guards that pass either way |
| `pnpm check` (once, final tree) | **exit 0.** Web **574** tests (568 before, **+6**); extension 1154, api-client 381, data-providers 171, api 155, domain 23. 3 lint warnings, all pre-existing |
| Chrome 153, fresh profile, API blocked with `Network.setBlockedURLs` then unblocked | **Valid record:** error surface with a working Retry and the record kept → Retry → `Ihre Abfuhrtermine`, `Koblenz · Neuendorf`, requests `cities, providers, service-areas, providers, service-areas, collection-events` — one events request, no duplicates. **District gone:** → district step, 34 districts, record cleared, 3 requests, nothing confirmed in its place. **No record:** → city step, 1 request |
| Regression checks, same browser | Normal selection still confirms and stores; a real reload restores `Koblenz · Neuendorf`; corrupt and version-`0` records land on the city step with the record removed; theme `dark` and language `de` unaffected throughout; no console errors |

Screenshots and logs: `/private/tmp/abfall-corrective-20260918/`.

Untouched by this pass, as the review required: the floating control, the featured card and countdown,
the responsive work, and every extension file.

---

## Follow-up review corrections (2026-09-18)

The follow-up review (`/Users/alex/Downloads/AbfallRadar-final-followup-review-2026-09-18.md`) closed
the Retry correction and the README/ADR updates, and left two `minor` items. Both are addressed here,
on baseline `0a97274`, uncommitted, with no change to runtime behaviour, UI, countdown, selection flow
or extension code. **Not re-reviewed.**

| Finding | Resolution |
| --- | --- |
| The handoff still listed the "nothing is persisted" wording as outstanding | The optional-maintenance paragraph now lists only what is genuinely open — the three-reads and provider-first wording, browser-locale negotiation, the unused relative-day helper — and records that the persistence wording was closed on 2026-09-18, pointing at the contract section |
| The storage contract test never mounted the production composition root | Two cases added to `app.integration.test.tsx`, which mounts the real `App` — and therefore `useAppController` and `browserConfirmedSelectionStore()` — over the real `window.localStorage`, with only `fetch` substituted |

The new production-wiring cases assert that a confirmed selection writes **exactly** the versioned
record (`version`, `cityId`, `providerId`, `serviceAreaId`) as the only storage key, that no event,
date, waste type, provenance or transient value appears in storage, and that an unconfirmed draft
writes nothing at all. The unit-level assertions in `theme.test.tsx` are unchanged and keep covering the
store's shape directly.

**The guard was proven to bite.** With `use-app-controller.ts` switched to `noConfirmedSelectionStore()`
in an isolated copy of the tree, `writes the versioned record through the production wiring` fails (as
does the existing reload case) while `theme.test.tsx` still passes — which is precisely the gap the
review described.

### Verification

| Check | Result |
| --- | --- |
| Focused tests first | `theme.test.tsx`, `confirmed-selection-store.test.ts`, `selection-restore.test.ts`, `app.integration.test.tsx` — **67 passed** |
| Regression proof | The production-wiring case fails against a no-op-store root; the unit test does not |
| `pnpm check` (once, final tree) | **exit 0.** Web **576** tests (574 before, **+2**); 3 lint warnings, all pre-existing |
| Chrome 153, fresh profile, blocked then unblocked API | Unchanged: valid record → Retry restores `Koblenz · Neuendorf` through one pipeline with a single events request; district gone → district step with the record cleared; no record → city step. A real reload restores; a corrupt record lands on the city step; no console errors |

The responsive, floating-control, card and countdown matrices were not re-run: nothing in this pass
touches rendering.

---

## An audited favicon in the shell (2026-09-19)

The browser tab had no mark. Adding one meant amending two accepted rules rather than working around
them: AR-005's closed HTML shell names an added icon link as a rejected deviation, and `publicDir: false`
states that nothing is copied verbatim into the build. Both were amended in the open, and the audited
output guarantee is kept.

### Contract changes

- **New** `docs/decisions/0005-addendum-3-audited-favicon.md` (Accepted, 2026-09-19): the shell carries
  exactly one resource link, the asset comes from the module graph and never from `public/`,
  `publicDir: false` stays in force, the emitted asset is audited with the outputs it ships beside, and
  the mark is derived from the brand mark.
- `docs/decisions/0005-responsive-web-schedule.md`: addendum 3 listed in the header.
- `docs/tasks/AR-005-responsive-web-schedule.md`: the shell section now carries the amended template in
  a quoted `Amended by` block, with the first slice's original template retained beneath it, and the
  rejection list notes that the single favicon link is part of the template while a further icon link is
  still rejected.

### Implementation

| File | Change |
| --- | --- |
| `apps/web/src/assets/favicon.svg` | **new**, 1.55 kB: brand-green rounded square, dark recycling glyph drawn as three bold arrows, no wordmark, no external reference |
| `apps/web/index.html` | one line: `<link rel="icon" type="image/svg+xml" href="/src/assets/favicon.svg">` |
| `apps/web/src/boundaries.test.ts` | `EXPECTED_INDEX_HTML` updated; the extra-link rejection now proves a **further** link is still a deviation; three new cases for the shell favicon |
| `apps/web/src/test/build-output.verify.ts` | three new cases auditing the emitted asset |

The `href` points inside `src/`, so Vite resolves, hashes and emits it — `/assets/favicon-gVXpH_fj.svg`
— exactly as it treats the stylesheet and the script. No public directory exists, `publicDir: false` is
unchanged, and no dependency, tooling or PNG pipeline was added.

### How it stays audited

- **Source:** inside the audited tree, not a protected test file, reachable only through the shell
  reference; the shell declares exactly one, typed, icon link and no manifest or touch icon.
- **Emitted:** the built HTML declares exactly one icon link, it points at a **hashed** asset rather
  than the source path, that file exists and is non-empty, and it is the **only** image in the build —
  so an unreferenced or verbatim-copied asset would be reported.
- **Content:** held to an exact allow-list — the SVG namespace name as its only absolute URL, and no
  script, style, `@import`, nested image, `xlink:href` or `url()`.
- **Unchanged:** the four-category scan over emitted HTML, JavaScript and CSS, and the R4 protected-asset
  guard. The SVG is audited by the stricter allow-list above rather than exempted from the scan, because
  a standalone SVG must declare its namespace to render.

### Verification

| Check | Result |
| --- | --- |
| Focused | `boundaries.test.ts` **45**; artifact audit **11**, forced and uncached |
| `pnpm check` | **exit 0.** Web **579** tests (576 before, **+3**); 3 lint warnings, all pre-existing |
| `git diff --check` | clean |
| Dev server | `GET /src/assets/favicon.svg` → **200**, `image/svg+xml`, 1371 bytes at the time of the check |
| Production preview | `GET /assets/favicon-gVXpH_fj.svg` → **200**, `image/svg+xml` |
| Chrome, dev and production | Exactly **one** `link[rel~=icon]`, typed, resolving to the emitted asset; the only failed request was the Strict-Mode aborted `cities` read in dev, which predates this work; **0** console errors in both |
| Before mount | With script execution disabled, the built HTML still carries the icon link and `#root` is empty — the tab mark does not depend on React |
| Rendered at 16, 32 and 64 px | Legible on a light (`#ffffff`) and a dark (`#101314`) strip; screenshots in `/private/tmp/abfall-favicon-20260919/` |

Nothing in selection, persistence, the countdown, the schedule cards, the responsive layout, the
floating control or the extension was touched.

---

## Review status

| Subject | Status |
| --- | --- |
| Independent full implementation review, 2026-09-17 (accumulated working tree) | **`CHANGES_REQUESTED`** — nine findings R1–R9. All nine are addressed in the working tree; see [Full review corrective pass](#full-review-corrective-pass-2026-09-17). **Not re-reviewed: no approval is claimed for the corrective pass** |
| Second independent review, 2026-09-17 (corrective pass) | **`REQUEST_CHANGES`** — one finding, the floating control covering content and focus. Addressed in the working tree; see [Second review corrective pass](#second-review-corrective-pass-2026-09-17). **Not re-reviewed** |
| Collection-day status and countdown target, 2026-09-18 | Product refinement, not a review finding. Implemented and verified in the working tree; see [Collection-day status and countdown target](#collection-day-status-and-countdown-target-2026-09-18). **Not reviewed** |
| Confirmed selection restored across a reload, 2026-09-18 | Defect fix: a refresh returned to the city step. Implemented and verified in the working tree; see [Restoring a confirmed selection](#restoring-a-confirmed-selection-across-a-reload-2026-09-18). **Not reviewed** |
| Final independent review, 2026-09-18 | **`REQUEST_CHANGES`** — no runtime defect; three stale product statements and two minor gaps. All addressed; see [Corrective pass after the final review](#corrective-pass-after-the-final-review-2026-09-18). **Not re-reviewed** |
| Follow-up review, 2026-09-18 | Two `minor` items — a contradictory handoff paragraph and a storage test that never mounted the production root. Both addressed; see [Follow-up review corrections](#follow-up-review-corrections-2026-09-18). **Not re-reviewed** |
| Audited favicon, 2026-09-19 | Shell and build contract amended in the open (ADR 0005 addendum 3) rather than bypassed; see [An audited favicon in the shell](#an-audited-favicon-in-the-shell-2026-09-19). **Not reviewed** |
| Inspected implementation and automated verification | **`APPROVE`** — Codex review round 3. All five R2 findings confirmed resolved. This approval predates the follow-up stage and the 2026-09-17 review |
| Manual browser acceptance | **Pending.** Not started, not claimed, and not delegable to the automated suite |
| AR-005 overall | **Not accepted.** Per [`docs/ai/workflow.md` §6](../ai/workflow.md#6-codex-performs-final-review), readiness requires the Codex `APPROVE` (held), the required checks (passing), **and** the documented manual scenarios and human acceptance (outstanding) |

The approval covers what was inspected: source, tests, verification tooling, and the automated
results. It is not a statement about rendering, layout, focus appearance, contrast, motion, or
assistive-technology output, none of which this project can verify automatically — jsdom performs no
layout. "No defects found in the reviewed code" is not "implementation acceptance verified".

The acceptance session is prepared: both services were started from the documented configuration and
answered successfully — see [Browser checks](#browser-checks--not-performed). The step-by-step
checklist is `/Users/alex/Downloads/AR-005-manual-acceptance.md`; its results belong in this document
once recorded.

---

## Round 2 resolutions

### R2-1 — CSS identifier parsing (`apps/web/src/test/dependency-graph.ts`)

**Confirmed.** A hex escape in a CSS function name is terminated by *any* whitespace, and
`postcss-value-parser` reports that whitespace as a value separator. The previous fix rejoined the
split parts only when the separator was a single space, so `\75<TAB>rl("…")` — a real U+0009 — reached
the graph as a function named `rl`, producing empty `findings` **and** empty `unsupported`. The review
proved with a real Vite and Tailwind build that the bundler follows exactly that reference and inlines
the target as a `data:` URL, so the miss is a genuine origin bypass rather than a parser artefact.

Fixed lexically, not by special-casing the tab:

- `preprocessCss()` implements CSS Syntax §3.3 input preprocessing — CRLF, lone CR, and FF each fold to
  LF, and NULL folds to U+FFFD — and `decodeCssEscapes()` applies it before interpreting any escape, so
  decoding stays a single pass over the original bytes.
- `trailingEscape()` classifies how a word ends by scanning its escapes **forward**, so no backslash is
  miscounted: `hex` (the identifier continues into the next node), `dangling` (uninterpretable), or
  `none`.
- `isEscapeTerminator()` accepts exactly one preprocessed whitespace code point. Two or more are not a
  terminator, because only the first belongs to the escape — `\75  rl(` really is the value `u`
  followed by a different function, and joining it would invent a dependency.
- A `dangling` ending returns `undefined`, which the caller reports as `unsupported-form`: the
  documented fail-closed path, not silence.

Target resolution is unchanged and still runs **before** traversal stops at a leaf: `fs.isFile` →
`isProtected` → allowed extension → `leafResources`.

Tests — `src/boundaries.test.ts`, "stylesheets: `url()` in any case and with identifier escapes":
twelve spellings driven through `walkProductionGraph` against a protected SVG (`URL`, `Url`, and the
escape terminated by space, **tab**, LF, CR, FF, CRLF, plus the no-terminator `\0075rl`, and two
doubly-escaped forms), each required to report `protected-target`. The bytes of the tab and CRLF
fixtures are asserted before use. Retained positives: the same tab-escaped spelling pointing at an
unprotected asset is followed and kept as a leaf resource; `\75  rl(` (two spaces) and `u\ rl(` (an
escaped space, which names the identifier `u rl`) produce no findings at all.

### R2-2 — HTML source ranges (`apps/web/src/test/build-output-scanner.ts`)

**Confirmed.** `embeddedBodyRanges()` derived script and style body ranges from a regular expression,
which cannot decide where a start tag ends: `>` is an ordinary character inside a quoted attribute
value. For `<script data-x=">" data-a="/" data-a="https://api.example.test"></script>` the remainder of
the start tag was mistaken for script body and excluded from the raw pass, while the DOM parser had
already discarded the repeated attribute — so neither view reported the URL, with no syntax failure.

Replaced with `rawTextBodies()`, a source-aware tokenizer over the HTML lexical states that decide
those boundaries: data, markup declarations and comments, tag and attribute names, single-quoted,
double-quoted and unquoted attribute values, and the raw-text end-tag search (which per the HTML syntax
ends at the first `</name` followed by whitespace, `/`, or `>`). It builds no tree, decodes nothing, and
adds no dependency — the approved parsers are unchanged.

Exclusion is now earned, not assumed: `scanHtml` records every body it actually hands to
`scanJavaScript` or `scanCss`, and the raw pass excludes a tokenized body **only** when its tag and
exact text match one of those, consuming the match. A body the parser never delivered is therefore
still raw-scanned. Contextual exemptions inside real bodies, single-pass decoding, and the DOM walk are
untouched.

Tests — `src/test/build-output-scanner.test.ts`: the reported input for `script` **and** `style`; a
single-quoted `>`; a commented-out start tag; an unquoted attribute value; a mixed document where the
attribute is reported while both bodies keep their React and Tailwind exemptions; legitimate embedded
content with markup-like text in a script body; and a JSON script body reported as `unresolved` rather
than passed.

### R2-3 — Focus during catalogue recovery (`apps/web/src/hooks/app-controller.ts`)

**Confirmed.** After `PROVIDER_NOT_FOUND` the application moves focus to the provider step heading and
refreshes the catalogue. Every terminal `#loadProviders` outcome that renders a *different* surface
unmounted that heading without publishing a new destination, leaving keyboard focus on `body`.

`#replacementFocus()` now publishes `state-heading` for all three related outcomes — transport failure,
duplicate-id failure, and an empty (no official provider) catalogue — matching what `#loadAreas`
already did. It publishes nothing when the controller has never moved focus, so a first load that fails
does not pull focus away from where the browser left it.

Tests — `src/app/app.integration.test.tsx`, "focus when a surface the application focused is replaced":
four cases through the **real** `App`, `useAppController`, gateway and client, with separately gated
completions so the intermediate provider step is genuinely mounted and focused before it is replaced.
The first asserts the whole sequence `area-heading` → `provider-heading` → the error heading via
`document.activeElement`. All three replacement cases fail if `#replacementFocus()` is neutralised;
verified by reverting it in place.

### R2-4 — Required test matrix

The missing contract cases are listed in [Coverage matrix](#coverage-matrix) with their test locations.
The suite grew from 196 to **291** tests; the count is bookkeeping, not evidence — the matrix rows are.

Two specific criticisms are addressed directly:

- **`FakeGateway` no longer decides races.** `ignoreAbort(...)` makes the gateway deliver the scripted
  **success** even after its signal aborted, so only the controller's own ownership checks can keep it
  off the screen. Every supersession case in `describe('supersession across providers and areas')` uses
  it, and asserts `signal.aborted` directly through the new `signalsOf(...)` recording.
- **The unmount test no longer rests on an empty body.** It asserts the signal is unaborted while in
  flight, aborted immediately on unmount, that a success delivered afterwards issues no further request
  and renders no catalogue, and only then that the body is empty.

### R2-5 — Deterministic integration time (`apps/web/src/app/app.integration.test.tsx`)

**Confirmed.** The suite mounted the real `App`, which reads `browserClock.now()`, but pinned no
instant; the fixture capability is valid only for `2026-01-01`…`2026-12-31`, so the unchanged file
failed under a 2027 system date.

`freezeClock()` uses `vi.useFakeTimers({ toFake: ['Date'] })` with `IN_RANGE_INSTANT`
(`2026-06-15T09:00:00Z`) in `beforeEach`, and `vi.useRealTimers()` in `afterEach`. Only `Date` is
faked, so `setTimeout`, microtasks, and the testing-library waits the real composition depends on keep
running — the recovery-cycle case still drives a real `pageshow` event rather than a fake timer. The
real `App`, controller, gateway and client path is unchanged, and no production capability logic was
touched.

Out-of-range is now its own expected scenario: `describe('a capability the current date has outgrown')`
pins `OUT_OF_RANGE_INSTANT` (`2027-01-02T12:00:00Z`) and asserts the documented behaviour — the
uncovered state renders and **no** collection-events request is issued.

External-date verification: the reviewer's own unmodified configuration
(`/private/tmp/ar005-round2/future.config.mts`, which forces `2027-01-02T12:00:00Z` from a setup file)
now reports **18 passed**, where it previously reported 8 passed / 1 failed.

---

## Coverage matrix

| Required boundary | Where it is covered now |
| --- | --- |
| Three reads through the real wrapper, client and gateway | `app.integration.test.tsx` — "reads providers, areas, and events through the real client"; exact path order `P → A → P → A → E` |
| Same boundary reused by **Retry** | `app.integration.test.tsx` — "routes Retry through it after a rejected fetch"; `[P, P]` with `no-store` on both |
| Same boundary reused by **reconciliation** | "routes the one reconciled events retry through it after the first exact 422"; `[P, A, P, A, E, P, A, E]` |
| Same boundary reused by **range recovery** | "routes a range-recovery cycle through it on a lifecycle signal"; a real `pageshow` drives `[P, A]` |
| `RequestInit` member preservation, cache set last | "preserves the supplied members and sets the cache mode last on every read" — `method`, `accept`, `signal`, `cache`, and the exact key set; plus `adapters/browser-origin.test.ts` for a conflicting caller-supplied `cache` and for arbitrary members |
| Phase-aware failures, identical failures per phase | `app-controller.test.ts` — `describe('the phase and failure matrix')`: four transport failures × selection-providers, selection-areas, schedule-pipeline (on each of the three operations) and range-recovery, asserting the phase, the preserved real operation, and each phase's distinct Retry call order |
| Repeated unsuccessful Retry | Same block: two consecutive failed retries per failure kind in `selection_providers`, each re-reading only the catalogue and staying retryable; announcement sequence asserted to advance in "issues a fresh request for every unsuccessful Retry" |
| Subtype copy, announcements, identifier policy | `app.test.tsx` — `describe('failure subtypes, announcements, and the identifier policy')`: each of the four subtypes in three phases plus recovery, asserting the top-level state **and** the subtype's own German copy, the live-region text, and `requestId` only for `problem` (absence asserted on the value) |
| Local `source_date_unavailable` carries no transport metadata | `app-controller.test.ts` — "carries no fabricated transport metadata on a local source-date failure", asserted on the **key set** (`kind`, `timeZone`); rendered with no identifier in both owning phases in `app.test.tsx` |
| Selection phases cannot carry the local failure — **type level** | `app-controller.test.ts` — `describe('the failure type itself')`, two `@ts-expect-error` directives over `FailureContext`; an unused directive is itself an error, so loosening the type fails `tsc` |
| `cancelled` renders nothing | `app.test.tsx` — "renders no error surface for a cancelled attempt" |
| Supersession: two providers, two areas each | `app-controller.test.ts` — `describe('supersession across providers and areas')` |
| Newer reply before older | "keeps the newest selection when the older reply resolves last" (`releaseNewest` then `releaseOldest`) |
| Three rapid area changes | "renders the last of three rapid area confirmations and no intermediate reply" — publication history asserted, not just the final frame |
| Explicit abort assertion | `signalsOf('listServiceAreas')[0].aborted` and `signalsOf('listCollectionEvents')[0].aborted`; `app.integration.test.tsx` asserts the unmount abort on the real `AbortSignal` |
| Successor state and lifecycle owners preserved | "leaves the successor untouched: no error, no diagnostic, no extra request, one owner" |
| Late **successful** response ignoring abort | `FakeGateway.ignoreAbort(...)` used by every case above |
| Contextual decoding — JavaScript | `build-output-scanner.test.ts` — `describe('contextual decoding')`: `\uXXXX`, `\xXX`, whole-scheme, `\u{…}`, in double quotes, single quotes and templates; mixed case and mixed forms; line continuation; substituted template and a literal inside its expression; tagged templates |
| Single-pass decoding | "decodes once: a literal backslash sequence is not a URL" — the doubled-backslash fixture passes |
| Contextual decoding — CSS and HTML | Escaped `url()`, CSS string and `@import`; named, decimal and hex character references; style attributes, event attributes, and nested `srcdoc` |
| Inertness | "executes nothing and requests nothing while scanning": a marker global stays unset, a stubbed `fetch` is never called, and the forbidden references are still reported |
| Malformed / unresolved | JavaScript syntax → `javascript-syntax`; CSS syntax → `css-syntax`; an uninterpretable escape returns `undefined` |
| Valid division, regex, Unicode positives | "passes ordinary division, regular expressions, and non-URL Unicode escapes" |
| Namespace matrix | `describe('the platform-namespace exemption')`: all seven allowlisted literals exempt; six near matches and same-host URLs rejected; scanning continues past an exempt literal |
| Tailwind matrix | `describe('the Tailwind license-comment exemption')`: exact banner; banner plus prohibited `url()`; banner plus absolute `@import`; banner text in a CSS string; the host in JS, HTML and CSS; a modified comment carrying an extra URL; another URL on the host; only the matched comment range excluded |
| React matrix | `describe('the React diagnostic-literal exemption')`: the three permitted literal forms including the bundled formatter's shape; an escaped whole value; substituted template, first-segment-only, changed path, embedded, `react.dev`, `/other`, tagged, HTML attribute, CSS `url()`, lookalike host; neighbouring forbidden URL still reported; clean multi-asset set and the same set plus one origin |
| Zod matrix | `describe("the Zod IPv6 URL-parsing-scaffold exemption")`: observed `ipv6` and `cidrv6` shapes; renamed identifier paths; six changed static segments; zero, two and partial substitutions; five non-identifier interpolations; outside `try`/`catch`; four used-not-discarded forms; seven network operations; lookalikes in a legal comment and in string literals; forbidden neighbour; diagnostics → unresolved; division and regex beside a permitted scaffold |
| Tailwind discovery mutations | `boundaries.test.ts` — "detects a removed `source(none)`, a removed exclusion, and an added positive registration" |
| Five source-date checkpoints | `app-controller.test.ts` — `describe('source-date derivation failure at every checkpoint')`, with the events-request count asserted for each |

Ordinary fixture tests and fresh-build artifact verification remain separate: `vitest.config.ts`
excludes `src/test/build-output.verify.ts`, which runs only under Turbo's `test:build-output` after a
build.

---

## Commands and results

All run from the repository root unless stated. Logs were written to `/tmp/ar005-r3-*.log`.

| Command | Result |
| --- | --- |
| `pnpm check` | exit 0 — format, lint, typecheck, test, build, outer verifier |
| `pnpm --filter @abfall-radar/web test` | **291 passed**, 14 files (196 before this round) |
| `pnpm --filter @abfall-radar/web typecheck` | exit 0 (`tsc --noEmit`) |
| `pnpm --filter @abfall-radar/web build` | fresh production build, 2717 modules |
| `pnpm exec turbo run test:build-output --filter=@abfall-radar/web` | exit 0, **5/5**, `cache bypass, force executing` |
| `pnpm exec biome lint .` | clean, no warnings |
| `git diff --check` | exit 0 |
| Reviewer reproduction `scanner.test.tsx` | **4/4** (was 2 passed / 2 failed) — R2-1 and R2-2 |
| Reviewer reproduction `focus.test.tsx` | **1/1** (was failing) — R2-3 |
| Reviewer configuration `future.config.mts` | **18/18** at a forced 2027 date (was 8 passed / 1 failed) — R2-5 |
| Fix-verification: `#replacementFocus()` neutralised in place | the three R2-3 regressions fail, then pass again once restored |

Per-file test counts: `app-controller.test.ts` 82, `build-output-scanner.test.ts` 54,
`boundaries.test.ts` 38, `app.test.tsx` 36, `app.integration.test.tsx` 18, `browser-origin.test.ts` 8,
and 55 across the calendar and invariant modules.

---

## Production dependency guard (Check 1b)

- **Source shell**: the emitted `index.html` template is compared byte for byte against a copy
  transcribed independently from AR-005, allowing only CRLF and a final line feed to differ. The sole
  HTML edge is `/src/main.tsx`; an extra resource link is a rejection fixture.
- **Build inputs**: resolved `root` is `apps/web`, `publicDir` resolves to `''` (`publicDir: false`),
  `build.lib` is `false`, and `build.rollupOptions.input` is undefined — the default HTML entry only.
  The declared build command is `vite build`, with no CLI entry or config override.
- **Extraction is parser-based**: `ts.createProgram` with `noEmit`, `noResolve`, `noLib`, and public
  `getSyntacticDiagnostics`; no file is emitted and no internal member is accessed. Resolved
  `typescript` **5.9.3**.
- **Walk from `src/main.tsx`** (entry chain rooted at `index.html`): **39 first-party script modules**
  visited, **0 problems**, **0 unresolved imports**, and **no resolved target inside
  `apps/web/src/test/**` or any `*.test.*` / `*.spec.*` module**. Third-party packages are identified
  and stopped at: `react@19.2.8`, `react-dom@19.2.8`, `zod@4.4.3`, `tailwindcss@4.3.3`,
  `date-fns@4.4.0`, `lucide-react@1.26.0`.
- **Stylesheets**: **2 entered** — `apps/web/src/app/styles.css` and `packages/ui/src/styles.css` — and
  **2 CSS dependency edges followed**, so the `styles.css` import chain (Tailwind and the shared UI
  stylesheet) was traversed rather than terminated at. **0 leaf resources**: the production graph
  currently references no image or font asset. Resolved `postcss` **8.5.28**,
  `postcss-value-parser` **4.2.0**.
- A clean graph for today's source does not by itself prove the guard complete for every admissible
  input; that is what the R2-1 rejection fixtures are for.

### Tailwind content discovery — recorded separately

- `source(none)` present on the canonical `@import "tailwindcss"`: **yes**.
- Positive registrations, exactly three: `../../index.html`, `..`, `../../../../packages/ui/src`.
- Exclusions found: **nine** — `../test`, the four `../**/*.{test,spec}.{ts,tsx}` directives, and the
  four `packages/ui/src` equivalents. **Note for the owner:** AR-005's directive block (lines 909–917)
  and its table (1 + 4 + 4) both specify nine, while one prose sentence in the same section says
  "eight". The stylesheet matches the normative block. The prose count appears to be an off-by-one in
  the approved document; it is reported here rather than resolved by changing either side.
- Effective scanned file set: **27 files**, containing **no** protected file — judged on files, not on
  a glob base.
- Post-build: `tracking-[0.1337em]` and `tracking-[0.4242em]` are both absent from generated CSS, while
  the production web candidate (`min-h-dvh`) and the shared-UI candidate (`shadow-ar-brand`) are
  present. `.rounded-ar-md{border-radius:var(--ar-radius-md)}` is present, as it has been since the
  round-1 fix.

---

## Dependencies

No new approval is requested. The owner approval recorded in AR-005 §
[Dependency approval record](AR-005-responsive-web-schedule.md#dependency-approval-record) covers both
packages at both versions: approved by the repository owner on **2026-09-15**, for `postcss` **8.5.28**
and `postcss-value-parser` **4.2.0**, as `devDependencies` of `apps/web` only, through `catalog:`.

Confirmed against the diff: `pnpm-workspace.yaml` gained exactly those two catalogue entries
(`postcss: 8.5.28`, `postcss-value-parser: 4.2.0`) with no other catalogue version changed, and both
appear only in `apps/web/package.json` under `devDependencies`. No other workspace or the root manifest
declares either package. No different version or scope was needed, so the task is not Blocked and CSS
traversal is implemented.

---

## Emitted-artifact scan (Check 2)

Parser versions: `typescript` **5.9.3**, `jsdom` **29.1.1**, `postcss` **8.5.28**,
`postcss-value-parser` **4.2.0**.

Fresh build: `index.html` 0.39 kB, `assets/index-DAYnRP7B.css` 13.33 kB,
`assets/index-Tjn7suYA.js` 306.52 kB.

Every absolute HTTP(S) occurrence detected in that build, classified:

| Value | Category | Count | Asset |
| --- | --- | --- | --- |
| `http://www.w3.org/2000/svg` | namespace | 6 | JS |
| `http://www.w3.org/1999/xlink` | namespace | 7 | JS |
| `http://www.w3.org/1998/Math/MathML` | namespace | 3 | JS |
| `http://www.w3.org/XML/1998/namespace` | namespace | 3 | JS |
| `https://json-schema.org/draft/2020-12/schema` | namespace | 1 | JS |
| `http://json-schema.org/draft-07/schema#` | namespace | 1 | JS |
| `http://json-schema.org/draft-04/schema#` | namespace | 1 | JS |
| `https://react.dev/errors/` | react | 2 | JS |
| `` `http://[${n.value}]` `` | zod | 1 | JS |
| `` `http://[${e}]` `` | zod | 1 | JS |
| `/*! tailwindcss v4.3.3 \| MIT License \| https://tailwindcss.com */` | tailwind | 1 | CSS |

Totals: **27 exempt** (22 namespace, 2 React, 2 Zod, 1 Tailwind), **0 violations**, **0 unresolved**,
and **0 occurrences in HTML**. The three `json-schema.org` dialect identifiers are present, as AR-005
anticipated, and are recorded as exact namespace literals with their justification in
`build-output-scanner.ts`: they are `$schema` dialect identifiers written by `zod`'s `toJSONSchema`,
never requested. No exemption was widened this round; the four sanctioned categories are unchanged.

Contextual-decoding fixture results are in [Coverage matrix](#coverage-matrix); every documented case
has its stated result and no syntax or decoding failure remained in the artifacts.

**Document foundation.** The emitted `index.html` carries `lang="de"` and exactly one
`<meta name="viewport" content="width=device-width, initial-scale=1">` with no zoom-disabling
directive. This is a **declaration** check only — the 320 px and 44 px evidence must come from the
manual browser passes below, which have not been performed.

---

## Recovery, publication gate, and source-date checkpoints

**Range-recovery entry, per entry-producing flow.** Observation window: the gateway call log from the
end of the selection reads onward (`calls.slice(2)`).

| Entry path | Qualifying evidence | Immediate cycle |
| --- | --- | --- |
| Local, capability-derived (Path 1) | Present — the entry pipeline's own fresh `listProviders` and `listServiceAreas` | **Reused**, not re-run: the window shows exactly `[listProviders, listServiceAreas]` and **0** events requests; one coordinator, no watchdog |
| Terminal 422 (Path 2) | Present, from the reconciled attempt | Reused; the terminal state carries the **second** problem's `requestId`, and the first exact problem alone does not render one |

**Publication gate.** Every publication path re-reads the injected clock and compares against that
request's own captured `sourceToday`: initial, reconciled retry, and recovery cycle. The
identical-clamped-bounds case runs through the real controller gate — two consecutive source days whose
clamped window is byte-identical still supersede and re-request, proving the bounds never stand in for
the date ("supersedes a candidate at the publication gate even when the clamped bounds are identical").
There is an asynchronous response-processing stage in all three paths, so no path is reported as
unexercised.

**Derivation failure at all five checkpoints**, each as `source_date_unavailable` with no operation,
status, or `requestId`, with the observed events-request count:

| Checkpoint | Events requests | Resulting state |
| --- | --- | --- |
| Schedule-pipeline preflight | **0** — the dependent request was never issued | `error`, `schedule_pipeline`, no lifecycle owner |
| Initial publication gate | **1** — its request had already completed | `error`, no watchdog, no coordinator |
| Reconciled publication gate | **2** — the initial 422 and the reconciled retry | `error`, `schedule_pipeline` |
| Accepted-pair watchdog | **1** — no further request follows the failed check | `error`, watchdog stopped |
| Range-recovery preflight | **0** — the cycle issued none | `range_not_covered`, coordinator retained |
| Recovered publication gate | **1** — the recovered request had already completed | `range_not_covered`, coordinator retained |

**Lifecycle ownership.** At most one of the accepted-pair watchdog and the range-recovery coordinator
was ever active for a confirmed selection, asserted through `lifecycleOwners` at every transition in
the tests above. A wake burst of `visible`, `pageshow`, and `focus` produces one clock read, one
derivation, and one rearmed timer.

---

## Browser checks — not performed

No browser automation is available in this environment: the session exposes no browser tool, and a
loopback address cannot be fetched by the available fetcher. **No browser acceptance is claimed.**
jsdom results, `toBeVisible()`, emitted viewport declarations, and `document.activeElement` assertions
are **not** offered as evidence for any item below. DOM-focus tests show which element receives focus;
they say nothing about the visible focus indicator.

The full step-by-step checklist, with an expected result per step and the live values to compare
against, is `/Users/alex/Downloads/AR-005-manual-acceptance.md`. The summary below is the same scope.

### Startup

```bash
pnpm install                     # once
pnpm dev:api                     # API on http://127.0.0.1:3000
pnpm dev:web                     # web on http://localhost:5173
```

Open `http://localhost:5173`. `/api/**` is proxied to `127.0.0.1:3000`; nothing else is. Stop with
`Ctrl+C` in each terminal, or `kill $(lsof -ti :5173)` and `kill $(lsof -ti :3000)`.

### Acceptance session — transport-level verification performed

Both services were started from that configuration and exercised with `curl`. This is **not** browser
evidence; it establishes only that the session a person will accept against is reachable and serving.

| Check | Result |
| --- | --- |
| `GET http://localhost:5173/` | `200 text/html` |
| `GET http://127.0.0.1:3000/health` | `200` |
| `GET http://localhost:5173/api/v1/providers` (same-origin path) | `200 application/json` — `demo` and `koblenz-servicebetrieb` |
| `GET …/providers/koblenz-servicebetrieb/service-areas` | `200` — one area, `available`, `Europe/Berlin`, validity `2026-01-01`…`2026-12-31` |
| `GET …/collection-events?from=2026-09-16&to=2026-12-15` | `200` — 13 events, `freshness: fresh`, curbside and mobile drop-off both present, first drop-off `2026-11-07` 10:00–12:00 with location |
| Same-origin path with `apps/api` stopped | **`502 text/plain`** — an unusable response, not a connection failure, exactly as `apps/web/README.md` documents. The failure surface must therefore show "Der Dienst hat unbrauchbare Daten zurückgegeben." with no identifier |
| Page request with `apps/api` stopped | `200` — the dev server keeps serving the application |
| Same-origin path after restarting `apps/api` | `200` — recovery confirmed at the transport level |

Live conditions observed for the conditional entries below: **one** official provider with **one**
area, so switching and supersession are not live-reproducible; source-local today `2026-09-16` lies
**inside** the capability window, so the local `range_not_covered` path is not live-reproducible; the
nearest event `2026-09-22` is six days out, inside the seven-day relative window, while the device zone
is `Europe/Berlin` — the same zone as the source — so the cross-date relative-label prerequisite does
not hold.

### Checklist

| # | Check | Expected outcome |
| --- | --- | --- |
| 1 | Layout at 320, 390, 768 and 1280 px CSS width | No horizontal scrolling, no clipped or overlapping text, controls remain reachable at every width |
| 2 | 200 % browser zoom at 320 px and at 1280 px | Content reflows; nothing is cut off or made unreachable; no zoom is blocked |
| 3 | Long content | Substitute a long provider name, a long area name, and a long event title; text wraps or truncates visibly rather than overflowing its container |
| 4 | Contrast | Body text, muted text, and the brand button meet WCAG AA against their backgrounds |
| 5 | Visible focus | Tab through provider choices, area choices, and all actions; each shows a clearly visible focus indicator (not only `:focus`, but a visible outline) |
| 6 | Touch targets | Every button measures at least 44 × 44 CSS px as rendered |
| 7 | `Zurück` on the area step | Returns to the provider step and focus lands on **the provider button that opened the area step** — record which provider |
| 8 | `Auswahl ändern` from a schedule | Returns to selection with the confirmed provider and area still shown as defaults; record where focus landed |
| 9 | `Erneut versuchen` on a failure surface | Stop `pnpm dev:api`, reload, then retry after restarting it; record the surface used and where focus landed. Expect the **unusable-response** wording, not the offline wording — the dev proxy answers `502 text/plain` while the API is down |
| 10 | Live announcements | With a screen reader, confirm each state change is announced once and that a repeated identical message is announced again |
| 11 | Reduced motion | With `prefers-reduced-motion: reduce`, no animation or transition remains |

### Conditional and not-applicable entries

- **Provider and area switching (7 partly, and every supersession scenario)**: the live catalogue offers
  **one** official provider with **one** area. Record these as **not applicable**, naming the observed
  catalogue — the automated two-provider/two-area fixtures exist precisely because the live data cannot
  exercise them.
- **Relative-day labels**: record the prerequisites before recording a result — an accepted event inside
  the relative window, and a device zone plus verification instant that put source-local and
  device-local on **different** calendar dates. If they do not hold, record `not applicable` with the
  observed instant, both zones, the derived source-local date, and each accepted event's date and
  rendered label. An unchanged absolute label or an empty result set is not evidence.
- **`range_not_covered` — local, capability-derived path**: reachable live whenever source-local today
  lies beyond the selected capability's validity. Read the window from the live capability; it was
  `2026-01-01` to `2026-12-31` when this task was written. Record **verified** with the actual window
  and date, or **not currently reproducible with the selected live capability**, naming that window.
- **`range_not_covered` — terminal 422 path**: not reproducible by ordinary live manual use; record it
  as such rather than as a property of the whole state.
- **Source midnight**: covered by deterministic automated tests. Do not wait for a real midnight and do
  not record waiting as a manual check.
- **Empty schedule state**: not live-reproducible — the current range returns 13 events. Record
  `not applicable` with that count.

**Recording.** The result of each step belongs in this document: the browser and version, each viewport
width and zoom level exercised, which long-content substitutions were used, where focus landed for
`Zurück`, `Auswahl ändern` and `Erneut versuchen`, and every `not applicable` entry with its
prerequisite. A pass may not be recorded for a step that was not exercised.

---

## Round 1 disposition

Independently confirmed resolved by the second review, and unchanged this round except where noted:
the render loop on mount (1); the Strict Mode restart (2); unknown `problem.code` via `ReadonlyMap` (3);
derived announcements including recovery failures and the local date failure (6); focus after an area
error (7 — the adjacent catalogue case is R2-3 above); the retained draft area on `Auswahl ändern` (9);
`Zurück` focusing the provider that opened the step (10); watchdog burst coalescing (11); and the
emitted `.rounded-ar-md` utility (12). Findings 4, 5 and 8 were resolved in part and are closed by
R2-1, R2-2 and R2-4 respectively.

## Residual risks

- The HTML tokenizer implements the states that decide raw-text body boundaries, not the whole HTML
  tokenizer. It is deliberately conservative: an unrecognised construct leaves a body **unexcluded**, so
  a mistake produces an extra report rather than a silent miss.
- The CSS guard treats a backslash followed by a newline inside an identifier as a continuation. That is
  more permissive than the CSS grammar and therefore fails closed — it can only add findings.
- Manual browser acceptance is outstanding in full; see above. "No defects found in the reviewed code"
  is not "implementation acceptance verified".
