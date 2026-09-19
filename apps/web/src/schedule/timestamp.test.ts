import { describe, expect, it } from 'vitest';
import { compareTimestamps } from '@/src/schedule/timestamp';

const order = (left: string, right: string) => compareTimestamps(left, right);

describe('compareTimestamps', () => {
  it('treats minute, second, and fractional-zero precision as the same instant', () => {
    expect(order('2026-11-07T10:00Z', '2026-11-07T10:00:00Z')).toEqual({ ok: true, order: 0 });
    expect(order('2026-11-07T10:00:00Z', '2026-11-07T10:00:00.000Z')).toEqual({
      ok: true,
      order: 0,
    });
  });

  it('treats .1, .10, and .100 as equal fractional values', () => {
    expect(order('2026-11-07T10:00:00.1Z', '2026-11-07T10:00:00.10Z')).toEqual({
      ok: true,
      order: 0,
    });
    expect(order('2026-11-07T10:00:00.10Z', '2026-11-07T10:00:00.100Z')).toEqual({
      ok: true,
      order: 0,
    });
  });

  it('distinguishes sub-millisecond differences that Date.parse would truncate', () => {
    expect(Date.parse('2026-11-07T10:00:00.0001Z')).toBe(Date.parse('2026-11-07T10:00:00.0002Z'));
    expect(order('2026-11-07T10:00:00.0001Z', '2026-11-07T10:00:00.0002Z')).toEqual({
      ok: true,
      order: -1,
    });
  });

  it('orders .500Z after the whole second, where lexical comparison fails', () => {
    expect('2026-11-07T10:00:00.500Z' < '2026-11-07T10:00:00Z').toBe(true);
    expect(order('2026-11-07T10:00:00.500Z', '2026-11-07T10:00:00Z')).toEqual({
      ok: true,
      order: 1,
    });
  });

  it('places minute precision before a later sub-millisecond instant', () => {
    expect(order('2026-11-07T10:00Z', '2026-11-07T10:00:00.0001Z')).toEqual({
      ok: true,
      order: -1,
    });
  });

  it('returns a failure for an unvalidated string rather than a sort position', () => {
    expect(order('not-a-time', '2026-11-07T10:00:00Z')).toEqual({ ok: false });
  });
});
