import { describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  curbsideEvent,
  mobileDropOffEvent,
  OFFICIAL_AREA_ID,
  OFFICIAL_PROVIDER_ID,
  schedule,
} from '@/src/test/fixtures';
import {
  CACHE_RETENTION_DAYS,
  evictCacheEntry,
  readCacheEntry,
  toCacheKey,
  writeCacheEntry,
} from './schedule-cache';

const ORIGIN = 'http://127.0.0.1:3000';

const OTHER_ORIGIN = 'https://api.example.test';

const KEY_PARTS = {
  origin: ORIGIN,
  providerId: OFFICIAL_PROVIDER_ID,
  serviceAreaId: OFFICIAL_AREA_ID,
};

const NOW = new Date('2026-03-01T09:00:00.000Z');

const OTHER_AREA_FOR_IDENTITY = 'koblenz-oberwerth';

const daysLater = (days: number): Date => new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);

const readRaw = async (): Promise<Record<string, unknown>> => {
  const stored = (await fakeBrowser.storage.local.get('schedule-cache'))['schedule-cache'];

  return stored === undefined || stored === null ? {} : (stored as Record<string, unknown>);
};

const seed = async (value: Record<string, unknown>): Promise<void> => {
  await fakeBrowser.storage.local.set({ 'schedule-cache': value });
};

/** Puts two unusable entries in the record, so the next read has something to evict. */
const seedForeignAndExpired = async (): Promise<void> => {
  await seed({
    [toCacheKey({ ...KEY_PARTS, origin: OTHER_ORIGIN })]: {
      origin: OTHER_ORIGIN,
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
      schedule: schedule(),
      storedAt: NOW.toISOString(),
    },
    'broken-key': { origin: ORIGIN, nonsense: true },
  });
};

describe('toCacheKey', () => {
  it('keys an entry by origin, provider, and area', () => {
    expect(toCacheKey(KEY_PARTS)).toBe(
      'http://127.0.0.1:3000|koblenz-servicebetrieb|koblenz-stadtmitte',
    );
  });

  it('gives two origins two different keys for the same area', () => {
    // Data retrieved from a development API must never be presented under a different configured origin.
    expect(toCacheKey(KEY_PARTS)).not.toBe(toCacheKey({ ...KEY_PARTS, origin: OTHER_ORIGIN }));
  });
});

describe('writeCacheEntry', () => {
  it('stores a validated response with this client’s own storage time', async () => {
    expect(await writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: NOW })).toBe('written');

    const entry = await readCacheEntry(KEY_PARTS, NOW);

    expect(entry?.storedAt).toBe(NOW.toISOString());
    // Distinct from the server's retrieval time, which is preserved untouched.
    expect(entry?.schedule.provenance.retrievedAt).toBe('2026-03-01T08:14:02.000Z');
  });

  it('overwrites an entry whose retrieval time is not older', async () => {
    await writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: NOW });

    const newer = schedule({ retrievedAt: '2026-03-02T08:00:00.000Z' });

    expect(await writeCacheEntry({ ...KEY_PARTS, schedule: newer, now: daysLater(1) })).toBe(
      'written',
    );
    expect((await readCacheEntry(KEY_PARTS, daysLater(1)))?.schedule.provenance.retrievedAt).toBe(
      '2026-03-02T08:00:00.000Z',
    );
  });

  it('does not let an upstream-stale response displace a newer cached result', async () => {
    const newer = schedule({ retrievedAt: '2026-03-02T08:00:00.000Z' });

    await writeCacheEntry({ ...KEY_PARTS, schedule: newer, now: NOW });

    const older = schedule({ retrievedAt: '2026-02-28T08:00:00.000Z', freshness: 'stale' });

    expect(await writeCacheEntry({ ...KEY_PARTS, schedule: older, now: daysLater(1) })).toBe(
      'kept_newer',
    );

    const entry = await readCacheEntry(KEY_PARTS, daysLater(1));

    expect(entry?.schedule.provenance.retrievedAt).toBe('2026-03-02T08:00:00.000Z');
    expect(entry?.schedule.provenance.freshness).toBe('fresh');
  });

  it('overwrites when the retrieval time is exactly equal', async () => {
    await writeCacheEntry({ ...KEY_PARTS, schedule: schedule({ events: [] }), now: NOW });

    expect(await writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: daysLater(1) })).toBe(
      'written',
    );
    expect((await readCacheEntry(KEY_PARTS, daysLater(1)))?.schedule.events).toHaveLength(2);
  });

  it('keeps entries for different areas side by side', async () => {
    await writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: NOW });
    await writeCacheEntry({
      ...KEY_PARTS,
      serviceAreaId: 'koblenz-oberwerth',
      // That area's own events: an entry whose events name a different area is not usable at all.
      schedule: schedule({ serviceAreaId: 'koblenz-oberwerth' }),
      now: NOW,
    });

    expect(Object.keys(await readRaw())).toHaveLength(2);
  });

  it('stores the response unfiltered, so a later differently overlapping request finds everything', async () => {
    await writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: NOW });

    const entry = await readCacheEntry(KEY_PARTS, NOW);

    expect(entry?.schedule.events).toHaveLength(2);
    expect(entry?.schedule.servedRange).toEqual({ from: '2026-03-01', to: '2026-05-30' });
  });
});

describe('readCacheEntry', () => {
  it('returns nothing when no entry was ever stored', async () => {
    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('returns nothing for another area of the same provider', async () => {
    await writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: NOW });

    expect(
      await readCacheEntry({ ...KEY_PARTS, serviceAreaId: 'koblenz-oberwerth' }, NOW),
    ).toBeUndefined();
  });

  it('never reuses an entry across origins', async () => {
    await writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: NOW });

    expect(await readCacheEntry({ ...KEY_PARTS, origin: OTHER_ORIGIN }, NOW)).toBeUndefined();
  });

  it('evicts an entry belonging to another origin', async () => {
    await writeCacheEntry({ ...KEY_PARTS, origin: OTHER_ORIGIN, schedule: schedule(), now: NOW });

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
    expect(await readRaw()).toEqual({});
  });

  it('keeps an entry inside its retention window', async () => {
    await writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: NOW });

    expect(await readCacheEntry(KEY_PARTS, daysLater(CACHE_RETENTION_DAYS))).toBeDefined();
  });

  it('evicts an entry past the retention window rather than retaining it', async () => {
    await writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: NOW });

    const wellPast = daysLater(CACHE_RETENTION_DAYS + 1);

    expect(await readCacheEntry(KEY_PARTS, wellPast)).toBeUndefined();
    expect(await readRaw()).toEqual({});
  });

  it('evicts an entry that no longer validates', async () => {
    await seed({ [toCacheKey(KEY_PARTS)]: { origin: ORIGIN, nonsense: true } });

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
    expect(await readRaw()).toEqual({});
  });

  it('tolerates a stored cache that is not an object at all', async () => {
    await seed('corrupt' as unknown as Record<string, unknown>);

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('preserves a still-usable entry while evicting an unusable one', async () => {
    await writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: NOW });
    const raw = await readRaw();

    await seed({
      ...raw,
      'stale-key': { origin: ORIGIN, broken: true },
      [toCacheKey({ ...KEY_PARTS, origin: OTHER_ORIGIN })]: {
        origin: OTHER_ORIGIN,
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: OFFICIAL_AREA_ID,
        schedule: schedule(),
        storedAt: NOW.toISOString(),
      },
    });

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();
    expect(Object.keys(await readRaw())).toEqual([toCacheKey(KEY_PARTS)]);
  });
});

describe('concurrent mutations', () => {
  const OTHER_AREA = 'koblenz-oberwerth';

  const otherParts = { ...KEY_PARTS, serviceAreaId: OTHER_AREA };

  it('preserves both entries when two writes for different keys run concurrently', async () => {
    // Every mutation is read-modify-write over the whole record. Unserialized, both writes read the same
    // base and the second one silently discards the first — a stored schedule vanishing because a different
    // area was refreshed at the same moment.
    await Promise.all([
      writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: NOW }),
      writeCacheEntry({
        ...otherParts,
        schedule: schedule({ serviceAreaId: OTHER_AREA }),
        now: NOW,
      }),
    ]);

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();
    expect(await readCacheEntry(otherParts, NOW)).toBeDefined();
    expect(Object.keys(await readRaw())).toHaveLength(2);
  });

  it('preserves both entries when many writes for different keys run concurrently', async () => {
    const areas = ['a-one', 'a-two', 'a-three', 'a-four', 'a-five'];

    await Promise.all(
      areas.map((serviceAreaId) =>
        writeCacheEntry({
          ...KEY_PARTS,
          serviceAreaId,
          schedule: schedule({ serviceAreaId }),
          now: NOW,
        }),
      ),
    );

    expect(Object.keys(await readRaw())).toHaveLength(areas.length);
  });

  it('does not lose an unrelated entry when a write and an eviction run concurrently', async () => {
    await writeCacheEntry({
      ...otherParts,
      schedule: schedule({ serviceAreaId: OTHER_AREA }),
      now: NOW,
    });

    await Promise.all([
      writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: NOW }),
      evictCacheEntry(otherParts, NOW),
    ]);

    // Whichever order they ran in, the write's own entry survives and only the evicted key is gone.
    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();
    expect(await readCacheEntry(otherParts, NOW)).toBeUndefined();
  });

  it('does not lose an unrelated entry when an eviction and a write of a third key interleave', async () => {
    await writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: NOW });
    await writeCacheEntry({
      ...otherParts,
      schedule: schedule({ serviceAreaId: OTHER_AREA }),
      now: NOW,
    });

    await Promise.all([
      evictCacheEntry(otherParts, NOW),
      writeCacheEntry({
        ...KEY_PARTS,
        serviceAreaId: 'a-third',
        schedule: schedule({ serviceAreaId: 'a-third' }),
        now: NOW,
      }),
    ]);

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();
    expect(await readCacheEntry({ ...KEY_PARTS, serviceAreaId: 'a-third' }, NOW)).toBeDefined();
    expect(await readCacheEntry(otherParts, NOW)).toBeUndefined();
  });

  it('does not lose an entry when a read-eviction pass and a write run concurrently', async () => {
    // A read can rewrite the record too, when it drops something unusable, so it is serialized as well.
    await seedForeignAndExpired();

    await Promise.all([
      readCacheEntry(KEY_PARTS, NOW),
      writeCacheEntry({
        ...otherParts,
        schedule: schedule({ serviceAreaId: OTHER_AREA }),
        now: NOW,
      }),
    ]);

    expect(await readCacheEntry(otherParts, NOW)).toBeDefined();
  });

  it('keeps serving later mutations after one has failed', async () => {
    // An invalid clock makes `storedAt` unrepresentable, so this mutation rejects inside the queue. A tail
    // that adopted that rejection would block every later operation permanently.
    await expect(
      writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: new Date(Number.NaN) }),
    ).rejects.toThrow();

    expect(await writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: NOW })).toBe('written');
    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();
    await expect(evictCacheEntry(KEY_PARTS, NOW)).resolves.toBeUndefined();
    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('keeps serving mutations queued behind a failing one', async () => {
    const [failed, written] = await Promise.allSettled([
      writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: new Date(Number.NaN) }),
      writeCacheEntry({
        ...otherParts,
        schedule: schedule({ serviceAreaId: OTHER_AREA }),
        now: NOW,
      }),
    ]);

    expect(failed?.status).toBe('rejected');
    expect(written?.status).toBe('fulfilled');
    expect(await readCacheEntry(otherParts, NOW)).toBeDefined();
  });
});

describe('evictCacheEntry', () => {
  it('drops the named entry', async () => {
    await writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: NOW });
    await evictCacheEntry(KEY_PARTS, NOW);

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('leaves another area’s entry alone', async () => {
    await writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: NOW });
    await writeCacheEntry({
      ...KEY_PARTS,
      serviceAreaId: 'koblenz-oberwerth',
      schedule: schedule({ serviceAreaId: 'koblenz-oberwerth' }),
      now: NOW,
    });

    await evictCacheEntry(KEY_PARTS, NOW);

    expect(
      await readCacheEntry({ ...KEY_PARTS, serviceAreaId: 'koblenz-oberwerth' }, NOW),
    ).toBeDefined();
  });

  it('is a no-op when nothing is stored', async () => {
    await expect(evictCacheEntry(KEY_PARTS, NOW)).resolves.toBeUndefined();
  });
});

describe('a persisted record whose identity contradicts its key', () => {
  /**
   * Persisted storage is untrusted: it survives upgrades, and nothing stops a corrupted write from filing a
   * record under a key that disagrees with its own contents. A lookup would otherwise be handed a different
   * area's schedule — official-looking dates for somewhere the user never chose.
   */
  /**
   * A record whose **only** defect is the override under test.
   *
   * The schedule follows whichever area the record claims, so overriding `serviceAreaId` produces a record
   * that is internally consistent and merely filed under the wrong key. Without that, the override introduced
   * two defects at once and the test could pass for the wrong reason.
   */
  const recordFor = (overrides: Record<string, unknown>) => {
    const claimedArea =
      typeof overrides.serviceAreaId === 'string' ? overrides.serviceAreaId : OFFICIAL_AREA_ID;

    return {
      origin: ORIGIN,
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
      schedule: schedule({ serviceAreaId: claimedArea }),
      storedAt: NOW.toISOString(),
      ...overrides,
    };
  };

  it('rejects a record whose serviceAreaId does not derive its key', async () => {
    await seed({ [toCacheKey(KEY_PARTS)]: recordFor({ serviceAreaId: 'somewhere-else' }) });

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('rejects a record whose providerId does not derive its key', async () => {
    await seed({ [toCacheKey(KEY_PARTS)]: recordFor({ providerId: 'another-betrieb' }) });

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('rejects a record found under this origin’s key while naming another origin', async () => {
    // The origin half of the same invariant, and the case the existing foreign-origin test does not reach:
    // there the record sat under the foreign key, so the lookup missed it anyway. Here it is filed under
    // exactly the requested key, so only its declared identity gives it away.
    await seed({ [toCacheKey(KEY_PARTS)]: recordFor({ origin: OTHER_ORIGIN }) });

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
    expect(await readRaw()).toEqual({});
  });

  it('never reuses a record across origins even when both sides agree on the area', async () => {
    // Filed under another origin's key and naming that origin: consistent in itself, but not this origin's
    // data, so a lookup here must not see it.
    await seed({
      [toCacheKey({ ...KEY_PARTS, origin: OTHER_ORIGIN })]: recordFor({ origin: OTHER_ORIGIN }),
    });

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('evicts a mismatched record rather than leaving it to be read again', async () => {
    await seed({ [toCacheKey(KEY_PARTS)]: recordFor({ serviceAreaId: 'somewhere-else' }) });

    await readCacheEntry(KEY_PARTS, NOW);

    expect(await readRaw()).toEqual({});
  });

  it('keeps a record whose identity does derive its key', async () => {
    // The mirror image: proof the check rejects contradictions rather than everything.
    await seed({ [toCacheKey(KEY_PARTS)]: recordFor({}) });

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();
  });

  it('evicts a mismatched record while preserving a valid sibling', async () => {
    // Composition with the ordinary eviction pass: a contradictory record is dropped, and the other area's
    // perfectly good entry is not collateral damage.
    const siblingParts = { ...KEY_PARTS, serviceAreaId: OTHER_AREA_FOR_IDENTITY };

    await seed({
      [toCacheKey(KEY_PARTS)]: recordFor({ serviceAreaId: OTHER_AREA_FOR_IDENTITY }),
      [toCacheKey(siblingParts)]: recordFor({ serviceAreaId: OTHER_AREA_FOR_IDENTITY }),
    });

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
    expect(Object.keys(await readRaw())).toEqual([toCacheKey(siblingParts)]);
    expect(await readCacheEntry(siblingParts, NOW)).toBeDefined();
  });
});

/**
 * An entry is usable only when its **contents** agree with its identity, not merely when every member is
 * well shaped.
 *
 * This is where "untrusted input" stops being theoretical. The record survives upgrades, it may have been
 * written by a build whose validation was weaker than today's, and a partial or corrupted write can combine
 * one area's identity with another's events. Each contradiction below is a path by which a schedule would
 * cross a provider, area, or date boundary — and the cache is the layer where nothing downstream re-checks.
 *
 * Every case drops the **whole** entry. Filtering the offending events would leave something that looks like a
 * complete schedule for its range while being assembled from a record already known to be inconsistent.
 */
describe('a persisted entry whose contents contradict its identity', () => {
  const OTHER_AREA = 'koblenz-oberwerth';

  /** Writes a raw record directly, bypassing `writeCacheEntry`, as an older build's leftovers would appear. */
  const seedRaw = async (schedulePayload: unknown): Promise<void> => {
    await seed({
      [toCacheKey(KEY_PARTS)]: {
        origin: ORIGIN,
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: OFFICIAL_AREA_ID,
        schedule: schedulePayload,
        storedAt: NOW.toISOString(),
      },
    });
  };

  it('evicts an entry whose only event belongs to another service area', async () => {
    await seedRaw(schedule({ events: [curbsideEvent('2026-03-10', 'paper', OTHER_AREA)] }));

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
    expect(await readRaw()).toEqual({});
  });

  it('evicts the whole entry when one event among valid ones belongs to another area', async () => {
    // Not filtered down to the events that match: one foreign event makes the set untrustworthy, and the
    // remainder would be presented as this area's complete schedule for the served range.
    await seedRaw(
      schedule({
        events: [
          curbsideEvent('2026-03-10'),
          curbsideEvent('2026-03-17', 'paper', OTHER_AREA),
          curbsideEvent('2026-03-24'),
        ],
      }),
    );

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
    expect(await readRaw()).toEqual({});
  });

  it('evicts an entry holding an event before its served range', async () => {
    // The display range is the intersection of the served range with what is wanted now, and the reminder
    // considers only events inside it — so an event outside the served range is covered by a range that never
    // included it.
    await seedRaw(
      schedule({
        servedRange: { from: '2026-03-01', to: '2026-05-30' },
        events: [curbsideEvent('2026-02-20')],
      }),
    );

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('evicts an entry holding an event after its served range', async () => {
    await seedRaw(
      schedule({
        servedRange: { from: '2026-03-01', to: '2026-05-30' },
        events: [curbsideEvent('2026-06-01')],
      }),
    );

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('keeps events exactly on both served-range boundaries', async () => {
    // The range is closed, so the first and last day are inside it rather than edge cases to discard.
    await seedRaw(
      schedule({
        servedRange: { from: '2026-03-01', to: '2026-05-30' },
        events: [curbsideEvent('2026-03-01'), curbsideEvent('2026-05-30')],
      }),
    );

    expect((await readCacheEntry(KEY_PARTS, NOW))?.schedule.events).toHaveLength(2);
  });

  it('evicts an entry served beyond the validity window its own provenance declares', async () => {
    // The requested range is clamped into that window before any request, so an entry claiming to have been
    // served past it describes something that could not have happened.
    await seedRaw(schedule({ servedRange: { from: '2026-03-01', to: '2027-06-30' }, events: [] }));

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('evicts an entry whose served range is inverted', async () => {
    // Every intersection against it is empty, which would render as "no collection scheduled".
    await seedRaw(schedule({ servedRange: { from: '2026-05-30', to: '2026-03-01' }, events: [] }));

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('keeps a fully consistent entry, so the checks reject contradictions rather than everything', async () => {
    await seedRaw(schedule());

    const entry = await readCacheEntry(KEY_PARTS, NOW);

    expect(entry).toBeDefined();
    expect(entry?.schedule.events).toHaveLength(2);
    expect(entry?.schedule.events.every((event) => event.serviceAreaId === OFFICIAL_AREA_ID)).toBe(
      true,
    );
  });

  it('drops a contradictory entry without touching a consistent sibling', async () => {
    const siblingParts = { ...KEY_PARTS, serviceAreaId: OTHER_AREA };

    await seed({
      [toCacheKey(KEY_PARTS)]: {
        origin: ORIGIN,
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: OFFICIAL_AREA_ID,
        schedule: schedule({ events: [curbsideEvent('2026-03-10', 'paper', OTHER_AREA)] }),
        storedAt: NOW.toISOString(),
      },
      [toCacheKey(siblingParts)]: {
        origin: ORIGIN,
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: OTHER_AREA,
        schedule: schedule({ serviceAreaId: OTHER_AREA }),
        storedAt: NOW.toISOString(),
      },
    });

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
    expect(await readCacheEntry(siblingParts, NOW)).toBeDefined();
    expect(Object.keys(await readRaw())).toEqual([toCacheKey(siblingParts)]);
  });
});

/**
 * A persisted entry has to be official municipal data, checked independently of the boundary that accepted it.
 *
 * The transport now refuses a demo provider and any event that is not `municipal_ics`, but a record on disk may
 * have been written by a build that did not — or altered since. A cached demo or hand-entered event is the most
 * damaging thing this extension could present: it appears under the operator's name, with their attribution, and
 * a reminder built from it tells someone to act on a date nobody published.
 */
describe('a persisted entry that is not official municipal data', () => {
  /** Writes a raw record directly, bypassing `writeCacheEntry`, as an older build's leftovers would appear. */
  const seedRaw = async (schedulePayload: unknown): Promise<void> => {
    await seed({
      [toCacheKey(KEY_PARTS)]: {
        origin: ORIGIN,
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: OFFICIAL_AREA_ID,
        schedule: schedulePayload,
        storedAt: NOW.toISOString(),
      },
    });
  };

  /** A curbside event whose source is under test. */
  const eventFrom = (source: string) => ({
    ...curbsideEvent('2026-03-10'),
    source,
  });

  it('evicts an entry whose only event is demo data', async () => {
    await seedRaw({ ...schedule({ events: [] }), events: [eventFrom('demo')] });

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
    expect(await readRaw()).toEqual({});
  });

  it('evicts an entry whose only event was entered by a person', async () => {
    await seedRaw({ ...schedule({ events: [] }), events: [eventFrom('user_rule')] });

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('evicts the whole entry when one event among municipal ones is not official', async () => {
    // Not filtered: the remainder would be presented as the complete official schedule for the served range.
    await seedRaw({
      ...schedule({ events: [] }),
      events: [curbsideEvent('2026-03-10'), eventFrom('demo'), curbsideEvent('2026-03-24', 'bio')],
    });

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
    expect(await readRaw()).toEqual({});
  });

  it('keeps an entry whose every event is municipal, so the check rejects contradictions rather than everything', async () => {
    await seedRaw(schedule());

    const entry = await readCacheEntry(KEY_PARTS, NOW);

    expect(entry).toBeDefined();
    expect(entry?.schedule.events.every((event) => event.source === 'municipal_ics')).toBe(true);
  });

  it('evicts an entry holding an inverted drop-off window', async () => {
    // The domain refuses an inverted window by throwing, and the adapter runs during rendering and inside the
    // alarm handler — so it has to be refused here, on the way out of storage.
    const inverted = {
      ...mobileDropOffEvent('2026-03-21'),
      timing: {
        kind: 'time_window' as const,
        startsAt: '2026-03-21T12:00:00Z',
        endsAt: '2026-03-21T10:00:00Z',
        timeZone: 'Europe/Berlin',
      },
    };

    await seedRaw({ ...schedule({ events: [] }), events: [inverted] });

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('keeps an entry whose drop-off window ends exactly when it starts', async () => {
    // Inclusive, matching the domain: a zero-length window stays representable.
    const zeroLength = {
      ...mobileDropOffEvent('2026-03-21'),
      timing: {
        kind: 'time_window' as const,
        startsAt: '2026-03-21T10:00:00Z',
        endsAt: '2026-03-21T10:00:00Z',
        timeZone: 'Europe/Berlin',
      },
    };

    await seedRaw({ ...schedule({ events: [] }), events: [zeroLength] });

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();
  });
});

/**
 * A persisted entry carrying an unusable link or a contradictory window is evicted.
 *
 * Both are checked independently of the HTTP boundary that first accepted the response, because a record on disk
 * may have been written by a build with weaker validation — and the link is rendered as an `href` while the window
 * is what every range derivation depends on.
 */
describe('a persisted entry whose provenance cannot be trusted', () => {
  const seedRaw = async (provenanceOverrides: Record<string, unknown>): Promise<void> => {
    const base = schedule();

    await seed({
      [toCacheKey(KEY_PARTS)]: {
        origin: ORIGIN,
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: OFFICIAL_AREA_ID,
        schedule: { ...base, provenance: { ...base.provenance, ...provenanceOverrides } },
        storedAt: NOW.toISOString(),
      },
    });
  };

  it.each([
    ['a javascript: link', 'javascript:alert(1)'],
    ['a data: link', 'data:text/html,<script>alert(1)</script>'],
    ['a file: link', 'file:///etc/passwd'],
    ['an ftp: link', 'ftp://servicebetrieb.koblenz.de/'],
    ['a blob: link', 'blob:https://servicebetrieb.koblenz.de/1'],
    ['a credential-bearing link', 'https://user:secret@servicebetrieb.koblenz.de/'],
    ['a malformed link', 'not a url'],
  ])('evicts an entry carrying %s', async (_reason, landingPageUrl) => {
    await seedRaw({ landingPageUrl });

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
    expect(await readRaw()).toEqual({});
  });

  it('keeps an entry whose link is an ordinary https address', async () => {
    await seedRaw({ landingPageUrl: 'https://servicebetrieb.koblenz.de/termine' });

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();
  });

  it('evicts an entry whose declared validity window is inverted', async () => {
    // Every intersection against it would be empty, which reads as the source publishing nothing.
    await seedRaw({ validity: { from: '2026-12-31', to: '2026-01-01' } });

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('evicts an entry whose served range reaches beyond its declared window', async () => {
    // The default fixture serves 2026-03-01..2026-05-30, so a window ending in April contradicts it.
    await seedRaw({ validity: { from: '2026-01-01', to: '2026-04-30' } });

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('keeps an entry whose served range sits exactly on its window boundaries', async () => {
    await seedRaw({ validity: { from: '2026-03-01', to: '2026-05-30' } });

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();
  });
});

/**
 * An entry cannot have been stored later than the moment it is read.
 *
 * The age was computed as `now - storedAt` and compared only against the upper bound, so a future timestamp gave a
 * *negative* age and passed as comfortably fresh. The stamp comes from the client's own clock, so a device that
 * was running ahead when the entry was written and has since been corrected leaves exactly that — and the entry
 * would then survive the whole retention window plus however far ahead the clock had been.
 *
 * The clock is injected throughout, so none of this depends on the machine running the test.
 */
describe('an entry whose stored time is in the future', () => {
  /** Writes a raw record with a chosen `storedAt`, bypassing the write path's own clock. */
  const seedStoredAt = async (storedAt: Date): Promise<void> => {
    await seed({
      [toCacheKey(KEY_PARTS)]: {
        origin: ORIGIN,
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: OFFICIAL_AREA_ID,
        schedule: schedule(),
        storedAt: storedAt.toISOString(),
      },
    });
  };

  it('accepts a timestamp exactly equal to now', async () => {
    // Stored this instant, which is the freshest an entry can be — so the future check is strict.
    await seedStoredAt(NOW);

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();
  });

  it('evicts a timestamp one millisecond in the future', async () => {
    await seedStoredAt(new Date(NOW.getTime() + 1));

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
    expect(await readRaw()).toEqual({});
  });

  it('evicts a timestamp far in the future', async () => {
    await seedStoredAt(daysLater(365));

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('evicts an entry once the clock is moved backwards after it was stored', async () => {
    // The real sequence: the device wrote the entry while its clock was ahead, then the clock was corrected.
    await writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: daysLater(3) });

    expect(await readCacheEntry(KEY_PARTS, daysLater(3))).toBeDefined();
    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('does not let a future entry block a later valid write', async () => {
    await seedStoredAt(daysLater(10));

    expect(await writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: NOW })).toBe('written');

    const entry = await readCacheEntry(KEY_PARTS, NOW);

    expect(entry?.storedAt).toBe(NOW.toISOString());
  });

  it('restores nothing for a future entry, so nothing can be displayed or reminded about', async () => {
    await seedStoredAt(daysLater(1));

    // The one read every surface and the reminder go through.
    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('keeps an ordinary entry inside the retention window', async () => {
    // The mirror image, so the checks above cannot pass by everything being evicted.
    await writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: NOW });

    expect(await readCacheEntry(KEY_PARTS, daysLater(6))).toBeDefined();
  });

  it('keeps an entry exactly at the retention boundary and evicts one past it', async () => {
    await writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: NOW });

    // Inclusive at the upper bound, unchanged by the future check.
    expect(await readCacheEntry(KEY_PARTS, daysLater(CACHE_RETENTION_DAYS))).toBeDefined();

    await writeCacheEntry({ ...KEY_PARTS, schedule: schedule(), now: NOW });

    expect(
      await readCacheEntry(KEY_PARTS, new Date(daysLater(CACHE_RETENTION_DAYS).getTime() + 1)),
    ).toBeUndefined();
  });
});

/**
 * A place name that is not canonical makes a persisted entry unusable.
 *
 * The cache validates with the message contract's payload schema, which reuses the domain's location rule, so an
 * entry carrying an untrimmed name fails validation exactly as a live response does. It matters because storage
 * outlives the build that wrote it: an entry written before the rule existed must be evicted rather than restored
 * for ever, and never silently trimmed into something the domain would then accept.
 */
describe('a persisted entry whose drop-off location is not canonical', () => {
  const seedWithLocationName = async (name: string): Promise<void> => {
    const entry = {
      origin: ORIGIN,
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
      schedule: schedule({ events: [{ ...mobileDropOffEvent('2026-03-10'), location: { name } }] }),
      storedAt: NOW.toISOString(),
    };

    await seed({ [toCacheKey(entry)]: entry });
  };

  it.each([
    ['leading whitespace', ' Rizzastraße'],
    ['trailing whitespace', 'Rizzastraße '],
    ['whitespace at both ends', ' Rizzastraße '],
    ['nothing but whitespace', '   '],
    ['nothing at all', ''],
  ])('is never restored, for %s', async (_reason, name) => {
    await seedWithLocationName(name);

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('is evicted rather than left to be rejected again on every read', async () => {
    // Eviction on read is what bounds the store. An entry that failed validation but stayed would be re-parsed
    // and re-rejected for as long as it sat there.
    await seedWithLocationName(' Rizzastraße ');

    await readCacheEntry(KEY_PARTS, NOW);

    expect(await readRaw()).toEqual({});
  });

  it('is not trimmed into something acceptable', async () => {
    // The failure mode a normalizing validator would produce: a place quietly filed under a second spelling.
    await seedWithLocationName(' Rizzastraße ');

    const restored = await readCacheEntry(KEY_PARTS, NOW);

    expect(restored).toBeUndefined();
    expect(JSON.stringify(await readRaw())).not.toContain('Rizzastraße');
  });

  it('leaves a canonical drop-off entry perfectly usable', async () => {
    // The counterweight: the rule refuses the wrong spellings without refusing drop-offs.
    await seedWithLocationName('Rizzastraße Ecke Südallee');

    const restored = await readCacheEntry(KEY_PARTS, NOW);

    expect(restored).toBeDefined();
    expect(JSON.stringify(restored)).toContain('Rizzastraße Ecke Südallee');
  });
});

/**
 * A persisted entry whose events contradict its own coverage declaration is withheld.
 *
 * The transport boundary refuses such a response now, but storage outlives the build that wrote it: an entry
 * persisted before that check existed comes back through this schema on every read, and it is the last remaining
 * path by which a collection the source disclaims could reach the dashboard or a reminder.
 */
describe('a persisted entry whose events contradict its coverage', () => {
  const seedWithCoverage = async (coverage: string[]): Promise<void> => {
    const stored = schedule({ events: [curbsideEvent('2026-03-10', 'paper')] });
    const entry = {
      origin: ORIGIN,
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
      schedule: { ...stored, provenance: { ...stored.provenance, coverage } },
      storedAt: NOW.toISOString(),
    };

    await seed({ [toCacheKey(entry)]: entry });
  };

  it('is never restored', async () => {
    await seedWithCoverage(['bio']);

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeUndefined();
  });

  it('is evicted rather than re-rejected on every read', async () => {
    await seedWithCoverage(['bio']);

    await readCacheEntry(KEY_PARTS, NOW);

    expect(await readRaw()).toEqual({});
  });

  it('is restored normally when its coverage does declare the type', async () => {
    // The counterweight: the rule withholds a contradiction, not every entry.
    await seedWithCoverage(['paper', 'bio']);

    expect(await readCacheEntry(KEY_PARTS, NOW)).toBeDefined();
  });
});
