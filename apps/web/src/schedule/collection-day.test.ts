import { type CollectionEvent, CollectionEventSchema } from '@abfall-radar/domain';
import {
  isCollectionInProgress,
  nextCountdownTarget,
  orderEvents,
} from '@abfall-radar/schedule-format';
import { describe, expect, it } from 'vitest';
import { toDomainCollectionEvent } from '@/src/adapters/collection-event';
import { curbside, dropOff, events } from '@/src/test/fixtures';

/**
 * Which collection is under way, and which one the countdown may still count.
 *
 * Both answers are calendar statements about the source's own day: "today" is the source-local date the
 * schedule carries, never the device's. The instants below are therefore chosen so that a device in
 * another zone — or a UTC midnight — would answer differently.
 */

const ZONE = 'Europe/Berlin';

/** Fixtures are transport shapes; the module takes domain events, so they are mapped and validated. */
const domain = (entries: ReadonlyArray<Record<string, unknown>>): CollectionEvent[] =>
  orderEvents(
    events(entries, { range: { from: '2026-01-01', to: '2026-12-31' } }).data.map((event) => {
      const mapped = toDomainCollectionEvent(event);

      if (mapped === undefined) {
        throw new Error('fixture failed the domain model');
      }

      return CollectionEventSchema.parse(mapped);
    }),
  );

const window = (startsAt: string, endsAt: string) => ({
  timing: { kind: 'time_window', startsAt, endsAt, timeZone: ZONE },
});

const at = (instant: string): Date => new Date(instant);

/** The single event of a one-event fixture, so a missing one fails here rather than in an assertion. */
const one = (entries: ReadonlyArray<Record<string, unknown>>): CollectionEvent => {
  const [event] = domain(entries);

  if (event === undefined) {
    throw new Error('fixture produced no event');
  }

  return event;
};

describe('isCollectionInProgress', () => {
  const today = one([curbside({ date: '2026-09-18' })]);
  const timedToday = one([
    dropOff({ date: '2026-09-18', ...window('2026-09-18T08:00:00Z', '2026-09-18T10:00:00Z') }),
  ]);

  it('is true for an all-day collection whose day is the source today', () => {
    expect(isCollectionInProgress(today, '2026-09-18')).toBe(true);
  });

  it('is false before and after that day', () => {
    expect(isCollectionInProgress(today, '2026-09-17')).toBe(false);
    expect(isCollectionInProgress(today, '2026-09-19')).toBe(false);
  });

  it('is false for a published window on the same date, which states its own hours', () => {
    expect(isCollectionInProgress(timedToday, '2026-09-18')).toBe(false);
  });
});

describe('nextCountdownTarget', () => {
  it('skips today and counts to the start of the next collection date in the source zone', () => {
    const schedule = domain([
      curbside({ id: 'paper-today', date: '2026-09-18' }),
      curbside({ id: 'yellow-next', date: '2026-09-22', wasteType: 'yellow_bag' }),
    ]);

    const outcome = nextCountdownTarget(schedule, '2026-09-18', ZONE, at('2026-09-18T06:00:00Z'));

    expect(outcome.kind).toBe('counting');

    if (outcome.kind !== 'counting') {
      return;
    }

    expect(outcome.target.events.map((event) => event.id)).toEqual(['yellow-next']);
    expect(outcome.target.dateOnly).toBe(true);
    // Midnight in Berlin, which is 22:00 UTC the day before — not a UTC or device midnight.
    expect(outcome.target.at.toISOString()).toBe('2026-09-21T22:00:00.000Z');
  });

  it('never treats another all-day collection today as a future target', () => {
    const schedule = domain([
      curbside({ id: 'paper-today', date: '2026-09-18' }),
      curbside({ id: 'yellow-today', date: '2026-09-18', wasteType: 'yellow_bag' }),
    ]);

    expect(nextCountdownTarget(schedule, '2026-09-18', ZONE, at('2026-09-18T06:00:00Z'))).toEqual({
      kind: 'no_future_collection',
    });
  });

  it('collects every waste type sharing the next collection date under one countdown', () => {
    const schedule = domain([
      curbside({ id: 'paper-next', date: '2026-09-22' }),
      curbside({ id: 'yellow-next', date: '2026-09-22', wasteType: 'yellow_bag' }),
      curbside({ id: 'green-later', date: '2026-09-29', wasteType: 'green_waste' }),
    ]);

    const outcome = nextCountdownTarget(schedule, '2026-09-18', ZONE, at('2026-09-18T06:00:00Z'));

    expect(outcome.kind === 'counting' && outcome.target.events.map((event) => event.id)).toEqual([
      'paper-next',
      'yellow-next',
    ]);
  });

  it('keeps counting to a published start later today, by the instant the source gave', () => {
    const schedule = domain([
      dropOff({
        id: 'hazardous-today',
        date: '2026-09-18',
        ...window('2026-09-18T08:00:00Z', '2026-09-18T10:00:00Z'),
      }),
    ]);

    const outcome = nextCountdownTarget(schedule, '2026-09-18', ZONE, at('2026-09-18T06:00:00Z'));

    expect(outcome.kind === 'counting' && outcome.target.dateOnly).toBe(false);
    expect(outcome.kind === 'counting' && outcome.target.at.toISOString()).toBe(
      '2026-09-18T08:00:00.000Z',
    );
  });

  it('moves past a window that has already started rather than counting a negative', () => {
    const schedule = domain([
      dropOff({
        id: 'hazardous-today',
        date: '2026-09-18',
        ...window('2026-09-18T08:00:00Z', '2026-09-18T10:00:00Z'),
      }),
      curbside({ id: 'paper-next', date: '2026-09-22' }),
    ]);

    const outcome = nextCountdownTarget(schedule, '2026-09-18', ZONE, at('2026-09-18T09:00:00Z'));

    expect(outcome.kind === 'counting' && outcome.target.events.map((event) => event.id)).toEqual([
      'paper-next',
    ]);
  });

  it('speaks for both events of one appointment, which share a published start', () => {
    const schedule = domain([
      dropOff({
        id: 'hazardous-2026-09-22',
        wasteType: 'hazardous',
        date: '2026-09-22',
        ...window('2026-09-22T08:00:00Z', '2026-09-22T10:00:00Z'),
      }),
      dropOff({
        id: 'electronics-2026-09-22',
        wasteType: 'small_electronics',
        date: '2026-09-22',
        ...window('2026-09-22T08:00:00Z', '2026-09-22T10:00:00Z'),
      }),
    ]);

    const outcome = nextCountdownTarget(schedule, '2026-09-18', ZONE, at('2026-09-18T06:00:00Z'));

    // Schedule order, which for one appointment is the id tie-break — not the order they were listed in.
    expect(outcome.kind === 'counting' && outcome.target.events.map((event) => event.type)).toEqual(
      ['small_electronics', 'hazardous'],
    );
  });

  it('reports that nothing further is published when every collection is behind', () => {
    const schedule = domain([curbside({ id: 'paper-past', date: '2026-09-10' })]);

    expect(nextCountdownTarget(schedule, '2026-09-18', ZONE, at('2026-09-18T06:00:00Z'))).toEqual({
      kind: 'no_future_collection',
    });
  });

  it('is undeterminable, not "nothing published", when the zone cannot be resolved', () => {
    const schedule = domain([curbside({ id: 'paper-next', date: '2026-09-22' })]);

    expect(
      nextCountdownTarget(schedule, '2026-09-18', 'Mars/Olympus_Mons', at('2026-09-18T06:00:00Z')),
    ).toEqual({ kind: 'undeterminable' });
  });
});
