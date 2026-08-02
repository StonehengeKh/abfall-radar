import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { toCacheKey } from './schedule-cache';
import {
  clearScheduleInvalidation,
  isScheduleInvalidated,
  markScheduleInvalidated,
  MAX_TOMBSTONES,
  scheduleInvalidationToken,
} from './schedule-tombstone';

/**
 * Invalidation as a state that survives, rather than as a deletion that may not have happened.
 *
 * A tombstone is written independently of the physical eviction, so an entry whose removal was refused is still
 * unusable — and stays unusable after a worker restart, which for a Manifest V3 service worker is minutes away.
 */

const ORIGIN = 'http://127.0.0.1:3000';

const AREA = {
  origin: ORIGIN,
  providerId: 'koblenz-servicebetrieb',
  serviceAreaId: 'koblenz-stadtmitte',
} as const;

const OTHER_AREA = { ...AREA, serviceAreaId: 'koblenz-oberwerth' } as const;

const NOW = new Date('2026-03-09T18:00:00.000Z');

const storedTombstones = async (): Promise<Record<string, unknown>> => {
  const raw = (await fakeBrowser.storage.local.get('schedule-tombstones'))['schedule-tombstones'] as
    | Record<string, unknown>
    | undefined;

  return raw ?? {};
};

describe('a withdrawn area', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is reported as invalidated once marked', async () => {
    await markScheduleInvalidated(AREA, NOW);

    expect(await isScheduleInvalidated(AREA, NOW)).toBe(true);
  });

  it('is not reported before anything marked it', async () => {
    expect(await isScheduleInvalidated(AREA, NOW)).toBe(false);
  });

  it('says nothing about another area of the same provider', async () => {
    // The whole point of keying by area: one withdrawal must not withhold every other schedule.
    await markScheduleInvalidated(AREA, NOW);

    expect(await isScheduleInvalidated(OTHER_AREA, NOW)).toBe(false);
  });

  it('says nothing under a different configured origin', async () => {
    // A withdrawal learned from one API cannot withhold data retrieved from another.
    await markScheduleInvalidated(AREA, NOW);

    expect(await isScheduleInvalidated({ ...AREA, origin: 'https://api.example.test' }, NOW)).toBe(
      false,
    );
  });

  it('records the identity in the record as well as in its key', async () => {
    await markScheduleInvalidated(AREA, NOW);

    expect(await storedTombstones()).toEqual({
      [toCacheKey(AREA)]: {
        origin: ORIGIN,
        providerId: AREA.providerId,
        serviceAreaId: AREA.serviceAreaId,
        invalidatedAt: NOW.toISOString(),
        // The first withdrawal of this key, so the sequence starts at one.
        token: 1,
      },
    });
  });

  it('is ignored when its record contradicts the key it was filed under', async () => {
    // Persisted storage is untrusted. A record claiming one area under another's key would otherwise withhold
    // the wrong area's schedule.
    await fakeBrowser.storage.local.set({
      'schedule-tombstones': {
        [toCacheKey(AREA)]: {
          origin: ORIGIN,
          providerId: AREA.providerId,
          serviceAreaId: OTHER_AREA.serviceAreaId,
          invalidatedAt: NOW.toISOString(),
          // Otherwise valid, so the contradiction between the record and its key is the only reason it is refused.
          token: 1,
        },
      },
    });

    expect(await isScheduleInvalidated(AREA, NOW)).toBe(false);
  });

  it('is forgotten once cleared against the token it was recorded under', async () => {
    await markScheduleInvalidated(AREA, NOW);

    const token = await scheduleInvalidationToken(AREA, NOW);

    expect(token).not.toBeNull();
    expect(await clearScheduleInvalidation(AREA, NOW, token ?? 0)).toBe('cleared');
    expect(await isScheduleInvalidated(AREA, NOW)).toBe(false);
    expect(await storedTombstones()).toEqual({});
  });

  it('leaves other withdrawals in place when one is cleared', async () => {
    await markScheduleInvalidated(AREA, NOW);
    await markScheduleInvalidated(OTHER_AREA, NOW);

    const token = (await scheduleInvalidationToken(AREA, NOW)) ?? 0;

    await clearScheduleInvalidation(AREA, NOW, token);

    expect(await isScheduleInvalidated(OTHER_AREA, NOW)).toBe(true);
  });
});

/**
 * Removal is a **compare-and-clear**, so a newer withdrawal is never the one forgotten.
 *
 * A replacement establishes that it started after a particular invalidation, then goes away to write its entry. It
 * cannot know whether another invalidation happened in the meantime, because a storage round trip separates the
 * two — and an unconditional delete removed whatever record it found, including one written moments earlier by a
 * withdrawal it knew nothing about.
 */
describe('clearing a withdrawal by token', () => {
  it('refuses when a newer invalidation has replaced the record', async () => {
    await markScheduleInvalidated(AREA, NOW);

    const observed = (await scheduleInvalidationToken(AREA, NOW)) ?? 0;

    // A second withdrawal, which the holder of `observed` knows nothing about.
    await markScheduleInvalidated(AREA, NOW);

    expect(await clearScheduleInvalidation(AREA, NOW, observed)).toBe('superseded');
    // The newer withdrawal stands.
    expect(await isScheduleInvalidated(AREA, NOW)).toBe(true);
  });

  it('issues a strictly newer token for every invalidation', async () => {
    await markScheduleInvalidated(AREA, NOW);

    const first = (await scheduleInvalidationToken(AREA, NOW)) ?? 0;

    await markScheduleInvalidated(AREA, NOW);

    const second = (await scheduleInvalidationToken(AREA, NOW)) ?? 0;

    expect(second).toBeGreaterThan(first);
  });

  it('derives the token from what is on disk, so it survives a restart', async () => {
    /**
     * The reason the token is not the worker's generation counter. A worker's counter starts again at zero, so a
     * record written by a previous worker would carry a number the new one could never produce — and its withdrawal
     * could never be lifted at all. Reading the stored value is what keeps the sequence going.
     */
    await markScheduleInvalidated(AREA, NOW);
    await markScheduleInvalidated(AREA, NOW);
    await markScheduleInvalidated(AREA, NOW);

    // A fresh worker knows nothing of the previous ones, and still continues the sequence.
    expect(await scheduleInvalidationToken(AREA, NOW)).toBe(3);
  });

  it('reports an absent record rather than failing', async () => {
    // The ordinary uninvalidated case: nothing to forget is the outcome the caller wanted.
    expect(await clearScheduleInvalidation(AREA, NOW, 1)).toBe('absent');
  });

  it('answers with no token when nothing is recorded', async () => {
    expect(await scheduleInvalidationToken(AREA, NOW)).toBeNull();
  });

  it('leaves an unrelated area’s token untouched', async () => {
    await markScheduleInvalidated(AREA, NOW);
    await markScheduleInvalidated(OTHER_AREA, NOW);

    const mine = (await scheduleInvalidationToken(AREA, NOW)) ?? 0;

    await clearScheduleInvalidation(AREA, NOW, mine);

    expect(await scheduleInvalidationToken(OTHER_AREA, NOW)).not.toBeNull();
  });
});

describe('the bounds on the tombstone store', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops a withdrawal older than the retention window', async () => {
    // Past the window the cache entry it guarded cannot be restored anyway, so the record has nothing left to do.
    await markScheduleInvalidated(AREA, new Date('2026-03-01T18:00:00.000Z'));

    const wellAfter = new Date('2026-03-20T18:00:00.000Z');

    expect(await isScheduleInvalidated(AREA, wellAfter)).toBe(false);
  });

  it('keeps a withdrawal inside the retention window', async () => {
    await markScheduleInvalidated(AREA, new Date('2026-03-05T18:00:00.000Z'));

    expect(await isScheduleInvalidated(AREA, NOW)).toBe(true);
  });

  it('drops a withdrawal stamped in the future', async () => {
    // Untrustworthy in both directions, and kept for ever if it were tolerated.
    await markScheduleInvalidated(AREA, new Date('2026-04-01T18:00:00.000Z'));

    expect(await isScheduleInvalidated(AREA, NOW)).toBe(false);
  });

  it('never grows past its cap, keeping the newest withdrawals', async () => {
    /**
     * Without a bound this store is only ever appended to: every area a person tries and loses accumulates for
     * ever. The oldest go first, because their entries are closest to leaving the retention window anyway.
     */
    for (let index = 0; index <= MAX_TOMBSTONES; index += 1) {
      await markScheduleInvalidated(
        { ...AREA, serviceAreaId: `area-${index}` },
        new Date(NOW.getTime() + index * 1000),
      );
    }

    const stored = await storedTombstones();

    expect(Object.keys(stored)).toHaveLength(MAX_TOMBSTONES);
    // The very first one was dropped; the last one survived.
    expect(await isScheduleInvalidated({ ...AREA, serviceAreaId: 'area-0' }, NOW)).toBe(false);
    expect(
      await isScheduleInvalidated(
        { ...AREA, serviceAreaId: `area-${MAX_TOMBSTONES}` },
        new Date(NOW.getTime() + MAX_TOMBSTONES * 1000),
      ),
    ).toBe(true);
  });
});

describe('a tombstone store that cannot be read', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails closed, reporting the area as withdrawn', async () => {
    /**
     * The safe direction. Withholding an offline restore costs a person a cached schedule until the network
     * answers; the other direction presents a calendar the operator has stopped publishing as current official
     * data, which is the failure this whole mechanism exists to prevent.
     */
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(new Error('storage unavailable'));

    expect(await isScheduleInvalidated(AREA, NOW)).toBe(true);
  });
});

describe('a tombstone that cannot be written', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects, so the caller can carry on deliberately rather than silently', async () => {
    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('storage unavailable'));

    await expect(markScheduleInvalidated(AREA, NOW)).rejects.toThrow();
  });

  it('does not poison the queue for later operations', async () => {
    const failing = vi
      .spyOn(fakeBrowser.storage.local, 'set')
      .mockRejectedValue(new Error('storage unavailable'));

    await expect(markScheduleInvalidated(AREA, NOW)).rejects.toThrow();

    failing.mockRestore();

    await expect(markScheduleInvalidated(AREA, NOW)).resolves.toBeUndefined();
    expect(await isScheduleInvalidated(AREA, NOW)).toBe(true);
  });
});
