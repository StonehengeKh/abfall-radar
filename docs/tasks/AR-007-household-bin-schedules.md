# AR-007: Optional household Bioabfall and Restabfall schedules

- Status: Implemented; independent review **APPROVE** (2026-09-24). Not merged, not deployed, extension
  not published.
- Owner: Claude Code (implementer), Codex (reviewer)
- Branch: `feat/household-bin-schedules`, from `main` at `2c3cbd9`

## Goal

A person can opt in to seeing their Braune Tonne (Bioabfall) and Graue Tonne (Restabfall) collections
beside the official calendar events, in both applications — **labelled as calculated** from the
municipality's published rules and a weekday the person confirmed, never presented as published
digital-calendar events.

## What the official source actually publishes

Read live on 2026-09-23.

| Source | URL | What it gives |
| --- | --- | --- |
| Schedule page | `…/abfallwirtschaft/entsorgungstermine/` | The parity rule, stated for a named year: "Grundsätzlich gilt für 2026: in geraden Kalenderwochen: Abfuhr Braune Tonne / in ungeraden Kalenderwochen: Abfuhr der Grauen Tonne". States the household's weekday is **not published** — it must be asked by telephone (129-4545). Links the holiday table. |
| Holiday shifts 2026 | `…/downloads/abfallratgeber-zusatzinformationen/feiertagsverlegungen-2026.jpg` | The complete annual table of collection-date replacements, **as a JPEG image**. Titled "Abfuhr Braune / Graue Tonne, Abfallgroßbehälter in Wochen mit Feiertagen". |
| Brochure, page 23 | `…/downloads/broschueren/ksk-abfallratgeber-26-ai.pdf` | The **same table**, as extractable text, plus the parity rule again. A second official publication, and the one that makes every row independently readable. |
| Digital calendars | `…/abfallwirtschaft/entsorgungstermine-digital/` | ICS feeds that **exclude** both bins: "Altpapier – Grünschnitt – Gelbe Säcke – Weihnachtsbäume und Schadstoffe/Elektrokleinteile". Holidays are already accounted for **in those** feeds. |
| Press announcements | `…/presse/` | Per-holiday notices that restate individual rows of the annual table. |

Three consequences decide the design:

1. **There is no machine-readable source for these two bins.** No ICS, no table, no API — the only
   complete statement of the 2026 shifts is an image.
2. **The weekday is household-specific and unpublished.** It can only come from the person.
3. **The published rules are bounded, and where they stop is a judgement.** See the coverage section
   below: the last described day is 2026-12-26, and stopping there is this implementation's conservative
   choice rather than a statement the operator makes.

### Automatic versus maintained

| Part | How it is obtained |
| --- | --- |
| Week-parity rule | **Maintained transcription** of the schedule page, read again from brochure page 23. |
| 2026 holiday replacements | **Maintained transcription**, read from the image and again from the brochure text. |
| Household weekday | **From the person**, confirmed explicitly. Never guessed, never derived from another household. |
| Change detection | **Automatic, and bounded** — see below. |

Nothing here claims automatic extraction. The transcription is the data; the fetches establish only that
the published sources still say what was transcribed from them.

### What the automatic checks do and do not establish

Three checks run on every read of the rules, reported separately because they fail separately and mean
different things:

| Check | Establishes | Gap it closes |
| --- | --- | --- |
| `table` | The linked image is byte-for-byte the document that was transcribed. | The rows changing under the same URL. |
| `parityRule` | The page still states the same parity, **for the same year**. | The sentence changing while the image does not — a digest check alone would call that verified. |
| `tableLink` | The page still links *that* table. | A new year's table published at a new URL with the old file left in place, which a URL-pinned digest check would keep calling verified forever. |

`verification` is one word for the three: `changed` if any changed, `verified` only if all three
verified, `unverified` otherwise. **A partly checked schedule is never reported as verified.**

**Not automated at all: the operator's announcements.** The per-holiday notices are free prose on a news
page. A notice that *amends* a row looks exactly like one that restates it, so a parser would be a
machine inventing collection dates. Reading them is a human responsibility, and the transcription records
how far it has been done in `announcementsReviewedThrough` (currently **2026-09-23**), which both clients
display. An announcement published after that date could amend a row and this build would not know.

### Which rows have independent corroboration

All nine rows were read twice: from the linked image, and from page 23 of the operator's 2026 brochure,
whose text version states them identically. **Seven** are additionally restated by a dated press notice:

| Holiday | Image | Brochure p. 23 | Press notice |
| --- | --- | --- | --- |
| Neujahr | yes | yes | — (a notice would have been published in December 2025, outside the site's 2026 listing) |
| Rosenmontag | yes | yes | [2026-02-09](https://servicebetrieb.koblenz.de/presse/2026-02-09-rosenmontag-bedingt-die-nachverlegung-der-leerung-der-biotonnen/) |
| Karfreitag | yes | yes | 2026-03-20 |
| Ostermontag | yes | yes | 2026-04-02 |
| Maifeiertag | yes | yes | 2026-04-27 |
| Christi Himmelfahrt | yes | yes | 2026-05-04 |
| Pfingstmontag | yes | yes | 2026-05-18 |
| Fronleichnam | yes | yes | 2026-05-28 |
| Weihnachten I | yes | yes | — (not yet published; it would appear in December 2026) |

So **two** rows — Neujahr and Weihnachten I — rest on the two official tables alone, with no third
statement restating them. Neither absence is evidence against the row: one notice predates the site's
2026 press listing and the other has not been published yet. They are simply rows with one fewer
independent reading, which is what a future audit needs to know.

The Rosenmontag notice states the row exactly: "Die Biotonnen der Montagsreviere werden am Dienstag, die
Biotonnen der Dienstagsreviere werden am Mittwoch usw. entleert."


### The transcribed 2026 table

Every replacement maps one **nominal** collection date to the date the operator actually collects.
`←` is a Vorverlegung, `→` a Nachverlegung. Cross-checks name the press notice that restates the row.

| Holiday | Replacements | Cross-check |
| --- | --- | --- |
| Neujahr (01.01. Do) | 01.01.→02.01., 02.01.→03.01. | — |
| Rosenmontag (16.02. Mo) | 16.02.→17.02., 17.02.→18.02., 18.02.→19.02., 19.02.→20.02., 20.02.→21.02. | 2026-02-09 notice |
| Karfreitag (03.04. Fr) | 30.03.←28.03., 31.03.←30.03., 01.04.←31.03., 02.04.←01.04., 03.04.←02.04. | 2026-03-20 notice |
| Ostermontag (06.04. Mo) | 06.04.→07.04., 07.04.→08.04., 08.04.→09.04., 09.04.→10.04., 10.04.→11.04. | 2026-04-02 notice |
| Maifeiertag (01.05. Fr) | 01.05.→02.05. | 2026-04-27 notice (Freitagsreviere only) |
| Christi Himmelfahrt (14.05. Do) | 14.05.→15.05., 15.05.→16.05. | 2026-05-04 notice |
| Pfingstmontag (25.05. Mo) | 25.05.→26.05., 26.05.→27.05., 27.05.→28.05., 28.05.→29.05., 29.05.→30.05. | 2026-05-18 notice |
| Fronleichnam (04.06. Do) | 04.06.→05.06., 05.06.→06.06. | 2026-05-28 notice |
| Weihnachten I (25.12. Fr) | 21.12.←19.12., 22.12.←21.12., 23.12.←22.12., 24.12.←23.12., 25.12.←24.12. | — |

## Rules the calculation follows

1. The waste type comes from the **nominal** week: even ISO week → `bio`, odd → `residual`.
2. The date is the nominal date, unless the table replaces it — then the replacement date is used, and
   the waste type is unchanged. Monday 2026-03-30 (week 14, even → Bioabfall) is collected Saturday
   2026-03-28, still Bioabfall, although that Saturday falls in an odd week.
3. A replacement is applied **once**. Replacements are keyed by nominal date, so a cascade
   (Thursday→Friday, Friday→Saturday) never chains.
4. Dates are Europe/Berlin calendar dates and ISO weeks, never derived from the device's zone.
5. Nothing is generated outside the coverage window. Beyond it the surface says coverage is limited; it
   never extrapolates the parity rule, which the operator states per year rather than as a standing rule.
6. A collection the operator moves **into** the requested range is included, and one moved **out** of it
   is not: the range is about the day a bin is actually collected. The nominal search window is widened
   by the largest displacement the rules contain, so an Easter Vorverlegung onto a Saturday is found when
   that Saturday alone is asked about.
6. Official API events are never shifted, re-labelled or deduplicated against these.

## Coverage: 2026-01-01 to 2026-12-26, and why it stops there

**This is a deliberate conservative implementation cutoff, not a municipal statement.** What the operator
actually publishes:

- both 2026 tables — the linked image and brochure page 23 — end with a "Weihnachten I" row describing
  the week to Saturday 2026-12-26, and neither carries a row after it;
- the parity rule is written for a named year ("Grundsätzlich gilt für 2026");
- nothing published for 2026 describes the week beginning Monday 2026-12-28.

What remains **unverified**:

- whether collections in that last week of 2026 are moved at all. The week contains Neujahr 2027, and the
  operator does move such weeks — the 2026 table's own first row moves the week containing 01.01.2026 and
  reaches back into December 2025. That pattern suggests the week of 2026-12-28 will appear in the 2027
  table, which does not exist yet. **That is an inference from how the operator lays these tables out, not
  something anybody published.**
- The 2026 brochure lists 24.12.26 and 31.12.26 as **facility closing days** (Wertstoffhof, office). Those
  are not kerbside collection rules and were not treated as any.

Note that 2026-12-28 is in ISO week 53 **of 2026**, not of 2027, so the cutoff is not a calendar-year or
ISO-year boundary and is not described as one. Past 2026-12-26 both applications report limited coverage
and generate nothing.

## Scope

1. **Domain** — the rules shape and its schema.
2. **`packages/data-providers`** — the maintained Koblenz transcription, the digest check against the
   published image, and the failure conventions already used for sources.
3. **`apps/api`** — one read endpoint serving the rules with provenance, coverage and verification state.
4. **`packages/api-client`** — the transport contract and validator.
5. **`packages/schedule-format`** — the pure calculation, framework-free, with no network or parsing.
6. **`apps/web` and `apps/extension`** — optional setup (enable, confirm weekday, edit, disable), tied to
   the confirmed location, with safe storage migrations and independent storage per application.

## Non-goals

- Presenting calculated dates as published digital-calendar events.
- Scraping the municipal site from either client.
- Extrapolating beyond the published coverage window.
- Live truck tracking, or changing what the official feeds cover.

## Acceptance criteria

- [x] The four confirmed household dates are produced for a Monday household in Koblenz, Neuendorf.
- [x] Every one of the nine transcribed holidays maps as tabulated, including both Vorverlegung rows.
- [x] A replacement crossing a week boundary keeps the nominal week's waste type.
- [x] Beyond 2026-12-26 the applications report limited coverage rather than generating dates.
- [x] A changed or unreachable official image stops the rules being presented as verified, and never
      produces plausible dates silently.
- [x] A source outage leaves the person's configuration intact.
- [x] Calculated collections are labelled as such wherever they appear, including reminders.
- [x] Official feed coverage, ordering and identities are unchanged.

## Outcome

Recorded in [ADR 0007](../decisions/0007-calculated-household-collections.md). What was built:

| Layer | What it does |
| --- | --- |
| `packages/domain` | The rule shape, the check breakdown, and the household setup, all schema-validated. |
| `packages/schedule-format` | The pure calculation: ISO weeks, nominal-week waste type, one replacement per nominal date, coverage boundary, and a search window widened by the largest published displacement. |
| `packages/data-providers` | The maintained Koblenz transcription and the three automatic source checks. |
| `apps/api` | `GET /api/v1/providers/{providerId}/household-rules`, serving rules with provenance, coverage and checks. |
| `packages/api-client` | The validated transport contract. |
| `apps/web` | Opt-in panel, weekday bound to the district, merge into the ordered schedule, badge and disclosures. |
| `apps/extension` | Settings v4 with a migration, a worker message, the same merge and badge, a status line, and calculated collections in the reminder. |

### Defects found while building, and fixed

- **A collection moved *into* a range was missed.** Asking about Saturday 2026-03-28 alone found no
  Monday to move, so the Easter Vorverlegung — the one case the operator publishes a notice about —
  produced nothing. The reminder regression test caught it. The nominal search window is now widened by
  the largest displacement the rules contain, and results are cut back by their **actual** dates.
- **A reminder could announce the same morning twice.** The shown-record held one key and the
  notification was keyed on the leading collection, so a changed set between runs — the official schedule
  answering once and not the next time — produced a second notification. Reminders are now keyed on the
  morning, which is what one notification per day actually means.

### Verification

- `pnpm check`: **exit 0**. Tests: extension 1210, web 560, api-client 381, data-providers 223, API 155,
  schedule-format 74, domain 23.
- The three source checks were run against the **live** operator site and all three passed.
- Both applications were driven in a browser against the local API with the confirmed household
  (Koblenz, Neuendorf, Monday): the confirmed dates appeared, badged, beside unchanged official events;
  the setting survived reopening; disabling restored exactly the official rows; no console errors; no
  overflow at 320 px with doubled text.

### Limitations

- **Text enlargement was simulated** (root font size doubled), not native browser zoom.
- Headless Chromium, not the real toolbar action popup: native worker suspension, alarms and delivered
  notifications were not observed. The reminder path is covered by tests against the real settings
  repository and worker gateway instead.
- The operator's announcements are not monitored automatically; `announcementsReviewedThrough` records
  how far they have been read, and both applications display it.
- Coverage ends 2026-12-26 as a conservative cutoff; the week of 2026-12-28 is unverified rather than
  known to be empty.
