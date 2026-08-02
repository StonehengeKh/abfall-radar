import { describe, expect, it } from 'vitest';
import { ServiceAreaCapabilitySchema, SourceCalendarSchema } from './capability';
import { deriveTargetRange } from './schedule-range';
import { isUsableTimeZone, TimeZoneSchema } from './time-zone';

/**
 * The extension's own boundaries validate zones too, and for a reason the HTTP boundary cannot cover: a cache
 * entry written by an **older build** — one with no such check — passes back through these schemas on every
 * read. That is the one remaining path by which an unusable zone could reach the reminder.
 */

const REJECTED: readonly [string, string][] = [
  ['a zone no runtime knows', 'Not/AZone'],
  ['an empty string', ''],
  ['a single space', ' '],
  ['only whitespace', '   '],
  ['a padded real zone', ' Europe/Berlin '],
  ['a bare region', 'Europe/'],
  ['a plain word', 'Berlin'],
];

describe('isUsableTimeZone', () => {
  it('accepts Europe/Berlin and UTC', () => {
    expect(isUsableTimeZone('Europe/Berlin')).toBe(true);
    expect(isUsableTimeZone('UTC')).toBe(true);
  });

  it.each(REJECTED)('rejects %s', (_reason, value) => {
    expect(isUsableTimeZone(value)).toBe(false);
  });
});

describe('TimeZoneSchema', () => {
  it.each(REJECTED)('refuses %s', (_reason, value) => {
    expect(TimeZoneSchema.safeParse(value).success).toBe(false);
  });
});

describe('the source calendar', () => {
  const calendar = (timeZone: string) => ({
    timeZone,
    validity: { from: '2026-01-01', to: '2026-12-31' },
  });

  it('accepts a usable zone', () => {
    expect(SourceCalendarSchema.safeParse(calendar('Europe/Berlin')).success).toBe(true);
    expect(SourceCalendarSchema.safeParse(calendar('UTC')).success).toBe(true);
  });

  it.each(REJECTED)('refuses a calendar carrying %s', (_reason, value) => {
    expect(SourceCalendarSchema.safeParse(calendar(value)).success).toBe(false);
  });
});

describe('an available capability', () => {
  it.each(REJECTED)('refuses %s', (_reason, value) => {
    expect(
      ServiceAreaCapabilitySchema.safeParse({
        availability: 'available',
        timeZone: value,
        validity: { from: '2026-01-01', to: '2026-12-31' },
      }).success,
    ).toBe(false);
  });

  it('still accepts an unavailable capability, which carries no zone at all', () => {
    expect(ServiceAreaCapabilitySchema.safeParse({ availability: 'unavailable' }).success).toBe(
      true,
    );
  });
});

/**
 * Defense in depth, below the validators.
 *
 * Every boundary now refuses an unusable zone, so reaching the derivation with one is a defect — which is
 * exactly why it has to produce a *named outcome* rather than a throw. A throw here escaped into the caller's
 * effect, left the refresh phase pending, and showed a spinner that never resolved.
 */
describe('deriving a range from an unusable zone', () => {
  const NOW = new Date('2026-03-01T09:00:00.000Z');

  it('reports it rather than throwing', () => {
    expect(
      deriveTargetRange(
        { timeZone: 'Not/AZone', validity: { from: '2026-01-01', to: '2026-12-31' } },
        NOW,
      ),
    ).toEqual({ kind: 'unusable_zone' });
  });

  it('invents no calendar date to stand in for the one it could not derive', () => {
    const derived = deriveTargetRange(
      { timeZone: 'Not/AZone', validity: { from: '2026-01-01', to: '2026-12-31' } },
      NOW,
    );

    // Falling back to the device zone is the silent substitution that would put another zone's calendar date
    // on an official schedule, so there is deliberately no `today` and no `range` on this outcome.
    expect(derived).not.toHaveProperty('today');
    expect(derived).not.toHaveProperty('range');
  });

  it('still derives a covered range for a usable zone', () => {
    expect(
      deriveTargetRange(
        { timeZone: 'Europe/Berlin', validity: { from: '2026-01-01', to: '2026-12-31' } },
        NOW,
      ),
    ).toMatchObject({ kind: 'covered', today: '2026-03-01' });
  });
});
