import type { CollectionWindow } from './collection-window';

/**
 * The two windows the device-zone tests share.
 *
 * Both sides of UTC assert the **same expected strings** for these, which is the whole point: the fixtures live
 * here so the two files cannot drift into testing slightly different events and concluding they agree.
 *
 * The instants are the same wall time in UTC across both, so the difference in the expected output comes purely
 * from Berlin's offset changing between winter and summer.
 */

/** 09:00–11:00 UTC in January, when Berlin is UTC+1. */
export const BERLIN_WINTER_WINDOW: CollectionWindow = {
  kind: 'time_window',
  startsAt: '2026-01-20T09:00:00Z',
  endsAt: '2026-01-20T11:00:00Z',
  timeZone: 'Europe/Berlin',
};

/** The same wall time in July, when Berlin is UTC+2. */
export const BERLIN_SUMMER_WINDOW: CollectionWindow = {
  kind: 'time_window',
  startsAt: '2026-07-20T09:00:00Z',
  endsAt: '2026-07-20T11:00:00Z',
  timeZone: 'Europe/Berlin',
};
