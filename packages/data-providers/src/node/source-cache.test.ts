import type { CollectionEvent } from '@abfall-radar/domain';
import { describe, expect, it, vi } from 'vitest';
import { type CollectionSourceManifest, SourceFailureError } from '../source';
import { createMutableClock } from '../test/fake-fetch';
import { koblenzStadtmitteManifest } from './koblenz/manifest';
import { createScheduleCache, FRESH_TTL_MS, STALE_IF_ERROR_MAX_MS } from './source-cache';

const manifest = koblenzStadtmitteManifest;

const START = new Date('2026-07-29T08:00:00.000Z');

const event = (id: string): CollectionEvent => ({
  id,
  districtId: manifest.serviceAreaId,
  type: 'paper',
  date: '2026-08-14',
  title: 'Altpapier',
  source: 'municipal_ics',
  collectionMode: 'curbside',
  timing: { kind: 'all_day' },
});

interface Harness {
  readonly cache: ReturnType<typeof createScheduleCache>;
  readonly clock: ReturnType<typeof createMutableClock>;
  readonly refresh: ReturnType<typeof vi.fn>;
}

const createHarness = (
  refresh: (manifest: CollectionSourceManifest) => Promise<readonly CollectionEvent[]>,
): Harness => {
  const clock = createMutableClock(START);
  const spy = vi.fn(refresh);

  return { cache: createScheduleCache({ clock, refresh: spy }), clock, refresh: spy };
};

describe('the fresh time-to-live', () => {
  it('performs no upstream request for a second read inside the TTL', async () => {
    const { cache, clock, refresh } = createHarness(async () => [event('a')]);

    await cache.read(manifest);
    clock.advance(FRESH_TTL_MS - 1);

    const second = await cache.read(manifest);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(second.freshness).toBe('fresh');
  });

  it('refreshes once the TTL has elapsed', async () => {
    const { cache, clock, refresh } = createHarness(async () => [event('a')]);

    await cache.read(manifest);
    clock.advance(FRESH_TTL_MS);
    await cache.read(manifest);

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('reports the retrieval timestamp of the value it served', async () => {
    const { cache } = createHarness(async () => [event('a')]);

    expect((await cache.read(manifest)).retrievedAt).toEqual(START);
  });
});

describe('refresh coalescing', () => {
  it('turns concurrent reads of one source into exactly one upstream request', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { cache, refresh } = createHarness(async () => {
      await gate;

      return [event('a')];
    });

    const reads = [cache.read(manifest), cache.read(manifest), cache.read(manifest)];

    release?.();

    const results = await Promise.all(reads);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.freshness)).toEqual(['fresh', 'fresh', 'fresh']);
  });

  it('does not reuse a settled refresh for a later read past the TTL', async () => {
    const { cache, clock, refresh } = createHarness(async () => [event('a')]);

    await Promise.all([cache.read(manifest), cache.read(manifest)]);
    clock.advance(FRESH_TTL_MS);
    await cache.read(manifest);

    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe('stale-if-error', () => {
  it('serves the cached value with the preserved last-success timestamp', async () => {
    let failing = false;
    const { cache, clock } = createHarness(async () => {
      if (failing) {
        throw new SourceFailureError('network-error');
      }

      return [event('a')];
    });

    await cache.read(manifest);

    failing = true;
    clock.advance(FRESH_TTL_MS + 1);

    const stale = await cache.read(manifest);

    expect(stale.freshness).toBe('stale');
    // Not advanced by the failed refresh: a stale response never claims to be newer than it is.
    expect(stale.retrievedAt).toEqual(START);
    expect(stale.staleWarning).toEqual({ reason: 'network-error' });
    expect(stale.events).toHaveLength(1);
  });

  it('fails rather than manufacturing a stale value when nothing was ever retrieved', async () => {
    const { cache } = createHarness(async () => {
      throw new SourceFailureError('status-rejected');
    });

    await expect(cache.read(manifest)).rejects.toMatchObject({
      reason: 'status-rejected',
      kind: 'unavailable',
    });
  });

  it('does not serve a cached value past the seven-day maximum', async () => {
    let failing = false;
    const { cache, clock } = createHarness(async () => {
      if (failing) {
        throw new SourceFailureError('deadline-exceeded');
      }

      return [event('a')];
    });

    await cache.read(manifest);

    failing = true;
    clock.advance(STALE_IF_ERROR_MAX_MS + 1);

    await expect(cache.read(manifest)).rejects.toMatchObject({ reason: 'deadline-exceeded' });
  });

  it('still serves a cached value exactly at the seven-day boundary', async () => {
    let failing = false;
    const { cache, clock } = createHarness(async () => {
      if (failing) {
        throw new SourceFailureError('deadline-exceeded');
      }

      return [event('a')];
    });

    await cache.read(manifest);

    failing = true;
    clock.advance(STALE_IF_ERROR_MAX_MS);

    expect((await cache.read(manifest)).freshness).toBe('stale');
  });

  it('recovers to fresh once the source works again', async () => {
    let failing = true;
    const { cache, clock } = createHarness(async () => {
      if (failing) {
        throw new SourceFailureError('network-error');
      }

      return [event('recovered')];
    });

    await expect(cache.read(manifest)).rejects.toMatchObject({ reason: 'network-error' });

    failing = false;
    clock.advance(1_000);

    const recovered = await cache.read(manifest);

    expect(recovered.freshness).toBe('fresh');
    expect(recovered.staleWarning).toBeUndefined();
  });
});

describe('unexpected failures', () => {
  it('propagates a non-source error instead of hiding it behind stale data', async () => {
    // A bug in our own code must surface as an internal error, not be dressed up as an upstream
    // problem and masked by a previously cached value.
    let broken = false;
    const { cache, clock } = createHarness(async () => {
      if (broken) {
        throw new TypeError('a genuine programming mistake');
      }

      return [event('a')];
    });

    await cache.read(manifest);

    broken = true;
    clock.advance(FRESH_TTL_MS + 1);

    await expect(cache.read(manifest)).rejects.toThrowError(TypeError);
  });
});
