/**
 * The device pinned **west** of the source. The sibling file pins it east.
 *
 * Both assert the identical string for the identical event, so the pair proves the formatted window is decided by
 * the source's declared zone and by nothing about the device. The malformed cases live here too, because they are
 * about the timing rather than about the device.
 */
process.env.TZ = 'America/Los_Angeles';

// Marks this file as a module. Without it TypeScript treats a file whose every import is dynamic as a script,
// where top-level `await` is disallowed and top-level names collide with globals.
export {};

const { describe, expect, it } = await import('vitest');
const { formatCollectionWindow } = await import('./collection-window');
const { BERLIN_SUMMER_WINDOW, BERLIN_WINTER_WINDOW } = await import('./collection-window.fixture');

describe('a drop-off window formatted on a device west of the source', () => {
  it('runs on the pinned device zone, so the assertions are not vacuous', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/Los_Angeles');
  });

  it('states Berlin standard time, not the device’s', () => {
    // Los Angeles is UTC-8 in January, so a device-zone rendering would say 01:00–03:00.
    expect(formatCollectionWindow(BERLIN_WINTER_WINDOW)).toBe('10:00–12:00 (Europe/Berlin)');
  });

  it('states Berlin summer time, not the device’s', () => {
    expect(formatCollectionWindow(BERLIN_SUMMER_WINDOW)).toBe('11:00–13:00 (Europe/Berlin)');
  });
});

describe('a window that cannot be formatted', () => {
  it('reports it rather than throwing, for an unparsable start', () => {
    expect(
      formatCollectionWindow({ ...BERLIN_WINTER_WINDOW, startsAt: 'not-an-instant' }),
    ).toBeNull();
  });

  it('reports it rather than throwing, for an unparsable end', () => {
    expect(formatCollectionWindow({ ...BERLIN_WINTER_WINDOW, endsAt: '' })).toBeNull();
  });

  it('reports it rather than throwing, for a zone Intl refuses', () => {
    // Every boundary validates the zone, so this is a defect path — and a defect must not throw into a React
    // render on one side or an alarm handler on the other.
    expect(formatCollectionWindow({ ...BERLIN_WINTER_WINDOW, timeZone: 'Not/AZone' })).toBeNull();
  });

  it('is refused rather than allowed to throw, which is what the raw formatter does', () => {
    /**
     * Stated as a comparison with the unguarded call, so the value of the guard is visible: `Intl.format` raises a
     * `RangeError` on an invalid instant. Unguarded, that would escape into a React render on one surface and into
     * an alarm handler on the other — where a rejection is invisible and silently ends the run.
     */
    const unformattable = { ...BERLIN_WINTER_WINDOW, startsAt: 'not-an-instant' };
    const raw = new Intl.DateTimeFormat('de-DE', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: unformattable.timeZone,
    });

    expect(() => raw.format(new Date(unformattable.startsAt))).toThrow(RangeError);
    expect(formatCollectionWindow(unformattable)).toBeNull();
  });
});
