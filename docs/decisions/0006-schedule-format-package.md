# ADR 0006: One shared package for schedule rules and formatting

- Status: Accepted (independent review, 2026-09-23)
- Date: 2026-09-22
- Task: [AR-006](../tasks/AR-006-extension-web-alignment.md)

## Context

The website and the extension each had their own copy of the rules for presenting a schedule:

- the source-local "today";
- event order;
- the collection day;
- the drop-off window;
- date formatting.

The copies had already drifted apart:

- the event orders broke ties differently;
- the window formatters produced different strings;
- the extension had no localized formatting at all.

`packages/ui` held only tokens and two primitives. `packages/domain` holds schemas and business rules,
and must stay free of `Intl`-based presentation and of copy.

## Decision

Add **`@abfall-radar/schedule-format`**: a framework-free, pure TypeScript package that depends only on
`@abfall-radar/domain`.

It contains:

- `source-day`, `timestamp`, `event-order` (`compareEvents`, `orderEvents`) and `collection-day`;
- `featured` (`featuredCollection`, `listedCollections`), so both surfaces feature the same event and
  list it once;
- `collection-window` and `format`, with `Intl`-based formatting in the source's zone;
- `locale` (`SUPPORTED_LOCALES`, `DEFAULT_LOCALE`) and `messages`, the copy both applications share
  (`SCHEDULE_MESSAGES`).

`@abfall-radar/ui` gains the presentational components built on it:

- `NextCollectionCard`, `CountdownPanel` and `CountdownPanelAt`, `EventRow` and `ProvenanceCard`;
- the menus `LanguageMenu`, `AppearanceMenu` and `AppearancePopover`, and `BrandName`.

Each takes its data and copy as props.

**Boundaries:**

- `schedule-format` has no React, no DOM, no storage and no I/O.
- `ui` has no controllers, navigation, storage or data fetching.
- Each application keeps its own copy for its own flows, and composes it with `SCHEDULE_MESSAGES`.

The modules were moved from `apps/web/src` with their tests, and the extension's own duplicate window
tests moved with them.

**The web application's behaviour is unchanged; its test count is not, because the tests moved with the
code.** No web assertion was removed:

| Moved out of `apps/web` | Tests |
| --- | ---: |
| `collection-window.test.ts` | 7 |
| `source-day.test.ts` | 14 |
| `source-day.east-of-berlin.test.ts` | 4 |
| `source-day.west-of-berlin.test.ts` | 5 |
| `timestamp.test.ts` | 6 |
| **Total** | **36** |

So the web suite goes from **579 tests in 27 files** at `cb8a1ff` to **543 in 22 files**: 579 − 36 = 543.

The package's **50** tests are those 36, plus 10 moved from the extension
(`collection-window.east-of-utc` 3 and `collection-window.west-of-utc` 7), plus 4 new ones for the
featured-event rules. The count is not restored by adding tests that duplicate what moved.

## Consequences

- A rule changed in the package changes on both surfaces at once. Only a deliberate override can make
  the popup and the website disagree about which collection is next, or how a window is written.
- `CountdownPanelAt` takes the current instant as a prop, so the popup runs one minute clock for both
  the source's today and the countdown.
- The package is a new workspace dependency of `web`, `ui` and `extension`. It adds no third-party
  dependency.
