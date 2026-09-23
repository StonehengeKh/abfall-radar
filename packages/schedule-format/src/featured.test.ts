import type { CollectionEvent } from '@abfall-radar/domain';
import { describe, expect, it } from 'vitest';
import { featuredCollection, listedCollections } from './featured';

/** Just enough of an all-day collection for the rule under test, which reads only `id` and `date`. */
const onDay = (id: string, date: string): CollectionEvent =>
  ({
    id,
    date,
    districtId: 'area',
    type: 'paper',
    title: 'Altpapier',
    source: 'municipal_ics',
    collectionMode: 'curbside',
    timing: { kind: 'all_day' },
  }) as CollectionEvent;

describe('the featured collection and the list beside it', () => {
  const schedule = [
    onDay('past', '2026-09-10'),
    onDay('today-a', '2026-09-18'),
    onDay('today-b', '2026-09-18'),
    onDay('later', '2026-09-22'),
  ];

  it('features the first collection on or after the source today', () => {
    expect(featuredCollection(schedule, '2026-09-18')?.id).toBe('today-a');
    expect(featuredCollection(schedule, '2026-09-19')?.id).toBe('later');
  });

  it('features nothing when every collection is behind', () => {
    expect(featuredCollection(schedule, '2026-10-01')).toBeNull();
  });

  it('lists everything except the featured event, by identifier, in schedule order', () => {
    const featured = featuredCollection(schedule, '2026-09-18');

    // The other collection on the same day keeps its row; only the featured one is withheld.
    expect(listedCollections(schedule, featured).map((event) => event.id)).toEqual([
      'past',
      'today-b',
      'later',
    ]);
  });

  it('lists everything when nothing is featured', () => {
    expect(listedCollections(schedule, null)).toHaveLength(4);
  });
});
