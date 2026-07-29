import { describe, expect, it } from 'vitest';
import { type CollectionEvent, CollectionEventSchema } from './waste';
import { findReminderEvent, getRelativeDateLabel, getUpcomingEvents } from './schedule';

const referenceDate = new Date('2026-07-23T10:00:00');

const createEvents = (): CollectionEvent[] => [
  {
    id: 'paper-later',
    districtId: 'district',
    type: 'paper',
    date: '2026-08-14',
    title: 'Paper',
    source: 'demo',
    collectionMode: 'curbside',
    timing: { kind: 'all_day' },
  },
  {
    id: 'yellow-bag-tomorrow',
    districtId: 'district',
    type: 'yellow_bag',
    date: '2026-07-24',
    title: 'Yellow bag',
    source: 'demo',
    collectionMode: 'curbside',
    timing: { kind: 'all_day' },
  },
  // A timed mobile drop-off sits in the same list, so the schedule rules are exercised against both
  // variants rather than only the all-day one.
  {
    id: 'hazardous-mobile',
    districtId: 'district',
    type: 'hazardous',
    date: '2026-07-25',
    title: 'Hazardous',
    source: 'municipal_ics',
    collectionMode: 'mobile_drop_off',
    timing: {
      kind: 'time_window',
      startsAt: '2026-07-25T08:00:00Z',
      endsAt: '2026-07-25T10:00:00Z',
      timeZone: 'Europe/Berlin',
    },
    location: { name: 'Rizzastraße Ecke Südallee' },
  },
];

describe('schedule helpers', () => {
  it('rejects impossible calendar dates at the domain boundary', () => {
    expect(
      CollectionEventSchema.safeParse({
        id: 'invalid-date',
        districtId: 'district',
        type: 'paper',
        date: '2026-02-30',
        title: 'Paper',
        source: 'demo',
      }).success,
    ).toBe(false);
  });

  it('returns upcoming events in chronological order', () => {
    const upcomingEvents = getUpcomingEvents(createEvents(), referenceDate);

    expect(upcomingEvents[0]?.date).toBe('2026-07-24');
    expect(upcomingEvents.at(-1)?.date).toBe('2026-08-14');
  });

  it('formats today and tomorrow without locale ambiguity', () => {
    expect(getRelativeDateLabel('2026-07-23', referenceDate)).toBe('Heute');
    expect(getRelativeDateLabel('2026-07-24', referenceDate)).toBe('Morgen');
  });

  it('finds the event that should trigger a reminder', () => {
    expect(findReminderEvent(createEvents(), 1, referenceDate)?.type).toBe('yellow_bag');
  });
});
