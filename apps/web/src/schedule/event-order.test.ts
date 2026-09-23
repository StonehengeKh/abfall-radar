import { type CollectionEvent, CollectionEventSchema } from '@abfall-radar/domain';
import { compareIds, orderEvents } from '@abfall-radar/schedule-format';
import { describe, expect, it } from 'vitest';
import { toDomainCollectionEvent } from '@/src/adapters/collection-event';
import { curbside, dropOff, events } from '@/src/test/fixtures';

const domain = (entries: ReadonlyArray<Record<string, unknown>>): CollectionEvent[] =>
  events(entries, { range: { from: '2026-01-01', to: '2026-12-31' } }).data.map((event) => {
    const mapped = toDomainCollectionEvent(event);

    if (mapped === undefined) {
      throw new Error('fixture failed the domain model');
    }

    return CollectionEventSchema.parse(mapped);
  });

const window = (startsAt: string, endsAt: string) => ({
  timing: { kind: 'time_window', startsAt, endsAt, timeZone: 'Europe/Berlin' },
});

describe('orderEvents', () => {
  it('orders by date, then curbside before drop-off, then start instant, then id', () => {
    const ordered = orderEvents(
      domain([
        dropOff({
          id: 'late',
          date: '2026-11-07',
          ...window('2026-11-07T12:00:00Z', '2026-11-07T13:00:00Z'),
        }),
        dropOff({
          id: 'early',
          date: '2026-11-07',
          ...window('2026-11-07T10:00:00Z', '2026-11-07T11:00:00Z'),
        }),
        curbside({ id: 'curb', date: '2026-11-07' }),
        curbside({ id: 'first', date: '2026-08-14' }),
      ]),
    );

    expect(ordered.map((event) => event.id)).toEqual(['first', 'curb', 'early', 'late']);
  });

  it('keeps both events of one appointment, which share identical timing, ordered by id', () => {
    const ordered = orderEvents(
      domain([
        dropOff({ id: 'b-small-electronics', wasteType: 'small_electronics' }),
        dropOff({ id: 'a-hazardous', wasteType: 'hazardous' }),
      ]),
    );

    expect(ordered.map((event) => event.id)).toEqual(['a-hazardous', 'b-small-electronics']);
  });

  it('compares start instants at full precision before falling through to id', () => {
    const ordered = orderEvents(
      domain([
        dropOff({ id: 'a', ...window('2026-11-07T10:00:00.0002Z', '2026-11-07T11:00:00Z') }),
        dropOff({ id: 'z', ...window('2026-11-07T10:00:00.0001Z', '2026-11-07T11:00:00Z') }),
      ]),
    );

    expect(ordered.map((event) => event.id)).toEqual(['z', 'a']);
  });

  it('treats minute and second precision as equal and falls through to id, swapping with the ids', () => {
    const first = orderEvents(
      domain([
        dropOff({ id: 'b', ...window('2026-11-07T10:00Z', '2026-11-07T11:00:00Z') }),
        dropOff({ id: 'a', ...window('2026-11-07T10:00:00Z', '2026-11-07T11:00:00Z') }),
      ]),
    );

    expect(first.map((event) => event.id)).toEqual(['a', 'b']);
  });

  it('produces an identical sequence for a shuffled copy', () => {
    const input = domain([
      dropOff({ id: 'd' }),
      curbside({ id: 'c', date: '2026-11-07' }),
      curbside({ id: 'a', date: '2026-08-14' }),
    ]);

    expect(orderEvents([...input].reverse())).toEqual(orderEvents(input));
  });
});

describe('the opaque id tie-break', () => {
  const composed = 'é';
  const decomposed = 'é';

  it('never equates distinct ids that a locale-aware comparison can treat as equal', () => {
    expect(composed.localeCompare(decomposed, 'de')).toBe(0);
    expect(compareIds(composed, decomposed)).not.toBe(0);
    expect(compareIds(decomposed, composed)).toBe(-compareIds(composed, decomposed));
  });

  it('orders both input permutations identically and keeps both ids unchanged', () => {
    const tied = (id: string) => dropOff({ id });
    const expected = [decomposed, composed];

    expect(
      orderEvents(domain([tied(composed), tied(decomposed)])).map((event) => event.id),
    ).toEqual(expected);
    expect(
      orderEvents(domain([tied(decomposed), tied(composed)])).map((event) => event.id),
    ).toEqual(expected);
  });
});
