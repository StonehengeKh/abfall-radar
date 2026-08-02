/**
 * A reminder must name the day the **municipal source** means, not the day the device is on.
 *
 * The device zone is pinned before the module under test loads, and every case below is one where the device
 * and the source disagree about today's date. A notification is unprompted and tells someone to act, so
 * naming the wrong day is worse than saying nothing.
 *
 * Each case also asserts that the device really is on the other date, so a runtime that ignored the pinned
 * zone could not make these pass for the wrong reason.
 */
process.env.TZ = 'America/New_York';

// Marks this file as a module. Without it TypeScript treats a file whose every import is dynamic as a script,
// where top-level `await` is disallowed and top-level names collide with globals.
export {};

const { afterEach, describe, expect, it, vi } = await import('vitest');
const { fakeBrowser } = await import('wxt/testing');
const { defaultSettings } = await import('@/src/storage/settings');
const { writeSettings } = await import('@/src/storage/settings-repository');
const {
  curbsideEvent,
  mobileDropOffEvent,
  OFFICIAL_AREA_ID,
  OFFICIAL_PROVIDER_ID,
  restoredSchedule,
} = await import('@/src/test/fixtures');
const { showReminder } = await import('./reminder');

type Gateway = Awaited<ReturnType<typeof import('./gateway')['createGateway']>>;

const SELECTION = {
  providerId: OFFICIAL_PROVIDER_ID,
  serviceAreaId: OFFICIAL_AREA_ID,
} as const;

/** The API reads fail, so every case here is decided by the cache alone — which is what these tests are about. */
const gatewayFor = (restored: ReturnType<typeof restoredSchedule> | null) => {
  const unreachable = { ok: false, failure: { kind: 'network', operation: 'listProviders' } };

  return {
    handle: vi.fn(),
    listProviders: vi.fn().mockResolvedValue(unreachable),
    listServiceAreas: vi.fn().mockResolvedValue(unreachable),
    listCollectionEvents: vi.fn().mockResolvedValue(unreachable),
    restoreCachedSchedule: vi.fn().mockResolvedValue(restored),
    invalidateCachedSchedule: vi.fn().mockResolvedValue(undefined),
  } as unknown as Gateway;
};

const withSelection = async (overrides: Partial<typeof defaultSettings> = {}): Promise<void> => {
  await writeSettings({
    ...defaultSettings,
    selection: SELECTION,
    visibleWasteTypes: ['paper'],
    ...overrides,
  });
};

const watchNotifications = () => vi.spyOn(fakeBrowser.notifications, 'create');

/** A wide covered range, so only the date decision is under test. */
const covering = (events: ReturnType<typeof curbsideEvent>[]) =>
  restoredSchedule({
    events,
    servedRange: { from: '2026-01-01', to: '2026-12-31' },
    displayRange: { from: '2026-01-01', to: '2026-12-31' },
  });

describe('the reminder calendar date', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs with the device west of the source, so the assertions are not vacuous', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/New_York');
  });

  it('uses the source date when Berlin is already on the next day', async () => {
    // 2026-03-01T23:30Z is 2026-03-02 in Berlin but still 2026-03-01 in New York. With one day's lead, the
    // collection being reminded about is on the 3rd — a device-zone derivation would pick the 2nd.
    const instant = new Date('2026-03-01T23:30:00Z');

    expect(new Date(instant).getDate()).toBe(1);

    await withSelection({ reminderDaysBefore: 1 });

    const created = watchNotifications();

    await showReminder({
      gateway: gatewayFor(covering([curbsideEvent('2026-03-03')])),
      now: () => instant,
    });

    expect(created.mock.calls).toHaveLength(1);
  });

  it('does not remind about the device’s day when the source has already moved on', async () => {
    const instant = new Date('2026-03-01T23:30:00Z');

    await withSelection({ reminderDaysBefore: 1 });

    const created = watchNotifications();

    // The 2nd is what the device zone would have chosen.
    await showReminder({
      gateway: gatewayFor(covering([curbsideEvent('2026-03-02')])),
      now: () => instant,
    });

    expect(created.mock.calls).toHaveLength(0);
  });

  it('uses the source date when the device is a day ahead of the source', async () => {
    // 2026-03-01T22:00Z is already 2026-03-02 in Tokyo while Berlin is still on 2026-03-01. The source day
    // wins, so a one-day lead points at the 2nd.
    process.env.TZ = 'Asia/Tokyo';

    const instant = new Date('2026-03-01T22:00:00Z');

    await withSelection({ reminderDaysBefore: 1 });

    const created = watchNotifications();

    await showReminder({
      gateway: gatewayFor(covering([curbsideEvent('2026-03-02')])),
      now: () => instant,
    });

    expect(created.mock.calls).toHaveLength(1);

    process.env.TZ = 'America/New_York';
  });

  it('derives the correct day across a Berlin daylight-saving transition', async () => {
    // Berlin springs forward on 2026-03-29. At 01:30Z that day it is 03:30 local, still the 29th, so a
    // one-day lead points at the 30th.
    const instant = new Date('2026-03-29T01:30:00Z');

    await withSelection({ reminderDaysBefore: 1 });

    const created = watchNotifications();

    await showReminder({
      gateway: gatewayFor(covering([curbsideEvent('2026-03-30')])),
      now: () => instant,
    });

    expect(created.mock.calls).toHaveLength(1);
  });

  it('does not shift the day across the transition', async () => {
    const instant = new Date('2026-03-29T01:30:00Z');

    await withSelection({ reminderDaysBefore: 1 });

    const created = watchNotifications();

    await showReminder({
      gateway: gatewayFor(covering([curbsideEvent('2026-03-29')])),
      now: () => instant,
    });

    expect(created.mock.calls).toHaveLength(0);
  });

  it.each([
    [0, '2026-03-02'],
    [1, '2026-03-03'],
    [3, '2026-03-05'],
    [7, '2026-03-09'],
  ])('applies a lead of %i days as calendar arithmetic', async (reminderDaysBefore, date) => {
    // Source-local today is 2026-03-02 at this instant.
    const instant = new Date('2026-03-01T23:30:00Z');

    await withSelection({ reminderDaysBefore });

    const created = watchNotifications();

    await showReminder({
      gateway: gatewayFor(covering([curbsideEvent(date)])),
      now: () => instant,
    });

    expect(created.mock.calls).toHaveLength(1);
  });

  it('shows nothing when the day being reminded about lies outside the covered range', async () => {
    // The lead points past the end of what the cache covers, so there is no data for that day at all. An
    // absence there says nothing and must never be read as nothing being scheduled.
    const instant = new Date('2026-03-01T23:30:00Z');

    await withSelection({ reminderDaysBefore: 1 });

    const created = watchNotifications();

    await showReminder({
      gateway: gatewayFor(
        restoredSchedule({
          events: [curbsideEvent('2026-03-03')],
          servedRange: { from: '2026-01-01', to: '2026-03-02' },
          displayRange: { from: '2026-01-01', to: '2026-03-02' },
          rangeCoverage: 'partial',
        }),
      ),
      now: () => instant,
    });

    expect(created.mock.calls).toHaveLength(0);
  });

  it('notifies when both the day and the event sit inside the covered range', async () => {
    const instant = new Date('2026-03-01T23:30:00Z');

    await withSelection({ reminderDaysBefore: 1 });

    const created = watchNotifications();

    await showReminder({
      gateway: gatewayFor(
        restoredSchedule({
          events: [curbsideEvent('2026-03-03')],
          servedRange: { from: '2026-01-01', to: '2026-12-31' },
          displayRange: { from: '2026-01-01', to: '2026-03-03' },
          rangeCoverage: 'partial',
        }),
      ),
      now: () => instant,
    });

    // The mirror of the case above: the intersection reaches exactly far enough, so this one does notify.
    expect(created.mock.calls).toHaveLength(1);
  });

  it('announces one collection only once', async () => {
    const instant = new Date('2026-03-01T23:30:00Z');

    await withSelection({ reminderDaysBefore: 1 });

    const created = watchNotifications();
    const gateway = gatewayFor(covering([curbsideEvent('2026-03-03')]));

    await showReminder({ gateway, now: () => instant });
    await showReminder({ gateway, now: () => instant });

    expect(created.mock.calls).toHaveLength(1);
  });

  it('respects the visible waste types', async () => {
    const instant = new Date('2026-03-01T23:30:00Z');

    await withSelection({ reminderDaysBefore: 1, visibleWasteTypes: ['bio'] });

    const created = watchNotifications();

    await showReminder({
      gateway: gatewayFor(covering([curbsideEvent('2026-03-03')])),
      now: () => instant,
    });

    expect(created.mock.calls).toHaveLength(0);
  });
});

/**
 * A drop-off window is an appointment at a place, so the hour a person has to travel by is the **source's**.
 *
 * Pinned west of the source, where the two disagree by an hour: rendering the published instants in the device
 * zone would name a time five hours early for anyone reading it where the collection actually happens.
 */
describe('the drop-off window in a notification', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('states the source-local window, not the device-local one', async () => {
    // The fixture publishes 10:00–12:00 UTC, which is 11:00–13:00 in Berlin and 05:00–07:00 in New York.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/New_York');

    await withSelection({ reminderDaysBefore: 1, visibleWasteTypes: ['hazardous'] });

    const created = watchNotifications();

    await showReminder({
      gateway: gatewayFor(
        restoredSchedule({
          events: [mobileDropOffEvent('2026-03-10')],
          servedRange: { from: '2026-01-01', to: '2026-12-31' },
          displayRange: { from: '2026-01-01', to: '2026-12-31' },
        }),
      ),
      now: () => new Date('2026-03-09T18:00:00Z'),
    });

    expect(created.mock.calls).toHaveLength(1);

    const options = created.mock.calls[0]?.find(
      (argument) => typeof argument === 'object' && argument !== null,
    ) as { readonly message?: string } | undefined;

    expect(options?.message).toContain('11:00–13:00 (Europe/Berlin)');
    // The device-local rendering of the same instants, which must not appear.
    expect(options?.message).not.toContain('05:00');
  });
});
