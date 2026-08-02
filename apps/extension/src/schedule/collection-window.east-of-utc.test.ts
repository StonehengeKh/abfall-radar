/**
 * The formatted window must not depend on where the device is.
 *
 * This file pins the device **east** of the source; its sibling pins it west. Both assert the identical string for
 * the identical event, which is the property that matters: a drop-off is an appointment at a place, so the hour a
 * person travels by is the operator's, and two people reading the same notification in different countries must be
 * told the same time.
 *
 * Pinned before the module under test loads, which is why the imports below are dynamic.
 */
process.env.TZ = 'Asia/Tokyo';

// Marks this file as a module. Without it TypeScript treats a file whose every import is dynamic as a script,
// where top-level `await` is disallowed and top-level names collide with globals.
export {};

const { describe, expect, it } = await import('vitest');
const { formatCollectionWindow } = await import('./collection-window');
const { BERLIN_SUMMER_WINDOW, BERLIN_WINTER_WINDOW } = await import('./collection-window.fixture');

describe('a drop-off window formatted on a device east of the source', () => {
  it('runs on the pinned device zone, so the assertions are not vacuous', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Asia/Tokyo');
  });

  it('states Berlin standard time, not the device’s', () => {
    // Tokyo is UTC+9, so a device-zone rendering of these instants would say 18:00–20:00.
    expect(formatCollectionWindow(BERLIN_WINTER_WINDOW)).toBe('10:00–12:00 (Europe/Berlin)');
  });

  it('states Berlin summer time, not the device’s', () => {
    expect(formatCollectionWindow(BERLIN_SUMMER_WINDOW)).toBe('11:00–13:00 (Europe/Berlin)');
  });
});
