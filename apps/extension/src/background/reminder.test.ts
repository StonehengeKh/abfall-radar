import { createApiClient } from '@abfall-radar/api-client';
import type { CollectionEvent } from '@abfall-radar/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import type { RestoredSchedulePayload } from '@/src/messaging/contract';
import { writeCacheEntry } from '@/src/storage/schedule-cache';
import { defaultSettings } from '@/src/storage/settings';
import {
  invalidateSelectionIfMatches,
  readSettings,
  writeSettings,
} from '@/src/storage/settings-repository';
import {
  curbsideEvent,
  mobileDropOffEvent,
  OFFICIAL_AREA_ID,
  OFFICIAL_PROVIDER_ID,
  restoredSchedule,
  schedule,
} from '@/src/test/fixtures';
import { createGateway, type Gateway } from './gateway';
import {
  CURBSIDE_REMINDER_MESSAGE,
  getNextReminderTimestamp,
  notificationMessageFor,
  REMINDER_ALARM,
  scheduleNextReminder,
  showReminder,
} from './reminder';

const SELECTION = {
  providerId: OFFICIAL_PROVIDER_ID,
  serviceAreaId: OFFICIAL_AREA_ID,
} as const;

/** The day before the covered collection, so `reminderDaysBefore: 1` matches it. */
const NOW = new Date('2026-03-09T18:00:00.000Z');

/**
 * A gateway whose cache answers and whose API reads fail.
 *
 * The refresh path is deliberately unavailable here, so every test in the original suite still asserts what it
 * always did: what the reminder does with the **cache**. A failing refresh produces no notification, which is
 * the same outcome as the old "no cache, no reminder" behavior for those cases.
 */
const createStubGateway = (restored: RestoredSchedulePayload | null) => {
  const restoreCachedSchedule = vi
    .fn<Gateway['restoreCachedSchedule']>()
    .mockResolvedValue(restored);
  const handle = vi.fn<Gateway['handle']>();
  const invalidateCachedSchedule = vi
    .fn<Gateway['invalidateCachedSchedule']>()
    .mockResolvedValue(undefined);
  const unreachable = { kind: 'network', operation: 'listProviders' } as const;
  const listProviders = vi
    .fn<Gateway['listProviders']>()
    .mockResolvedValue({ ok: false, failure: unreachable });
  const listServiceAreas = vi
    .fn<Gateway['listServiceAreas']>()
    .mockResolvedValue({ ok: false, failure: unreachable });
  const listCollectionEvents = vi
    .fn<Gateway['listCollectionEvents']>()
    .mockResolvedValue({ ok: false, failure: unreachable });

  return {
    gateway: {
      handle,
      listProviders,
      listServiceAreas,
      listCollectionEvents,
      restoreCachedSchedule,
      invalidateCachedSchedule,
    },
    restoreCachedSchedule,
    invalidateCachedSchedule,
    listProviders,
    listServiceAreas,
    listCollectionEvents,
    handle,
  };
};

/**
 * Records what the reminder actually showed.
 *
 * `fakeBrowser` implements the real API rather than mocking it, so the spy is installed per test and
 * removed afterwards.
 */
const watchNotifications = () => vi.spyOn(fakeBrowser.notifications, 'create');

/**
 * The notification options of a recorded call.
 *
 * `notifications.create` accepts either `(options)` or `(id, options)`, so the options are found by shape
 * rather than by a fixed position.
 */
const optionsOf = (call: readonly unknown[] | undefined): Record<string, unknown> | undefined => {
  const options = call?.find((argument) => typeof argument === 'object' && argument !== null);

  return options === undefined ? undefined : { ...(options as Record<string, unknown>) };
};

/** Writes a raw stored value, for the legacy shapes a migration has to classify. */
const setStored = async (value: unknown): Promise<void> => {
  await fakeBrowser.storage.local.set({ settings: value });
};

const withSelection = async (overrides: Partial<typeof defaultSettings> = {}): Promise<void> => {
  await writeSettings({
    ...defaultSettings,
    selection: SELECTION,
    visibleWasteTypes: ['paper'],
    ...overrides,
  });
};

describe('getNextReminderTimestamp', () => {
  it('picks today when the configured time is still ahead', () => {
    const reference = new Date('2026-03-09T10:00:00');
    const next = new Date(getNextReminderTimestamp('18:00', reference));

    expect(next.getDate()).toBe(reference.getDate());
    expect(next.getHours()).toBe(18);
  });

  it('rolls over to tomorrow once the configured time has passed', () => {
    const reference = new Date('2026-03-09T19:00:00');
    const next = new Date(getNextReminderTimestamp('18:00', reference));

    expect(next.getDate()).toBe(reference.getDate() + 1);
  });
});

describe('scheduleNextReminder', () => {
  it('keeps the existing alarm name', async () => {
    await withSelection({ remindersEnabled: true });
    await scheduleNextReminder();

    expect(await fakeBrowser.alarms.get(REMINDER_ALARM)).toBeDefined();
    expect(REMINDER_ALARM).toBe('abfall-radar-reminder');
  });

  it('clears the alarm when reminders are disabled', async () => {
    await withSelection({ remindersEnabled: true });
    await scheduleNextReminder();

    await withSelection({ remindersEnabled: false });
    await scheduleNextReminder();

    expect(await fakeBrowser.alarms.get(REMINDER_ALARM)).toBeUndefined();
  });

  it('reads settings through the repository when none are supplied', async () => {
    await withSelection({ remindersEnabled: false });
    await scheduleNextReminder();

    expect(await fakeBrowser.alarms.get(REMINDER_ALARM)).toBeUndefined();
  });

  /**
   * An alarm exists exactly when a reminder is possible, which needs **both** conditions.
   *
   * It used to be created from `remindersEnabled` alone, so a fresh install, an unknown legacy district migrated to
   * no selection, and an area withdrawn by an authoritative response all left a recurring alarm firing against
   * nothing — waking the service worker on a schedule to read the settings, find no selection and return.
   *
   * Every case asserts the `clear`/`create` calls as well as the resulting alarm, because "no alarm" has two very
   * different causes: never created, or created and then cleared.
   */
  describe('eligibility for an alarm', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const watchAlarms = () => ({
      cleared: vi.spyOn(fakeBrowser.alarms, 'clear'),
      created: vi.spyOn(fakeBrowser.alarms, 'create'),
    });

    const alarm = async () => fakeBrowser.alarms.get(REMINDER_ALARM);

    it('creates none on a fresh install, where nothing is selected', async () => {
      // `defaultSettings` has reminders enabled and no selection, which is exactly the shipped starting state.
      await writeSettings({ ...defaultSettings, selection: null });

      const { cleared, created } = watchAlarms();

      await scheduleNextReminder();

      expect(cleared).toHaveBeenCalledWith(REMINDER_ALARM);
      expect(created).not.toHaveBeenCalled();
      expect(await alarm()).toBeUndefined();
    });

    it('creates none after a legacy district migrates to no selection', async () => {
      /**
       * An unknown legacy identifier has no verified official counterpart, so it migrates to `selection: null`
       * deliberately. That is the state, not a failure — and it must not leave an alarm behind.
       */
      await setStored({
        districtId: 'koblenz-unverified',
        remindersEnabled: true,
        reminderDaysBefore: 1,
        reminderTime: '18:00',
        visibleWasteTypes: ['paper'],
      });

      const { created } = watchAlarms();

      await scheduleNextReminder();

      expect(created).not.toHaveBeenCalled();
      expect(await alarm()).toBeUndefined();
    });

    it('creates one after a verified legacy selection migrates with reminders enabled', async () => {
      // The counterpart: a hand-verified identifier does become a selection, so a reminder is possible.
      await setStored({
        districtId: 'koblenz-stadtmitte',
        remindersEnabled: true,
        reminderDaysBefore: 1,
        reminderTime: '18:00',
        visibleWasteTypes: ['paper'],
      });

      const { created } = watchAlarms();

      await scheduleNextReminder();

      expect(created).toHaveBeenCalledWith(REMINDER_ALARM, expect.anything());
      expect(await alarm()).toBeDefined();
    });

    it('creates one once an available area is confirmed', async () => {
      await writeSettings({ ...defaultSettings, selection: null });
      await scheduleNextReminder();

      expect(await alarm()).toBeUndefined();

      await withSelection({ remindersEnabled: true });

      const { created } = watchAlarms();

      await scheduleNextReminder();

      expect(created).toHaveBeenCalledWith(REMINDER_ALARM, expect.anything());
      expect(await alarm()).toBeDefined();
    });

    it('removes it when the selection is cleared as unavailable', async () => {
      await withSelection({ remindersEnabled: true });
      await scheduleNextReminder();

      expect(await alarm()).toBeDefined();

      // Exactly what an authoritative withdrawal leaves behind.
      await invalidateSelectionIfMatches(SELECTION);

      const { cleared, created } = watchAlarms();

      await scheduleNextReminder();

      expect(cleared).toHaveBeenCalledWith(REMINDER_ALARM);
      expect(created).not.toHaveBeenCalled();
      expect(await alarm()).toBeUndefined();
    });

    it('removes it when reminders are switched off', async () => {
      await withSelection({ remindersEnabled: true });
      await scheduleNextReminder();

      await withSelection({ remindersEnabled: false });

      const { cleared, created } = watchAlarms();

      await scheduleNextReminder();

      expect(cleared).toHaveBeenCalledWith(REMINDER_ALARM);
      expect(created).not.toHaveBeenCalled();
      expect(await alarm()).toBeUndefined();
    });

    it('recreates it when reminders are switched back on with a selection', async () => {
      await withSelection({ remindersEnabled: false });
      await scheduleNextReminder();

      expect(await alarm()).toBeUndefined();

      await withSelection({ remindersEnabled: true });
      await scheduleNextReminder();

      expect(await alarm()).toBeDefined();
    });

    it('creates none when reminders are switched back on without a selection', async () => {
      await writeSettings({ ...defaultSettings, selection: null, remindersEnabled: false });
      await scheduleNextReminder();

      await writeSettings({ ...defaultSettings, selection: null, remindersEnabled: true });

      const { created } = watchAlarms();

      await scheduleNextReminder();

      expect(created).not.toHaveBeenCalled();
      expect(await alarm()).toBeUndefined();
    });

    it('leaves no alarm behind once a firing run finds no selection', async () => {
      /**
       * The self-healing case. The alarm fires, the run finds nothing to remind about, and the synchronization that
       * follows it removes the alarm rather than rescheduling — so it stops rather than repeating for ever.
       */
      await withSelection({ remindersEnabled: true });
      await scheduleNextReminder();

      expect(await alarm()).toBeDefined();

      await invalidateSelectionIfMatches(SELECTION);

      const { gateway } = createStubGateway(null);
      const created = watchNotifications();

      await showReminder({ gateway, now: () => NOW });
      // Exactly what the alarm listener does after every firing.
      await scheduleNextReminder();

      expect(created).not.toHaveBeenCalled();
      expect(await alarm()).toBeUndefined();
    });

    it('never leaves two alarms behind, however often it runs', async () => {
      await withSelection({ remindersEnabled: true });

      await scheduleNextReminder();
      await scheduleNextReminder();
      await scheduleNextReminder();

      expect(await fakeBrowser.alarms.getAll()).toHaveLength(1);
    });
  });
});

describe('showReminder', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('notifies for a collection inside the covered range', async () => {
    await withSelection();

    const { gateway } = createStubGateway(
      restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
    );

    const created = watchNotifications();

    await showReminder({ gateway, now: () => NOW });

    expect(created.mock.calls).toHaveLength(1);
    expect(optionsOf(created.mock.calls[0])).toMatchObject({ title: 'Morgen: Altpapier' });
  });

  it('shows nothing while the selection is null', async () => {
    await writeSettings({ ...defaultSettings, selection: null });

    const { gateway, restoreCachedSchedule } = createStubGateway(restoredSchedule());
    const created = watchNotifications();

    await showReminder({ gateway, now: () => NOW });

    // No selection blocks the schedule read as firmly as it blocks the notification.
    expect(restoreCachedSchedule).not.toHaveBeenCalled();
    expect(created.mock.calls).toHaveLength(0);
  });

  it('shows nothing when nothing trustworthy is cached', async () => {
    await withSelection();

    const { gateway } = createStubGateway(null);

    const created = watchNotifications();

    await showReminder({ gateway, now: () => NOW });

    expect(created.mock.calls).toHaveLength(0);
  });

  it('considers only events inside the covered intersection', async () => {
    await withSelection();

    // The collection is real and would match the reminder window, but it sits in the uncovered tail.
    const { gateway } = createStubGateway(
      restoredSchedule({
        events: [curbsideEvent('2026-03-10')],
        rangeCoverage: 'partial',
        displayRange: { from: '2026-03-01', to: '2026-03-05' },
      }),
    );

    const created = watchNotifications();

    await showReminder({ gateway, now: () => NOW });

    expect(created.mock.calls).toHaveLength(0);
  });

  it('produces no notification for an event-free uncovered tail', async () => {
    await withSelection();

    // A notification is unprompted and tells someone to act, so an absence outside the covered range must
    // never be read as nothing being scheduled — and must never be read as something being scheduled either.
    const { gateway } = createStubGateway(
      restoredSchedule({
        events: [],
        rangeCoverage: 'partial',
        displayRange: { from: '2026-03-01', to: '2026-03-05' },
      }),
    );

    const created = watchNotifications();

    await showReminder({ gateway, now: () => NOW });

    expect(created.mock.calls).toHaveLength(0);
  });

  it('notifies for a partially covered entry when the collection is inside the covered part', async () => {
    await withSelection();

    const { gateway } = createStubGateway(
      restoredSchedule({
        events: [curbsideEvent('2026-03-10'), curbsideEvent('2026-06-01')],
        rangeCoverage: 'partial',
        displayRange: { from: '2026-03-01', to: '2026-03-31' },
      }),
    );

    const created = watchNotifications();

    await showReminder({ gateway, now: () => NOW });

    expect(created.mock.calls).toHaveLength(1);
  });

  it('respects the visible waste types', async () => {
    await withSelection({ visibleWasteTypes: ['bio'] });

    const { gateway } = createStubGateway(
      restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
    );

    const created = watchNotifications();

    await showReminder({ gateway, now: () => NOW });

    expect(created.mock.calls).toHaveLength(0);
  });

  it('respects the configured lead time', async () => {
    await withSelection({ reminderDaysBefore: 3 });

    const { gateway } = createStubGateway(
      restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
    );

    const created = watchNotifications();

    await showReminder({ gateway, now: () => NOW });

    expect(created.mock.calls).toHaveLength(0);
  });

  it('announces one collection only once', async () => {
    await withSelection();

    const { gateway } = createStubGateway(
      restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
    );

    const created = watchNotifications();

    await showReminder({ gateway, now: () => NOW });
    await showReminder({ gateway, now: () => NOW });

    expect(created.mock.calls).toHaveLength(1);
  });

  it('names the same collection whichever order two same-day events arrive in', async () => {
    // More than one visible collection can fall on the reminder day. Taking the first match named whichever
    // waste type the response happened to list first, so two runs over the same data could announce different
    // things — and the popup could call a different one "next".
    await withSelection({ visibleWasteTypes: ['paper', 'bio'] });

    const paper = curbsideEvent('2026-03-10');
    const bio = curbsideEvent('2026-03-10', 'bio');

    const forward = createStubGateway(restoredSchedule({ events: [paper, bio] }));
    const created = watchNotifications();

    await showReminder({ gateway: forward.gateway, now: () => NOW });

    const firstTitle = optionsOf(created.mock.calls[0])?.title;

    created.mockClear();
    // The reminder announces one collection only once, so the record of it has to be cleared for the second run.
    await fakeBrowser.storage.local.remove('last-reminder');
    await withSelection({ visibleWasteTypes: ['paper', 'bio'] });

    const reversed = createStubGateway(restoredSchedule({ events: [bio, paper] }));

    await showReminder({ gateway: reversed.gateway, now: () => NOW });

    expect(optionsOf(created.mock.calls[0])?.title).toBe(firstTitle);
    // `bio` sorts before `paper`, so the order is the shared one rather than the arrival order.
    expect(firstTitle).toBe('Morgen: Biotonne');
  });

  it('reads the schedule through the gateway rather than any provider', async () => {
    await withSelection();

    const { gateway, restoreCachedSchedule } = createStubGateway(
      restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
    );

    await showReminder({ gateway, now: () => NOW });

    expect(restoreCachedSchedule).toHaveBeenCalledWith(SELECTION);
  });
});

/**
 * The reminder must work for someone who never opens the popup.
 *
 * The alarm fires in a worker with no UI attached, and the cache is populated by whichever surface last
 * fetched a schedule. Treating a missing, expired, evicted or short-covering cache as "nothing to say" made the
 * whole feature depend on the popup having been opened recently — so a person who simply installed the
 * extension and chose an area was reminded of nothing.
 *
 * Every test here drives the **real** gateway over a stub `fetch`, because the point is that the reminder
 * fetches through the same validated path the popup uses. A stubbed gateway would be asserting its own stub.
 */
describe('showReminder without a usable cache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ORIGIN = 'http://127.0.0.1:3000';

  /** The reminder runs the evening before the collection, in the source's zone. */
  const EVENING_BEFORE = new Date('2026-03-09T18:00:00.000Z');

  const PROVIDERS_BODY = {
    data: [
      { id: 'demo', name: 'Demo provider', sourceKind: 'demo' },
      { id: OFFICIAL_PROVIDER_ID, name: 'Kommunaler Servicebetrieb', sourceKind: 'official_ics' },
    ],
  };

  const areasBody = (collectionEvents: unknown) => ({
    data: [
      {
        id: OFFICIAL_AREA_ID,
        providerId: OFFICIAL_PROVIDER_ID,
        locality: 'Koblenz',
        name: 'Stadtmitte',
        collectionEvents,
      },
    ],
  });

  const AVAILABLE = {
    availability: 'available',
    timeZone: 'Europe/Berlin',
    validity: { from: '2026-01-01', to: '2026-12-31' },
  };

  /** The collection being reminded about: the day after the reminder runs, in the source's zone. */
  const eventsBody = (range: { from: string; to: string }, dates: readonly string[]) => ({
    data: dates.map((date) => ({
      id: `${OFFICIAL_PROVIDER_ID}-${OFFICIAL_AREA_ID}-paper-${date}`,
      serviceAreaId: OFFICIAL_AREA_ID,
      wasteType: 'paper',
      date,
      title: 'Altpapier',
      source: 'municipal_ics',
      collectionMode: 'curbside',
      timing: { kind: 'all_day' },
    })),
    meta: {
      provider: {
        id: OFFICIAL_PROVIDER_ID,
        name: 'Kommunaler Servicebetrieb',
        sourceKind: 'official_ics',
      },
      serviceArea: { id: OFFICIAL_AREA_ID, locality: 'Koblenz', name: 'Stadtmitte' },
      source: {
        name: 'Kommunaler Servicebetrieb',
        landingPageUrl:
          'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/',
        attribution: 'Kommunaler Servicebetrieb, Koblenz',
        timeZone: 'Europe/Berlin',
      },
      retrievedAt: '2026-03-09T17:00:00.000Z',
      validFrom: '2026-01-01',
      validTo: '2026-12-31',
      freshness: 'fresh',
      coverage: { wasteTypes: ['paper'] },
      range,
    },
  });

  interface ApiOptions {
    readonly capability?: unknown;
    readonly eventDates?: readonly string[];
    /** Fails every request, standing in for an unreachable API. */
    readonly offline?: boolean;
    /** A complete, successful catalogue whose contents the test decides. */
    readonly providers?: unknown;
    /** A complete, successful area list whose contents the test decides. */
    readonly areas?: unknown;
  }

  /**
   * A real gateway over a stub `fetch`, recording which endpoints were asked for.
   *
   * The counts are what prove the ordering rules: no area request without a confirmed provider, and no events
   * request without an available capability.
   */
  const gatewayOverHttp = ({
    capability = AVAILABLE,
    eventDates = ['2026-03-10'],
    offline = false,
    providers,
    areas,
  }: ApiOptions = {}) => {
    const requested: string[] = [];

    const client = createApiClient({
      baseUrl: ORIGIN,
      fetch: async (url) => {
        const path = url.slice(ORIGIN.length);

        if (path.includes('/collection-events')) {
          requested.push('collectionEvents');
        } else if (path.includes('/service-areas')) {
          requested.push('serviceAreas');
        } else {
          requested.push('providers');
        }

        if (offline) {
          throw new Error('the network is unavailable');
        }

        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });

        if (path.includes('/collection-events')) {
          const query = new URLSearchParams(path.slice(path.indexOf('?') + 1));

          return json(
            eventsBody({ from: query.get('from') ?? '', to: query.get('to') ?? '' }, eventDates),
          );
        }

        if (path.includes('/service-areas')) {
          return json(areas ?? areasBody(capability));
        }

        return json(providers ?? PROVIDERS_BODY);
      },
    });

    return {
      gateway: createGateway({ client, logger: { warn: () => {} }, now: () => EVENING_BEFORE }),
      requested,
      countOf: (endpoint: string) => requested.filter((entry) => entry === endpoint).length,
    };
  };

  it('fetches a schedule and notifies when nothing is cached at all', async () => {
    await withSelection();

    const { gateway, requested } = gatewayOverHttp();
    const created = watchNotifications();

    await showReminder({ gateway, now: () => EVENING_BEFORE });

    // All three reads happened, in order, and the reminder was produced without any popup involvement.
    expect(requested).toEqual(['providers', 'serviceAreas', 'collectionEvents']);
    expect(optionsOf(created.mock.calls[0])).toMatchObject({ title: 'Morgen: Altpapier' });
  });

  it('caches what it fetched, so the popup opens on a populated cache', async () => {
    await withSelection();

    const { gateway } = gatewayOverHttp();

    await showReminder({ gateway, now: () => EVENING_BEFORE });

    // The gateway owns the cache write; the reminder never touches storage itself.
    expect(await gateway.restoreCachedSchedule(SELECTION)).not.toBeNull();
  });

  it('refreshes when the cached entry has expired', async () => {
    await withSelection();

    // Stored well beyond the retention window, so the read evicts it before the reminder sees it.
    await writeCacheEntry({
      origin: ORIGIN,
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
      schedule: schedule({ events: [curbsideEvent('2026-03-10')] }),
      now: new Date('2026-01-01T09:00:00.000Z'),
    });

    const { gateway, countOf } = gatewayOverHttp();
    const created = watchNotifications();

    await showReminder({ gateway, now: () => EVENING_BEFORE });

    expect(countOf('collectionEvents')).toBe(1);
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the cached entry does not cover the reminder date', async () => {
    await withSelection();

    // A perfectly valid entry, served for a window that ends before the day being reminded about.
    await writeCacheEntry({
      origin: ORIGIN,
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
      schedule: schedule({ servedRange: { from: '2026-01-01', to: '2026-02-28' }, events: [] }),
      now: EVENING_BEFORE,
    });

    const { gateway, countOf } = gatewayOverHttp();
    const created = watchNotifications();

    await showReminder({ gateway, now: () => EVENING_BEFORE });

    expect(countOf('collectionEvents')).toBe(1);
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('notifies nothing when the refresh succeeds with no matching collection', async () => {
    await withSelection();

    const { gateway, countOf } = gatewayOverHttp({ eventDates: ['2026-04-20'] });
    const created = watchNotifications();

    await showReminder({ gateway, now: () => EVENING_BEFORE });

    // The refresh really happened; there is simply no collection on the day being reminded about.
    expect(countOf('collectionEvents')).toBe(1);
    expect(created).not.toHaveBeenCalled();
  });

  it('issues no area or events request for a provider the catalogue does not offer', async () => {
    await writeSettings({
      ...defaultSettings,
      selection: { providerId: 'gone-away', serviceAreaId: OFFICIAL_AREA_ID },
      visibleWasteTypes: ['paper'],
    });

    const { gateway, requested } = gatewayOverHttp();
    const created = watchNotifications();

    await showReminder({ gateway, now: () => EVENING_BEFORE });

    expect(requested).toEqual(['providers']);
    expect(created).not.toHaveBeenCalled();
  });

  it('issues no area or events request for a demo provider', async () => {
    // A reminder built from demo data is the most damaging possible form of presenting sample data as official.
    await writeSettings({
      ...defaultSettings,
      selection: { providerId: 'demo', serviceAreaId: OFFICIAL_AREA_ID },
      visibleWasteTypes: ['paper'],
    });

    const { gateway, requested } = gatewayOverHttp();
    const created = watchNotifications();

    await showReminder({ gateway, now: () => EVENING_BEFORE });

    expect(requested).toEqual(['providers']);
    expect(created).not.toHaveBeenCalled();
  });

  it('invalidates the cache and notifies nothing when the area is now unavailable', async () => {
    await withSelection();

    await writeCacheEntry({
      origin: ORIGIN,
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
      schedule: schedule({ servedRange: { from: '2026-01-01', to: '2026-02-28' }, events: [] }),
      now: EVENING_BEFORE,
    });

    const { gateway, countOf } = gatewayOverHttp({ capability: { availability: 'unavailable' } });
    const created = watchNotifications();

    await showReminder({ gateway, now: () => EVENING_BEFORE });

    // A withdrawn calendar must not keep answering through a cache, and no events request is issued for it.
    expect(countOf('collectionEvents')).toBe(0);
    expect(created).not.toHaveBeenCalled();
    expect(await gateway.restoreCachedSchedule(SELECTION)).toBeNull();
  });

  it('clears the persisted selection when the area is now unavailable', async () => {
    // The alarm may be the first thing to learn the calendar was withdrawn. Dropping only the cache left the
    // selection in place, so every later alarm repeated the whole discovery — and a person who never opens the
    // popup kept a stored area nothing can serve.
    await withSelection({ reminderTime: '17:00', visibleWasteTypes: ['paper'] });

    const { gateway } = gatewayOverHttp({ capability: { availability: 'unavailable' } });

    await showReminder({ gateway, now: () => EVENING_BEFORE });

    const settings = await readSettings();

    expect(settings.selection).toBeNull();
    // Only the selection was withdrawn.
    expect(settings.reminderTime).toBe('17:00');
    expect(settings.visibleWasteTypes).toEqual(['paper']);
  });

  it('does not clear a selection someone changed while the capability chain was running', async () => {
    await withSelection();

    const other = { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: 'koblenz-oberwerth' } as const;
    const { gateway, requested } = gatewayOverHttp({ capability: { availability: 'unavailable' } });
    const created = watchNotifications();

    /**
     * The choice lands while the reminder's chain is still in flight, so the answer is about somewhere else.
     *
     * Sequenced on the chain having actually started rather than on a bare microtask: the reminder's first act is a
     * queued settings read, and writing before that read observed the original selection would mean the reminder
     * was deciding about `other` all along — which tests nothing about compare-and-clear.
     */
    const reminder = showReminder({ gateway, now: () => EVENING_BEFORE });

    await vi.waitFor(() => {
      expect(requested).toContain('providers');
    });

    await writeSettings({ ...defaultSettings, selection: other, visibleWasteTypes: ['paper'] });
    await reminder;

    expect((await readSettings()).selection).toEqual(other);
    expect(created).not.toHaveBeenCalled();
  });

  it('produces no notification and no unhandled rejection when storage refuses the clear', async () => {
    await withSelection();

    const { gateway } = gatewayOverHttp({ capability: { availability: 'unavailable' } });
    const created = watchNotifications();

    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('storage unavailable'));

    // The authoritative fact holds whether or not storage cooperated, and the alarm handler must survive.
    await expect(showReminder({ gateway, now: () => EVENING_BEFORE })).resolves.toBeUndefined();

    expect(created).not.toHaveBeenCalled();
  });

  it('completes the invalidation on a later run once storage recovers', async () => {
    await withSelection();

    const failing = vi
      .spyOn(fakeBrowser.storage.local, 'set')
      .mockRejectedValue(new Error('storage unavailable'));

    await showReminder({
      gateway: gatewayOverHttp({ capability: { availability: 'unavailable' } }).gateway,
      now: () => EVENING_BEFORE,
    });

    // Still stored, because the write never landed.
    expect((await readSettings()).selection).toEqual(SELECTION);

    failing.mockRestore();

    await showReminder({
      gateway: gatewayOverHttp({ capability: { availability: 'unavailable' } }).gateway,
      now: () => EVENING_BEFORE,
    });

    expect((await readSettings()).selection).toBeNull();
  });

  it('notifies nothing when the API is unreachable and no usable cache exists', async () => {
    await withSelection();

    const { gateway } = gatewayOverHttp({ offline: true });
    const created = watchNotifications();

    // No unhandled rejection either: the alarm handler must survive a failed refresh.
    await expect(showReminder({ gateway, now: () => EVENING_BEFORE })).resolves.toBeUndefined();

    expect(created).not.toHaveBeenCalled();
  });

  it('performs no request at all with no selection stored', async () => {
    await writeSettings({ ...defaultSettings, selection: null });

    const { gateway, requested } = gatewayOverHttp();
    const created = watchNotifications();

    await showReminder({ gateway, now: () => EVENING_BEFORE });

    expect(requested).toEqual([]);
    expect(created).not.toHaveBeenCalled();
  });

  it('performs no request when the cache already covers the reminder date', async () => {
    await withSelection();

    // The fast path: a covering cache answers without touching the network at all.
    await writeCacheEntry({
      origin: ORIGIN,
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
      schedule: schedule({
        servedRange: { from: '2026-03-01', to: '2026-05-30' },
        events: [curbsideEvent('2026-03-10')],
      }),
      now: EVENING_BEFORE,
    });

    const { gateway, requested } = gatewayOverHttp();
    const created = watchNotifications();

    await showReminder({ gateway, now: () => EVENING_BEFORE });

    expect(requested).toEqual([]);
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('announces one collection only once across a cached and a refreshed run', async () => {
    await withSelection();

    const first = gatewayOverHttp();
    const created = watchNotifications();

    await showReminder({ gateway: first.gateway, now: () => EVENING_BEFORE });

    expect(created).toHaveBeenCalledTimes(1);

    // The second run finds the entry the first one cached, and the reminder was already shown.
    const second = gatewayOverHttp();

    await showReminder({ gateway: second.gateway, now: () => EVENING_BEFORE });

    expect(created).toHaveBeenCalledTimes(1);
    expect(second.requested).toEqual([]);
  });

  it('notifies nothing from a persisted entry whose events belong to another area', async () => {
    await withSelection();

    // Written raw, as an older build's leftovers would appear. The entry is evicted as inconsistent, and the
    // refresh below is what produces the reminder — never the contradictory record.
    await fakeBrowser.storage.local.set({
      'schedule-cache': {
        [`${ORIGIN}|${OFFICIAL_PROVIDER_ID}|${OFFICIAL_AREA_ID}`]: {
          origin: ORIGIN,
          providerId: OFFICIAL_PROVIDER_ID,
          serviceAreaId: OFFICIAL_AREA_ID,
          schedule: schedule({
            events: [curbsideEvent('2026-03-10', 'paper', 'koblenz-oberwerth')],
          }),
          storedAt: EVENING_BEFORE.toISOString(),
        },
      },
    });

    const { gateway, countOf } = gatewayOverHttp({ offline: true });
    const created = watchNotifications();

    await showReminder({ gateway, now: () => EVENING_BEFORE });

    // The contradictory entry produced nothing, and with the API unreachable there is nothing else to say.
    expect(created).not.toHaveBeenCalled();
    expect(countOf('providers')).toBe(1);
  });

  /**
   * Absence in a **successful** response is a conclusion, and all three forms of it are the same conclusion.
   *
   * An area reported `unavailable` was already withdrawing both the cache and the selection. A provider missing
   * from a successful catalogue and an area missing from a successful area list were not: they returned quietly,
   * leaving a stored selection nothing can serve and a cache that kept answering every later alarm from it —
   * indefinitely, for anyone who never opens the popup. These assert the three outcomes are now identical, and
   * that a *failed* request still infers nothing at all.
   */
  describe('learning that the selection is authoritatively unsupported', () => {
    /** A catalogue that offers somebody else. Complete, valid, and simply without the stored provider in it. */
    const WITHOUT_THE_PROVIDER = {
      data: [{ id: 'other-provider', name: 'Anderer Betrieb', sourceKind: 'official_ics' }],
    };

    /** An area list that is complete and simply does not contain the stored area. */
    const WITHOUT_THE_AREA = {
      data: [
        {
          id: 'koblenz-oberwerth',
          providerId: OFFICIAL_PROVIDER_ID,
          locality: 'Koblenz',
          name: 'Oberwerth',
          collectionEvents: AVAILABLE,
        },
      ],
    };

    /**
     * An entry that **restores** but holds no collection for the day being reminded about.
     *
     * Both halves are deliberate. It has to restore, or the eviction assertions would pass against a cache that
     * was never readable in the first place — a served range outside the derived window comes back as `null`
     * whether or not anything evicted it. And it has to have nothing due, or the cached fast path would produce
     * the reminder and the catalogue would never be reached.
     */
    const seedRestorableEmptyCache = async (): Promise<void> => {
      await writeCacheEntry({
        origin: ORIGIN,
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: OFFICIAL_AREA_ID,
        schedule: schedule({ events: [] }),
        now: EVENING_BEFORE,
      });
    };

    it('evicts the cache when a successful catalogue does not offer the stored provider', async () => {
      await withSelection();
      await seedRestorableEmptyCache();

      const { gateway } = gatewayOverHttp({ providers: WITHOUT_THE_PROVIDER });

      await showReminder({ gateway, now: () => EVENING_BEFORE });

      expect(await gateway.restoreCachedSchedule(SELECTION)).toBeNull();
    });

    it('clears the matching selection when a successful catalogue does not offer the stored provider', async () => {
      await withSelection({ reminderTime: '17:00', visibleWasteTypes: ['paper'] });

      const { gateway } = gatewayOverHttp({ providers: WITHOUT_THE_PROVIDER });

      await showReminder({ gateway, now: () => EVENING_BEFORE });

      const settings = await readSettings();

      expect(settings.selection).toBeNull();
      // Only the selection was withdrawn.
      expect(settings.reminderTime).toBe('17:00');
      expect(settings.visibleWasteTypes).toEqual(['paper']);
    });

    it('issues no area or events request for a provider a successful catalogue does not offer', async () => {
      await withSelection();
      await seedRestorableEmptyCache();

      const { gateway, countOf } = gatewayOverHttp({ providers: WITHOUT_THE_PROVIDER });
      const created = watchNotifications();

      await showReminder({ gateway, now: () => EVENING_BEFORE });

      expect(countOf('serviceAreas')).toBe(0);
      expect(countOf('collectionEvents')).toBe(0);
      expect(created).not.toHaveBeenCalled();
    });

    it('evicts the cache when a successful area list does not contain the stored area', async () => {
      await withSelection();
      await seedRestorableEmptyCache();

      const { gateway } = gatewayOverHttp({ areas: WITHOUT_THE_AREA });

      await showReminder({ gateway, now: () => EVENING_BEFORE });

      expect(await gateway.restoreCachedSchedule(SELECTION)).toBeNull();
    });

    it('clears the matching selection when a successful area list does not contain the stored area', async () => {
      await withSelection({ reminderTime: '17:00', visibleWasteTypes: ['paper'] });

      const { gateway } = gatewayOverHttp({ areas: WITHOUT_THE_AREA });

      await showReminder({ gateway, now: () => EVENING_BEFORE });

      const settings = await readSettings();

      expect(settings.selection).toBeNull();
      expect(settings.reminderTime).toBe('17:00');
      expect(settings.visibleWasteTypes).toEqual(['paper']);
    });

    it('issues no events request for an area a successful list does not contain', async () => {
      await withSelection();
      await seedRestorableEmptyCache();

      const { gateway, countOf } = gatewayOverHttp({ areas: WITHOUT_THE_AREA });
      const created = watchNotifications();

      await showReminder({ gateway, now: () => EVENING_BEFORE });

      expect(countOf('collectionEvents')).toBe(0);
      expect(created).not.toHaveBeenCalled();
    });

    it('withdraws an unavailable area through the same two effects as an absent one', async () => {
      // Stated as one assertion over both effects, so the three outcomes cannot drift apart again.
      await withSelection();
      await seedRestorableEmptyCache();

      const { gateway, countOf } = gatewayOverHttp({ capability: { availability: 'unavailable' } });
      const created = watchNotifications();

      await showReminder({ gateway, now: () => EVENING_BEFORE });

      expect(await gateway.restoreCachedSchedule(SELECTION)).toBeNull();
      expect((await readSettings()).selection).toBeNull();
      expect(countOf('collectionEvents')).toBe(0);
      expect(created).not.toHaveBeenCalled();
    });

    it('infers no absence at all when the catalogue request itself fails', async () => {
      /**
       * The difference that matters. An unreachable API says nothing about whether the provider is offered, so
       * inferring absence from it would throw away a working selection and a usable cache on the strength of a
       * network problem.
       */
      await withSelection();
      await seedRestorableEmptyCache();

      const { gateway } = gatewayOverHttp({ offline: true });
      const created = watchNotifications();

      await showReminder({ gateway, now: () => EVENING_BEFORE });

      expect((await readSettings()).selection).toEqual(SELECTION);
      expect(await gateway.restoreCachedSchedule(SELECTION)).not.toBeNull();
      expect(created).not.toHaveBeenCalled();
    });

    it('infers no absence when the area request fails after a successful catalogue', async () => {
      await withSelection();
      await seedRestorableEmptyCache();

      const { gateway } = gatewayOverHttp({ areas: { data: 'not a list' } });

      await showReminder({ gateway, now: () => EVENING_BEFORE });

      // The response could not be validated, so it is not a complete list and contains no conclusion.
      expect((await readSettings()).selection).toEqual(SELECTION);
      expect(await gateway.restoreCachedSchedule(SELECTION)).not.toBeNull();
    });

    it('does not clear a selection someone changed while the catalogue chain was running', async () => {
      await withSelection();

      const other = {
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: 'koblenz-oberwerth',
      } as const;
      const { gateway, requested } = gatewayOverHttp({ providers: WITHOUT_THE_PROVIDER });
      const created = watchNotifications();

      // Sequenced on the catalogue request, so the reminder really did read the original selection first.
      const reminder = showReminder({ gateway, now: () => EVENING_BEFORE });

      await vi.waitFor(() => {
        expect(requested).toContain('providers');
      });

      await writeSettings({ ...defaultSettings, selection: other, visibleWasteTypes: ['paper'] });
      await reminder;

      expect((await readSettings()).selection).toEqual(other);
      expect(created).not.toHaveBeenCalled();
    });

    it('produces no notification and no unhandled rejection when storage refuses both writes', async () => {
      await withSelection();
      await seedRestorableEmptyCache();

      const { gateway } = gatewayOverHttp({ providers: WITHOUT_THE_PROVIDER });
      const created = watchNotifications();

      vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(
        new Error('storage unavailable'),
      );

      // The authoritative fact holds whether or not storage cooperated, and the alarm handler must survive.
      await expect(showReminder({ gateway, now: () => EVENING_BEFORE })).resolves.toBeUndefined();

      expect(created).not.toHaveBeenCalled();
    });

    it('clears the selection even when the entry could not be evicted', async () => {
      /**
       * Eviction is best-effort, and the withdrawal must not be held hostage to it. The generation moved either
       * way, so nothing in flight can write or be delivered — and the area publishing nothing is true whether or
       * not storage cooperated. Keeping the selection would leave it pointing at an area the operator no longer
       * serves, with every later alarm rediscovering the same conclusion and never able to finish.
       *
       * The surviving entry is inert once the selection is gone: nothing asks for this area again.
       */
      await withSelection();
      await seedRestorableEmptyCache();

      const { gateway } = gatewayOverHttp({ providers: WITHOUT_THE_PROVIDER });
      const created = watchNotifications();

      /**
       * Refuses the **cache** write only, leaving the settings write working.
       *
       * Refusing everything would not discriminate: the compare-and-clear would fail for its own reasons and the
       * selection would survive whatever the ordering was. Failing one key is what makes this a test of the rule
       * rather than of storage being broken.
       */
      const store = fakeBrowser.storage.local;
      const write = store.set.bind(store);

      vi.spyOn(store, 'set').mockImplementation(async (items: Record<string, unknown>) => {
        if ('schedule-cache' in items) {
          throw new Error('storage unavailable');
        }

        return write(items);
      });

      await expect(showReminder({ gateway, now: () => EVENING_BEFORE })).resolves.toBeUndefined();

      vi.restoreAllMocks();

      // The choice is gone despite the refused eviction, so nothing points at the area any more.
      expect((await readSettings()).selection).toBeNull();
      expect(created).not.toHaveBeenCalled();
    });

    it('does not notify from an entry that survived a refused eviction', async () => {
      /**
       * What makes best-effort eviction safe, now in two independent ways. The removal was refused, so the entry
       * is still on disk — but the durable tombstone marks it withdrawn so no restore may return it, *and* the
       * selection was cleared so a reminder returns before it touches a cache at all. Either alone suffices.
       */
      await withSelection();
      await writeCacheEntry({
        origin: ORIGIN,
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: OFFICIAL_AREA_ID,
        // Would produce a notification if anything read it.
        schedule: schedule({ events: [curbsideEvent('2026-03-10')] }),
        now: EVENING_BEFORE,
      });

      const store = fakeBrowser.storage.local;
      const write = store.set.bind(store);

      vi.spyOn(store, 'set').mockImplementation(async (items: Record<string, unknown>) => {
        if ('schedule-cache' in items) {
          throw new Error('storage unavailable');
        }

        return write(items);
      });
      vi.spyOn(store, 'remove').mockRejectedValue(new Error('storage unavailable'));

      const first = gatewayOverHttp({ providers: WITHOUT_THE_PROVIDER });

      /**
       * The first run happens well before the cached collection, so the cache has nothing due and the catalogue is
       * reached. Running it on the evening before would have produced the notification from the cache and the
       * withdrawal would never have been discovered — which is the behaviour of the cache, not of this rule.
       */
      await showReminder({
        gateway: first.gateway,
        now: () => new Date('2026-03-01T18:00:00.000Z'),
      });

      vi.restoreAllMocks();

      /**
       * The selection is gone even though the entry is not — and the entry is no longer restorable either.
       *
       * Only the *cache* write was refused, so the durable tombstone was written, and a restore consults that
       * before it returns anything. The physical entry surviving is now housekeeping rather than a hazard.
       */
      expect((await readSettings()).selection).toBeNull();
      expect(await first.gateway.restoreCachedSchedule(SELECTION)).toBeNull();

      // A later alarm, with the API unreachable so only a cache could produce anything.
      const created = watchNotifications();
      const second = gatewayOverHttp({ offline: true });

      await showReminder({ gateway: second.gateway, now: () => EVENING_BEFORE });

      expect(created).not.toHaveBeenCalled();
      // It never even asked: no selection means no cache read.
      expect(second.countOf('providers')).toBe(0);
    });

    it('leaves no cache for a later alarm to be reminded from', async () => {
      /**
       * The point of evicting at all. The selection is cleared too, so this restores it before the second run —
       * otherwise the second alarm would stop at the selection check and prove nothing about the cache.
       *
       * The second run's API is unreachable, so the **only** thing that could produce a notification is the
       * cache. It produces none, because there is nothing left.
       */
      await withSelection();
      await writeCacheEntry({
        origin: ORIGIN,
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: OFFICIAL_AREA_ID,
        schedule: schedule({ events: [] }),
        now: EVENING_BEFORE,
      });

      const first = gatewayOverHttp({ providers: WITHOUT_THE_PROVIDER });

      await showReminder({ gateway: first.gateway, now: () => EVENING_BEFORE });

      await withSelection();

      const second = gatewayOverHttp({ offline: true });
      const created = watchNotifications();

      await showReminder({ gateway: second.gateway, now: () => EVENING_BEFORE });

      expect(await second.gateway.restoreCachedSchedule(SELECTION)).toBeNull();
      expect(created).not.toHaveBeenCalled();
    });
  });
});

/**
 * A reminder must never be assembled from settings nobody chose.
 *
 * A value written by a newer build is answered by the migration with *defaults*, which is correct for leaving the
 * stored object alone and exactly wrong as the basis for an unprompted notification: it would tell someone to act
 * on a lead time, a waste-type set and an area that came from this build's own defaults rather than from them.
 */
describe('showReminder with stored settings from a newer version', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const NEWER = {
    version: 99,
    selection: { providerId: OFFICIAL_PROVIDER_ID, serviceAreaId: OFFICIAL_AREA_ID },
    remindersEnabled: true,
    reminderDaysBefore: 1,
    reminderTime: '18:00',
    visibleWasteTypes: ['paper'],
    somethingNewer: true,
  } as const;

  it('shows nothing and reads no schedule at all', async () => {
    await fakeBrowser.storage.local.set({ settings: NEWER });

    const { gateway, restoreCachedSchedule, listProviders } = createStubGateway(
      restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
    );
    const created = watchNotifications();

    await showReminder({ gateway, now: () => NOW });

    // Not even the local cache restore: nothing about this stored value is this build's to act on.
    expect(restoreCachedSchedule).not.toHaveBeenCalled();
    expect(listProviders).not.toHaveBeenCalled();
    expect(created).not.toHaveBeenCalled();
  });

  it('writes nothing while refusing', async () => {
    await fakeBrowser.storage.local.set({ settings: NEWER });

    const writes = vi.spyOn(fakeBrowser.storage.local, 'set');
    const { gateway } = createStubGateway(null);

    await showReminder({ gateway, now: () => NOW });

    expect(writes).not.toHaveBeenCalled();
  });

  it('schedules no alarm from defaults a newer build did not choose', async () => {
    await fakeBrowser.storage.local.set({ settings: NEWER });

    await scheduleNextReminder();

    // Reminders are enabled in the newer value, but this build cannot read it — so no alarm is created from
    // whatever the defaults happen to say.
    expect(await fakeBrowser.alarms.get(REMINDER_ALARM)).toBeUndefined();
  });

  it('leaves the stored value untouched', async () => {
    await fakeBrowser.storage.local.set({ settings: NEWER });

    const { gateway } = createStubGateway(null);

    await showReminder({ gateway, now: () => NOW });
    await scheduleNextReminder();

    expect((await fakeBrowser.storage.local.get('settings')).settings).toEqual(NEWER);
  });
});

/**
 * A notification tells someone to do something, and the two collection modes are opposite things to do.
 *
 * Curbside waste is taken from the kerb, so the act is putting it out the evening before. A mobile drop-off is a
 * stand or a vehicle that is at a place for a bounded window, so the act is carrying the waste there in time —
 * nothing is collected from anyone's kerb. Every drop-off reminder used to carry the curbside sentence, telling
 * people to do the one thing that guarantees the waste is *not* collected.
 */
describe('the instruction a notification carries', () => {
  /**
   * Restored between cases, because `vi.spyOn` on an already-spied method hands back the *same* spy with its
   * earlier calls still on it — so without this a case would read the notification a previous case produced.
   */
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The one drop-off the fixtures publish: 10:00–12:00 UTC, which is 11:00–13:00 where the source lives. */
  const DROP_OFF = mobileDropOffEvent('2026-03-10');

  const notifiedFor = async (
    event: ReturnType<typeof curbsideEvent> | ReturnType<typeof mobileDropOffEvent>,
    visibleWasteTypes: (typeof defaultSettings)['visibleWasteTypes'],
  ): Promise<Record<string, unknown> | undefined> => {
    await withSelection({ visibleWasteTypes });

    const { gateway } = createStubGateway(restoredSchedule({ events: [event] }));
    const created = watchNotifications();

    await showReminder({ gateway, now: () => NOW });

    // Exactly one, so a case can never be reading a notification some other run produced.
    expect(created).toHaveBeenCalledTimes(1);

    return optionsOf(created.mock.calls[0]);
  };

  it('tells a curbside collection to be put out, exactly as before', async () => {
    const options = await notifiedFor(curbsideEvent('2026-03-10'), ['paper']);

    expect(options).toMatchObject({
      title: 'Morgen: Altpapier',
      message: CURBSIDE_REMINDER_MESSAGE,
    });
  });

  it('names the window and the place of a mobile drop-off', async () => {
    const options = await notifiedFor(DROP_OFF, ['hazardous']);

    expect(options?.message).toContain('Rizzastraße Ecke Südallee');
    expect(options?.message).toContain('11:00–13:00 (Europe/Berlin)');
  });

  it('still names the waste type of a mobile drop-off in its title', async () => {
    const options = await notifiedFor(DROP_OFF, ['hazardous']);

    expect(options).toMatchObject({ title: 'Morgen: Schadstoffe' });
  });

  it('carries no curbside instruction whatsoever in a mobile-drop-off notification', async () => {
    /**
     * The defect itself, asserted as an exact absence rather than as the presence of something better. A
     * drop-off reminder that also said "put it out this evening" would satisfy every other assertion here while
     * still telling someone to do the thing that loses their waste.
     */
    const options = await notifiedFor(DROP_OFF, ['hazardous']);
    const message = String(options?.message);

    expect(message).not.toBe(CURBSIDE_REMINDER_MESSAGE);
    expect(message).not.toContain(CURBSIDE_REMINDER_MESSAGE);
    // The instruction words themselves, so a reworded curbside sentence cannot slip back in either.
    expect(message).not.toContain('bereitstellen');
    expect(message).not.toContain('Heute Abend');
    // And it says the opposite: the waste has to be taken there.
    expect(message).toContain('Bitte selbst dorthin bringen.');
  });

  it('formats the window in the source zone rather than in UTC', async () => {
    // The fixture publishes 10:00–12:00 UTC. Rendering the instants raw would name an hour to travel by that is
    // an hour early for anyone reading it where the source is.
    const options = await notifiedFor(DROP_OFF, ['hazardous']);
    const message = String(options?.message);

    expect(message).toContain('11:00');
    expect(message).not.toContain('10:00');
  });
});

/**
 * The published window, formatted in the zone the operator declared.
 *
 * A drop-off is an appointment: the hour a person has to travel by is the source's local hour, and Berlin is one
 * offset in winter and another in summer. These pin both, and the malformed case pins what happens when the window
 * cannot be produced at all — which must be silence rather than the curbside sentence.
 */
describe('the window a mobile-drop-off notification states', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The drop-off, the reminder instant, and the visible types that make it due. */
  const messageFor = async (
    event: ReturnType<typeof mobileDropOffEvent>,
    at: Date,
  ): Promise<string | undefined> => {
    await withSelection({ visibleWasteTypes: ['hazardous', 'small_electronics'] });

    const { gateway } = createStubGateway(
      restoredSchedule({
        events: [event],
        servedRange: { from: '2026-01-01', to: '2026-12-31' },
        displayRange: { from: '2026-01-01', to: '2026-12-31' },
      }),
    );
    const created = watchNotifications();

    await showReminder({ gateway, now: () => at });

    if (created.mock.calls.length === 0) {
      return undefined;
    }

    const options = optionsOf(created.mock.calls[0]);

    return typeof options?.message === 'string' ? options.message : undefined;
  };

  /** A drop-off on a given date with an explicit UTC window, so the offset applied is observable. */
  const dropOffAt = (date: string, startsAt: string, endsAt: string) => ({
    ...mobileDropOffEvent(date),
    timing: { kind: 'time_window' as const, startsAt, endsAt, timeZone: 'Europe/Berlin' },
  });

  it('applies Berlin standard time in winter', async () => {
    // 09:00–11:00 UTC on a January day is 10:00–12:00 in Berlin, which is UTC+1.
    const message = await messageFor(
      dropOffAt('2026-01-20', '2026-01-20T09:00:00Z', '2026-01-20T11:00:00Z'),
      new Date('2026-01-19T18:00:00Z'),
    );

    expect(message).toContain('10:00–12:00 (Europe/Berlin)');
  });

  it('applies Berlin summer time in July', async () => {
    // The same instants in July are an hour later locally, because Berlin is UTC+2 then. A build that hardcoded
    // one offset, or formatted the raw instants, would produce the winter string here.
    const message = await messageFor(
      dropOffAt('2026-07-20', '2026-07-20T09:00:00Z', '2026-07-20T11:00:00Z'),
      new Date('2026-07-19T18:00:00Z'),
    );

    expect(message).toContain('11:00–13:00 (Europe/Berlin)');
  });

  it('states both ends of the window, not only its start', async () => {
    const message = await messageFor(
      dropOffAt('2026-01-20', '2026-01-20T09:00:00Z', '2026-01-20T11:00:00Z'),
      new Date('2026-01-19T18:00:00Z'),
    );

    expect(message).toContain('10:00');
    expect(message).toContain('12:00');
  });

  it('produces no notification from a schedule whose drop-off timing is unusable', async () => {
    /**
     * The outer guard. An unparsable instant fails domain validation, so the adapter refuses the whole schedule
     * one layer above the message builder — and the alarm handler has to survive that, because a rejection there
     * is invisible and would silently end the run.
     *
     * The message builder's own refusal is a separate branch with a separate reason, asserted directly below,
     * because no value can reach it through here: anything that formats badly is rejected by this guard first.
     */
    const unformattable = {
      ...mobileDropOffEvent('2026-01-20'),
      timing: {
        kind: 'time_window' as const,
        startsAt: 'not-an-instant',
        endsAt: '2026-01-20T11:00:00Z',
        timeZone: 'Europe/Berlin',
      },
    };

    await withSelection({ visibleWasteTypes: ['hazardous'] });

    const { gateway } = createStubGateway(
      restoredSchedule({
        events: [unformattable],
        servedRange: { from: '2026-01-01', to: '2026-12-31' },
        displayRange: { from: '2026-01-01', to: '2026-12-31' },
      }),
    );
    const created = watchNotifications();

    await expect(
      showReminder({ gateway, now: () => new Date('2026-01-19T18:00:00Z') }),
    ).resolves.toBeUndefined();

    expect(created).not.toHaveBeenCalled();
  });

  it('picks the same one of two drop-offs on the same day every time', async () => {
    /**
     * Hazardous waste and small electronics are collected at the same mobile stop, so two visible events can fall
     * on one day. The notification names one of them, and it must be the same one the popup calls next — decided
     * by the shared display order rather than by whichever the response happened to list first.
     */
    await withSelection({ visibleWasteTypes: ['hazardous', 'small_electronics'] });

    const hazardous = dropOffAt('2026-01-20', '2026-01-20T09:00:00Z', '2026-01-20T11:00:00Z');
    const electronics = {
      ...hazardous,
      id: `${hazardous.id}-electronics`,
      wasteType: 'small_electronics' as const,
    };

    const titles: (unknown | undefined)[] = [];

    for (const events of [
      [hazardous, electronics],
      [electronics, hazardous],
    ]) {
      fakeBrowser.reset();
      await withSelection({ visibleWasteTypes: ['hazardous', 'small_electronics'] });

      const { gateway } = createStubGateway(
        restoredSchedule({
          events,
          servedRange: { from: '2026-01-01', to: '2026-12-31' },
          displayRange: { from: '2026-01-01', to: '2026-12-31' },
        }),
      );
      const created = watchNotifications();

      await showReminder({ gateway, now: () => new Date('2026-01-19T18:00:00Z') });

      titles.push(optionsOf(created.mock.calls[0])?.title);
      created.mockRestore();
    }

    // Both orderings of the same two events name the same collection.
    expect(titles[0]).toBeDefined();
    expect(titles[0]).toBe(titles[1]);
  });
});

/**
 * The notification copy itself, at its own seam.
 *
 * `showReminder` cannot reach the refusal branch: every boundary an event crosses validates its instants and its
 * zone, so a schedule that gets as far as the message builder formats — and one that would not is refused by the
 * domain adapter first, which is a different guard with a different outcome. Asserting the branch here is what
 * makes it a tested decision rather than an untested precaution.
 */
describe('the message a notification carries, decided by collection mode', () => {
  const CURBSIDE: CollectionEvent = {
    id: 'koblenz-paper-2026-01-20',
    districtId: OFFICIAL_AREA_ID,
    type: 'paper',
    date: '2026-01-20',
    title: 'Altpapier',
    source: 'municipal_ics',
    collectionMode: 'curbside',
    timing: { kind: 'all_day' },
  };

  const DROP_OFF: CollectionEvent = {
    id: 'koblenz-hazardous-2026-01-20',
    districtId: OFFICIAL_AREA_ID,
    type: 'hazardous',
    date: '2026-01-20',
    title: 'Schadstoffe',
    source: 'municipal_ics',
    collectionMode: 'mobile_drop_off',
    timing: {
      kind: 'time_window',
      startsAt: '2026-01-20T09:00:00Z',
      endsAt: '2026-01-20T11:00:00Z',
      timeZone: 'Europe/Berlin',
    },
    location: { name: 'Rizzastraße Ecke Südallee' },
  };

  it('gives a curbside collection the existing sentence, unchanged', () => {
    expect(notificationMessageFor(CURBSIDE)).toBe(CURBSIDE_REMINDER_MESSAGE);
  });

  it('gives a drop-off its window, its place and appointment wording', () => {
    const message = notificationMessageFor(DROP_OFF);

    expect(message).toContain('10:00–12:00 (Europe/Berlin)');
    expect(message).toContain('Rizzastraße Ecke Südallee');
    expect(message).toContain('Mobile Annahmestelle');
    expect(message).toContain('Bitte selbst dorthin bringen.');
  });

  it('gives a drop-off nothing that tells anyone to put waste outside', () => {
    const message = String(notificationMessageFor(DROP_OFF));

    expect(message).not.toContain(CURBSIDE_REMINDER_MESSAGE);
    for (const curbsideWord of [
      'rausstellen',
      'Tonne raus',
      'bereitstellen',
      'Heute Abend',
      'draußen',
    ]) {
      expect(message).not.toContain(curbsideWord);
    }
  });

  it('refuses a drop-off whose window cannot be formatted, rather than falling back', () => {
    /**
     * The branch this seam exists for. Both alternatives are worse than silence: the curbside sentence tells
     * someone to put waste outside for a collection that never comes to them, and a drop-off message with the
     * window left out tells them to go somewhere without saying when.
     */
    const unformattable: CollectionEvent = {
      ...DROP_OFF,
      timing: { ...DROP_OFF.timing, kind: 'time_window', startsAt: 'not-an-instant' },
    } as CollectionEvent;

    expect(notificationMessageFor(unformattable)).toBeNull();
  });

  it('refuses a drop-off whose zone Intl cannot resolve', () => {
    const unresolvable: CollectionEvent = {
      ...DROP_OFF,
      timing: { ...DROP_OFF.timing, kind: 'time_window', timeZone: 'Not/AZone' },
    } as CollectionEvent;

    expect(notificationMessageFor(unresolvable)).toBeNull();
  });

  it('never omits the location or the window from a message it does return', () => {
    // The two members that make a drop-off actionable. A message missing either is not a shorter instruction, it
    // is an instruction nobody can follow, so the only allowed outcomes are "both" or "none".
    const message = notificationMessageFor(DROP_OFF);

    expect(message).not.toBeNull();
    expect(message).toContain(
      DROP_OFF.collectionMode === 'mobile_drop_off' ? DROP_OFF.location.name : '',
    );
    expect(message).toMatch(/\d{2}:\d{2}–\d{2}:\d{2}/);
  });
});
