import { type CollectionEvent, CollectionEventSchema, type WasteType } from '@abfall-radar/domain';
import { differenceInCalendarDays } from 'date-fns';
import { type CollectionSourceManifest, SourceFailureError } from '../source';
import type { CalendarEntry, ParsedCalendar } from './calendar';
import {
  buildCanonicalIdentity,
  createEventId,
  type DigestFn,
  type EventIdentity,
  normalizeLocationName,
  sha256Digest,
  type TimingKind,
  toUtcInstant,
} from './event-identity';

/**
 * Turns attested calendar entries into validated domain events.
 *
 * Manifest- and mapping-driven, so it carries no municipal name of its own: the summaries, the URLs,
 * and the area naming all live in the provider adapter that supplies them.
 *
 * Nothing here is best-effort. An entry that cannot produce a valid variant fails the whole refresh,
 * because a partial schedule is indistinguishable from a complete one to the person reading it, and
 * that is the most damaging failure this ingestion can have.
 */

export type CollectionMode = 'curbside' | 'mobile_drop_off';

export interface SummaryMappingEntry {
  /** More than one when a single official entry announces more than one collection. */
  readonly wasteTypes: readonly WasteType[];
  readonly timingKind: TimingKind;
  readonly collectionMode: CollectionMode;
}

export type SummaryMapping = ReadonlyMap<string, SummaryMappingEntry>;

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The calendar and numbering system are pinned so no ambient locale can change the parts, and the
 * formatter is cached because one is built per refresh otherwise.
 */
const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  const cached = formatters.get(timeZone);

  if (cached !== undefined) {
    return cached;
  }

  let created: Intl.DateTimeFormat;

  try {
    created = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    throw new SourceFailureError('zone-mismatch');
  }

  formatters.set(timeZone, created);

  return created;
};

/**
 * Reads the `year`, `month`, and `day` parts in the attested zone. A formatted string is never parsed,
 * and the date is never derived in UTC or in the server's local zone: either would silently shift any
 * window near midnight onto the wrong day.
 */
const toLocalDateInZone = (instant: Date, timeZone: string): string => {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find((part) => part.type === type)?.value;

  const year = read('year');
  const month = read('month');
  const day = read('day');

  if (year === undefined || month === undefined || day === undefined) {
    throw new SourceFailureError('event-invalid');
  }

  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
};

/**
 * An all-day date is preserved exactly as written. `node-ical` builds a `VALUE=DATE` start with the
 * local-time constructor, so its *local* components are the calendar date; reading UTC here would move
 * the date a day earlier for any process zone east of UTC.
 */
const toLocalDateFromAllDay = (start: Date): string => {
  const year = String(start.getFullYear()).padStart(4, '0');
  const month = String(start.getMonth() + 1).padStart(2, '0');
  const day = String(start.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
};

interface NormalizedTiming {
  readonly date: string;
  readonly timing: CollectionEvent['timing'];
  readonly locationName: string | null;
}

const normalizeAllDay = (
  entry: CalendarEntry,
  manifest: CollectionSourceManifest,
): NormalizedTiming => {
  // The verified source uses `LOCATION` for two different things depending on the timing form: on a
  // curbside entry it repeats the collection-area label, while on a timed entry it names a real place to
  // travel to. Only the first is redundant, and only exactly the first is tolerated.
  //
  // The comparison is against the manifest area name, both sides normalized the same way. An exact match
  // is dropped, because a response already carries it as the service-area name and a curbside event has
  // nowhere to go. Anything else — empty, whitespace-only, or a different place — fails the refresh:
  // discarding a location the source actually means would turn "bring this somewhere" into "put the bin
  // out", which is the one substitution this ingestion must never make silently.
  //
  // The value arrives already unwrapped from its parameters and RFC 5545 unescaped by the parser.
  if (entry.location !== undefined) {
    const label = normalizeLocationName(entry.location);

    if (label === '' || label !== normalizeLocationName(manifest.areaName)) {
      throw new SourceFailureError('event-invalid');
    }
  }

  // The span is measured in whole calendar days, never in elapsed time. A one-day all-day event spanning
  // a daylight-saving transition is 23 or 25 hours long, so comparing elapsed milliseconds against 24
  // hours would both reject a valid event across a fall-back date and accept an end that precedes its
  // start. `differenceInCalendarDays` compares local calendar dates, which is immune to both.
  //
  // Accepted spans, given how the parser represents each case:
  //   1 day  — either an explicit exclusive `DTEND` on the next calendar date, or no `DTEND` at all: for
  //            a `VALUE=DATE` entry the parser applies the RFC 5545 one-day default, so the two are
  //            indistinguishable here and both describe a single day;
  //   0 days — the parser's representation of an unattested end for a *timed* value. Tolerated so this
  //            check never depends on which of the two defaulting rules the parser applied.
  // A negative span is backwards, and more than one day would under-report a multi-day collection.
  if (entry.end !== undefined) {
    const spanDays = differenceInCalendarDays(entry.end, entry.start);

    if (spanDays < 0 || spanDays > 1) {
      throw new SourceFailureError('event-invalid');
    }
  }

  return {
    date: toLocalDateFromAllDay(entry.start),
    timing: { kind: 'all_day' },
    locationName: null,
  };
};

const normalizeTimeWindow = (entry: CalendarEntry, timeZone: string): NormalizedTiming => {
  // A positive window is required, not merely a present `end`. When `DTEND` is absent `node-ical`
  // synthesizes `end === start`, so an unattested window is indistinguishable from a zero-length one —
  // and neither is an actionable instruction to show up somewhere. Accepting the synthesized value
  // would emit exactly the half-populated drop-off this ingestion exists to refuse.
  if (entry.end === undefined || entry.end.getTime() <= entry.start.getTime()) {
    throw new SourceFailureError('event-invalid');
  }

  const locationName = entry.location === undefined ? '' : normalizeLocationName(entry.location);

  // A mobile drop-off without a place is the dangerous half-populated case: a surface would render
  // "bring this somewhere" without saying where.
  if (locationName === '') {
    throw new SourceFailureError('event-invalid');
  }

  return {
    date: toLocalDateInZone(entry.start, timeZone),
    timing: {
      kind: 'time_window',
      startsAt: toUtcInstant(entry.start),
      endsAt: toUtcInstant(entry.end),
      timeZone,
    },
    locationName,
  };
};

export interface NormalizeCalendarOptions {
  readonly manifest: CollectionSourceManifest;
  readonly mapping: SummaryMapping;
  readonly calendar: ParsedCalendar;
  /** Overridden only by tests, to force a digest collision deterministically. */
  readonly digest?: DigestFn;
}

export const normalizeCalendar = ({
  manifest,
  mapping,
  calendar,
  digest = sha256Digest,
}: NormalizeCalendarOptions): CollectionEvent[] => {
  const collected = new Map<string, { canonical: string; event: CollectionEvent }>();

  for (const entry of calendar.entries) {
    const mapped = mapping.get(entry.summary);

    // An unmapped summary is an outage for this source, on purpose: ingestion never drops an entry it
    // does not understand, because a silently shortened schedule reads as a complete one.
    if (mapped === undefined) {
      throw new SourceFailureError('summary-unmapped');
    }

    const timingKind: TimingKind = entry.isDateOnly ? 'all_day' : 'time_window';

    // The timing form follows the calendar value type and the mode follows the mapping table. When the
    // two disagree the source has changed in a way the mapping no longer describes.
    if (timingKind !== mapped.timingKind) {
      throw new SourceFailureError('timing-mode-mismatch');
    }

    const normalized =
      timingKind === 'all_day'
        ? normalizeAllDay(entry, manifest)
        : normalizeTimeWindow(entry, calendar.timeZone);

    for (const wasteType of mapped.wasteTypes) {
      const identity: EventIdentity = {
        providerId: manifest.providerId,
        serviceAreaId: manifest.serviceAreaId,
        wasteType,
        date: normalized.date,
        timingKind,
        startsAt: normalized.timing.kind === 'time_window' ? normalized.timing.startsAt : null,
        endsAt: normalized.timing.kind === 'time_window' ? normalized.timing.endsAt : null,
        timeZone: normalized.timing.kind === 'time_window' ? normalized.timing.timeZone : null,
        locationName: normalized.locationName,
      };

      const canonical = buildCanonicalIdentity(identity);
      const id = createEventId(identity, digest);

      const shared = {
        id,
        // The API maps this onto `serviceAreaId`; the domain member keeps its existing name.
        districtId: manifest.serviceAreaId,
        type: wasteType,
        date: normalized.date,
        title: entry.summary,
        source: 'municipal_ics',
      } as const;

      const candidate =
        normalized.timing.kind === 'time_window' && normalized.locationName !== null
          ? {
              ...shared,
              collectionMode: mapped.collectionMode,
              timing: normalized.timing,
              location: { name: normalized.locationName },
            }
          : { ...shared, collectionMode: mapped.collectionMode, timing: normalized.timing };

      // The last gate: whatever the mapping and the source agreed on still has to be a valid domain
      // variant, and a rejection fails the refresh rather than emitting a half-populated event.
      const result = CollectionEventSchema.safeParse(candidate);

      if (!result.success) {
        throw new SourceFailureError('event-invalid');
      }

      const existing = collected.get(id);

      if (existing !== undefined) {
        // Equal identity means the same event arrived twice, which collapses. A different identity
        // under the same id is a truncated-digest collision: negligible, but collapsing it would drop
        // a real collection, so it fails loudly instead.
        if (existing.canonical === canonical) {
          continue;
        }

        throw new SourceFailureError('identity-collision');
      }

      collected.set(id, { canonical, event: result.data });
    }
  }

  return [...collected.values()]
    .map(({ event }) => event)
    .toSorted(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        left.type.localeCompare(right.type) ||
        left.id.localeCompare(right.id),
    );
};
