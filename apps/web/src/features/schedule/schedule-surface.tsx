import type { CollectionEvent } from '@abfall-radar/domain';
import {
  featuredCollection,
  type HouseholdScheduleResult,
  listedCollections,
  orderEvents,
  toCollectionEvent,
} from '@abfall-radar/schedule-format';
import {
  CountdownPanel,
  EventRow,
  NextCollectionCard,
  ProvenanceCard,
  type ScheduleView,
} from '@abfall-radar/ui';
import { useLocale } from '@/src/i18n/context';
import type { AcceptedSchedule } from '@/src/schedule/view-state';

/**
 * The accepted schedule, laid out for the web page.
 *
 * The featured card, the countdown, the event rows and the source details are shared with the extension
 * and live in `@abfall-radar/ui`; what stays here is the web's own grid — how those pieces are placed on
 * a page from a phone to a desktop — and the mapping from the web's schedule into the shared view.
 *
 * Every normalized event gets its own row: one upstream appointment can normalize into a `hazardous`
 * and a `small_electronics` event sharing date, window, zone, and location, and they are never merged.
 * Provenance renders whenever the response carries it, including for a successful empty schedule.
 *
 * Source-authored text — the operator's name, attribution, source page, and the drop-off addresses —
 * is reproduced exactly as published, in every language.
 */

/**
 * The calculated household collections, as domain events, bounded by what the surface is showing.
 *
 * Two things are deliberately **not** done here. A calculated collection is never deduplicated against a
 * published one — they are different statements and the operator does publish some of these bins for some
 * areas — and the official events are never re-ordered or re-dated. All that happens is that both kinds
 * enter one ordered list, each keeping its own `source`.
 */
const householdEvents = (
  household: HouseholdScheduleResult | null,
  schedule: AcceptedSchedule,
): readonly CollectionEvent[] =>
  household === null
    ? []
    : household.collections
        .filter(
          (collection) =>
            collection.date >= schedule.range.from && collection.date <= schedule.range.to,
        )
        .map((collection) => toCollectionEvent(collection, schedule.selection.serviceAreaId));

/** The web's accepted schedule, as the shared presentation reads it. */
const toScheduleView = (
  schedule: AcceptedSchedule,
  household: HouseholdScheduleResult | null,
): ScheduleView => ({
  events: orderEvents([...schedule.events, ...householdEvents(household, schedule)]),
  sourceToday: schedule.sourceToday,
  timeZone: schedule.meta.source.timeZone,
  range: schedule.range,
  source: {
    name: schedule.meta.source.name,
    attribution: schedule.meta.source.attribution,
    landingPageUrl: schedule.meta.source.landingPageUrl,
    retrievedAt: schedule.meta.retrievedAt,
    freshness: schedule.meta.freshness,
    publishedWasteTypes: schedule.meta.coverage.wasteTypes,
  },
});

/**
 * The schedule and its secondary information.
 *
 * Two columns from `lg` upward — the schedule leads, the countdown and the source sit beside it — and
 * one column below that, with the countdown directly above the source section under the schedule. The
 * source section is always visible: what the source does and does not publish qualifies the schedule
 * above it, so it is not something to hide behind a disclosure.
 */
/**
 * The schedule and its secondary information.
 *
 * One grid, one DOM order, and one mounted countdown. Below 1280 px it is a single column reading
 * countdown → next collection → the list → the source, so the time remaining is the first thing a phone
 * or a tablet shows; from 1280 px the same four elements are placed into two columns, with the countdown
 * back above the source on the right. Placement is CSS, never a second copy of the panel: a duplicate
 * would mean a duplicate minute timer, and hiding one with `display: none` would still run it.
 *
 * `grid-flow-dense` covers the case where the countdown has nothing to count — the source card then
 * backfills the top of the right column instead of leaving a hole above itself.
 */
export const ScheduleSurface = ({
  schedule,
  household = null,
}: {
  readonly schedule: AcceptedSchedule;
  /**
   * The calculated household collections, when somebody has switched them on and the rules could be
   * read. `null` covers every other case, and the schedule renders exactly as it did before them.
   */
  readonly household?: HouseholdScheduleResult | null;
}) => {
  const { locale, messages } = useLocale();
  const view = toScheduleView(schedule, household);
  // The list is everything the featured card is not showing, by the shared rule.
  const rest = listedCollections(view.events, featuredCollection(view.events, view.sourceToday));

  return (
    <div className="grid gap-3 xl:grid-flow-row-dense xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start xl:gap-4">
      {/*
        `self-stretch` on the two panels of the first row, not `items-stretch` on the grid: the row below
        pairs the event list with the source panel, and stretching that one would leave the source card
        as tall as the whole schedule. Stretched, the pair shares the taller natural height, and the
        featured card centres its own content within it.
      */}
      <CountdownPanel
        className="min-w-0 xl:col-start-2 xl:row-start-1 xl:self-stretch"
        locale={locale}
        messages={messages}
        view={view}
      />

      <NextCollectionCard
        className="min-w-0 xl:col-start-1 xl:row-start-1 xl:self-stretch"
        locale={locale}
        messages={messages}
        view={view}
      />

      {/* No empty container when the featured collection was the only one the source published. */}
      {rest.length === 0 ? null : (
        <ul className="flex min-w-0 flex-col gap-1.5 xl:col-start-1 xl:row-start-2">
          {rest.map((event) => (
            <EventRow
              event={event}
              key={event.id}
              locale={locale}
              messages={messages}
              sourceToday={schedule.sourceToday}
            />
          ))}
        </ul>
      )}

      <ProvenanceCard
        className="min-w-0 xl:col-start-2"
        locale={locale}
        messages={messages}
        view={view}
      />
    </div>
  );
};
