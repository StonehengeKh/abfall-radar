import { describe, expect, it } from 'vitest';
import { koblenzSummaryMapping } from './summary-mapping';

describe('the separately announced drop-off collections', () => {
  it.each([
    ['Schadstoffe', ['hazardous']],
    ['Elektrokleinteile', ['small_electronics']],
  ])('maps %s to its own waste type as a timed drop-off', (summary, wasteTypes) => {
    // Verified on 2026-09-16 in the operator's Rauental calendar, which publishes these as two timed
    // entries at one place rather than as the combined wording.
    const entry = koblenzSummaryMapping.get(summary);

    expect(entry?.wasteTypes).toEqual(wasteTypes);
    expect(entry?.timingKind).toBe('time_window');
    expect(entry?.collectionMode).toBe('mobile_drop_off');
  });

  it('keeps the combined wording announcing both collections', () => {
    const combined = koblenzSummaryMapping.get('Schadstoffe / Elektrokleinteile');

    expect(combined?.wasteTypes).toEqual(['hazardous', 'small_electronics']);
  });
});
