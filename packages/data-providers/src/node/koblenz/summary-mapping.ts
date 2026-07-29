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
]);
