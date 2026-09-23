# AR-006: Align the extension with the web application

- Status: Implemented; independent review **APPROVE** (2026-09-23). Not merged, not deployed, extension
  not published.
- Owner: Claude Code (implementer), Codex (reviewer)

## Goal

A person using the Chrome extension sees the same product as on the website: the same brand, the same
city-first selection, the same schedule presentation, and the same language and appearance choices — in
a layout built for a compact popup — while the extension keeps the request, storage and reminder
architecture it already has.

## Context

- [ADR 0004](../decisions/0004-extension-api-integration.md) and [AR-004](AR-004-extension-api-integration.md)
  already connected the extension to the shared API. [ADR 0005](../decisions/0005-responsive-web-schedule.md)
  and its addenda define the web application this task aligns with.
- **The extension's data flow today**, traced on `main` at `cb8a1ff`:
  popup (React) → `messaging/client.ts` → `chrome.runtime` message → service-worker
  `background/gateway.ts` → `@abfall-radar/api-client` → HTTP API. An import-graph test proves the
  popup cannot reach `@abfall-radar/api-client`. No fixture and no direct provider access is involved.
- The API origin is already configurable: `WXT_API_BASE_URL`, validated by `src/config/api-origin.ts`,
  loopback `http://127.0.0.1:3000` when unset, a release guard, and the manifest host permission derived
  from the same value. No production URL is invented.
- What differs from the web today:
  - selection is provider-first; the gateway has no `list_cities` message, although the API serves
    `/api/v1/cities`;
  - there is no localization — German copy is written into the components;
  - there is no appearance setting and no dark palette;
  - settings are version 2: selection, reminders and `visibleWasteTypes`, no language or appearance;
  - the schedule presentation is the extension's own; `packages/ui` shares only `BrandMark`,
    `WasteIcon` and the design tokens;
  - schedule logic is duplicated and has diverged: `collection-window.ts`, `schedule-range.ts` and
    `view-state.ts` exist in both applications with different contents, and `source-day`, `event-order`,
    `collection-day` and the date formatting exist only in `apps/web/src`.
- Bioabfall and Restabfall exist in the domain and presentation layer, but the Koblenz digital calendars
  do not publish them; the operator publishes grey- and brown-bin dates by telephone only. That coverage
  limitation is preserved.

## Scope

1. **Shared code, one copy.** Framework-free schedule and formatting rules move into a focused shared
   package; shared presentational React components move into `@abfall-radar/ui`. The web application
   consumes them with its behaviour unchanged. Controllers, navigation, storage and application copy stay
   in each application.
2. **City-first selection in the extension.** A `list_cities` gateway message, and the web's semantics:
   city → provider only when a city has more than one → district → confirm. The stored selection keeps
   its current shape; its city is derived from the district on revalidation.
3. **Language and appearance in the extension.** German, English, Ukrainian and Russian; light, dark and
   system. Stored in the extension's own settings, version 3, with a migration from version 2 that keeps
   every existing value. No synchronisation with the website.
4. **The popup on the shared presentation.** Brand header, language and appearance controls, featured
   collection with the collection-day status, countdown, event rows, provenance, and the loading, error,
   retry, empty and partial-coverage states — adapted to the popup's width and scrolling.
5. **Records.** An ADR 0004 addendum for the settings and messaging changes, and a decision record for
   the new shared package.

## Non-goals

- A second request pipeline, requests from the popup, or any change to the configured-origin rules.
- New schedule caching. AR-004's existing offline cache is kept as it is.
- Preference synchronisation between the extension and the website.
- Localized reminder notifications — a follow-up.
- Generating Bioabfall or Restabfall dates, or renaming Grünschnitt.
- Publishing the extension, or verifying a deployed API that does not exist yet.

## Acceptance criteria

- [x] The extension still requests only through the service-worker gateway, and the popup still cannot
      reach `@abfall-radar/api-client`.
- [x] A test through the production extension composition root proves requests go to the configured API
      client rather than an injected substitute.
- [x] Selection is city-first, with the provider step shown only for a city with more than one provider.
- [x] A saved version-2 selection and every saved setting survive the upgrade and are revalidated through
      the API before use.
- [x] Language and appearance persist across popup reopenings, in all four languages and three modes.
- [x] Source-local dates, the countdown target, the collection-day status, several types on one date,
      the featured event shown once, drop-off windows and provenance behave as on the web, from shared
      code rather than copies.
- [x] Loading, error with Retry, empty and partial-coverage states are usable.
- [x] The web application's behaviour and its build-boundary checks are unchanged. Its **test count
      changed because tests moved with the code**: 579 in 27 files at `cb8a1ff`, 543 in 22 files now,
      the difference being the 36 tests relocated to `@abfall-radar/schedule-format` (which holds 50:
      those 36, 10 moved from the extension, and 4 new). The inventory is in
      [ADR 0006](../decisions/0006-schedule-format-package.md). No web assertion was removed, and none
      was added back to restore the number.

## Responsive and accessibility requirements

- [x] The popup has no horizontal overflow and no obscured control at its fixed width.
- [x] Long translated labels wrap rather than truncate.
- [x] Keyboard operation, visible focus and accessible names are verified in the built extension.

## Verification

```bash
pnpm check
```

Plus: the built unpacked extension loaded in Chrome against the local API — selection, schedule,
reopening, API failure and Retry, three appearance modes, four languages, keyboard operation — with
screenshots. A deployed API does not exist, so remote connectivity stays unverified.

## Review and corrections

The independent review of 2026-09-22 returned `REQUEST_CHANGES` with three findings, all addressed on
2026-09-23:

1. **Cancelling a Settings draft lost the saved city.** One shared service-area slot meant a draft
   exploring another operator replaced the confirmed selection's district list, so its city could no
   longer be derived. The catalogue hook now keeps **one entry per provider** (`areaStateFor`), so the
   two questions coexist and a late reply for an abandoned draft is filed under its own provider.
2. **Confirmation required tabbing past the rest of the district list.** The list is now a single-choice
   group with one tab stop and arrow-key navigation, and onboarding carries the website's sticky
   confirmation bar, adapted to the popup.
3. **Documentation contradicted the implementation.** The test-count and migration claims are corrected
   here, in ADR 0006 and in the extension README.

The focused re-review of 2026-09-23 closed the first two findings and held the third open, because the
revised migration table still described malformed stored content as "unreadable". A documentation-only
follow-up separated the two paths — malformed content gives defaults in memory with nothing written and
a `ready` popup, while a failed storage read is terminal `unreadable` with no replacement write — after
which the re-review closed all three findings with **APPROVE**. Its record, including the verification
limits that still stand, is `/Users/alex/Downloads/AbfallRadar-AR-006-fix-review-2026-09-23.md`.

## Outcome

Recorded in [ADR 0004 addendum 1](../decisions/0004-addendum-1-extension-web-alignment.md) and
[ADR 0006](../decisions/0006-schedule-format-package.md).

Defects found in the old popup and fixed on the way:

- a hard-coded "18:00" reminder chip, shown whatever the setting said;
- the list after the featured collection, cut to four rows;
- a tie-break that differed from the website's: waste type before id, and start times compared as
  strings. The reminder used the same rule, so it followed the popup.

Changes a reviewer should expect:

- drop-off windows now carry each end's UTC offset, in the popup and in the reminder notification;
- retrieval and storage instants are written in labelled UTC;
- a restored schedule no longer claims either of the source's freshness labels.

Two more defects were found during the fix round's browser verification, at 320 px with doubled text,
and fixed:

- the reminders row could not wrap, so the switch — sized in `rem` — pushed the popup sideways;
- a waste-type chip could not break `Elektrokleinteile`, so the chip row did the same.

Verified in Playwright's Chromium with the built unpacked extension against the local API: first use,
reopening, cancelling a Settings draft, keyboard operation of the district group, an API outage and its
retries, four languages, both themes, 320 px and the popup width, with text enlargement simulated by
doubling the root font size. Remote connectivity is unverified, because no deployed API exists.

The full record of the fix round is `/Users/alex/Downloads/AbfallRadar-AR-006-review-fixes-2026-09-23.md`.

## Risks and decisions

- **Shared-package boundary** — a new workspace package changes the repository's package contracts.
- **Settings version 3** — a persisted-schema change with a migration.
- **Messaging contract** — two new message kinds (`list_cities`, `save_presentation`).
- **Size** — three workspaces change. Extracting shared code first, with the web unchanged, keeps each
  step reviewable.
