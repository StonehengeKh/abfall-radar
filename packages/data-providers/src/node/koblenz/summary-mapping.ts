import type { SummaryMapping, SummaryMappingEntry } from '../normalize';

/**
 * The verified summary vocabulary of the Koblenz source.
 *
 * This table is the only place that knows what the operator's German event wording means. The domain
 * waste vocabulary is unchanged, and a summary that is not listed here fails the refresh rather than
 * being dropped — an upstream wording change is then a visible error instead of a silently shortened
 * schedule.
 *
 * The counts recorded during verification are upstream `VEVENT` entries, not normalized events: the two
 * combined entries each produce two events, so 46 entries normalize into 48 events.
 */
export const koblenzSummaryMapping: SummaryMapping = new Map<string, SummaryMappingEntry>([
  ['Altpapier', { wasteTypes: ['paper'], timingKind: 'all_day', collectionMode: 'curbside' }],
  [
    'Gelber Sack',
    { wasteTypes: ['yellow_bag'], timingKind: 'all_day', collectionMode: 'curbside' },
  ],
  [
    'Grünschnitt',
    { wasteTypes: ['green_waste'], timingKind: 'all_day', collectionMode: 'curbside' },
  ],
  [
    'Tannenbäume',
    { wasteTypes: ['christmas_tree'], timingKind: 'all_day', collectionMode: 'curbside' },
  ],
  // One official entry announcing two collections at one place inside one window.
  [
    'Schadstoffe / Elektrokleinteile',
    {
      wasteTypes: ['hazardous', 'small_electronics'],
      timingKind: 'time_window',
      collectionMode: 'mobile_drop_off',
    },
  ],
  /*
   * The same two collections, announced separately.
   *
   * Verified on 2026-09-16 in the operator's `Rauental` calendar, which publishes `Schadstoffe` and
   * `Elektrokleinteile` as two timed entries at one place rather than as the combined wording. Each is
   * a drop-off in its own right, so each maps to its own waste type — never to both, which would
   * announce a collection the entry does not describe.
   */
  [
    'Schadstoffe',
    { wasteTypes: ['hazardous'], timingKind: 'time_window', collectionMode: 'mobile_drop_off' },
  ],
  [
    'Elektrokleinteile',
    {
      wasteTypes: ['small_electronics'],
      timingKind: 'time_window',
      collectionMode: 'mobile_drop_off',
    },
  ],
]);
