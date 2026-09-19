import { describe, expect, it } from 'vitest';
import { deriveTargetRange } from '@/src/schedule/schedule-range';

const validity = { from: '2026-01-01', to: '2026-12-31' };

describe('deriveTargetRange', () => {
  it('requests 90 calendar days forward when fully inside validity', () => {
    expect(deriveTargetRange('2026-03-01', validity)).toEqual({
      kind: 'requestable',
      range: { from: '2026-03-01', to: '2026-05-30' },
    });
  });

  it('clamps the end to validity.to', () => {
    expect(deriveTargetRange('2026-12-01', validity)).toEqual({
      kind: 'requestable',
      range: { from: '2026-12-01', to: '2026-12-31' },
    });
  });

  it('clamps the start to validity.from', () => {
    expect(deriveTargetRange('2025-12-20', validity)).toEqual({
      kind: 'requestable',
      range: { from: '2026-01-01', to: '2026-03-20' },
    });
  });

  it('issues no request once source-local today is past validity.to', () => {
    expect(deriveTargetRange('2027-01-01', validity)).toEqual({ kind: 'past_validity' });
  });

  it('reports an inverted clamp as no intersection', () => {
    expect(deriveTargetRange('2025-06-01', validity)).toEqual({ kind: 'no_intersection' });
  });

  it('can produce identical bounds on two consecutive source days, so bounds never stand in for the date', () => {
    const shortValidity = { from: '2026-01-01', to: '2026-01-15' };
    const monday = deriveTargetRange('2025-12-10', shortValidity);
    const tuesday = deriveTargetRange('2025-12-11', shortValidity);

    expect(monday).toEqual({
      kind: 'requestable',
      range: { from: '2026-01-01', to: '2026-01-15' },
    });
    expect(tuesday).toEqual(monday);
  });
});
