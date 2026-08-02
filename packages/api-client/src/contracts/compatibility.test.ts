import { describe, expect, it } from 'vitest';
import { CONTRACT_COMPATIBILITY_ASSERTIONS } from './compatibility';

/**
 * The compile-time assertions are the real check: `tsc --noEmit` fails when a validator stops matching
 * the type OpenAPI generated. This runtime test exists so the module is imported and evaluated rather
 * than sitting as unreferenced code that a bundler or a reader could mistake for dead, and so the list
 * of pinned contract members is visible in the test output.
 */

describe('the generated-contract compatibility assertions', () => {
  it('pins every response validator this client reads', () => {
    expect(Object.keys(CONTRACT_COMPATIBILITY_ASSERTIONS).toSorted()).toEqual([
      'collectionEventListResponseMatchesContract',
      'collectionEventsNotFoundProblemIsAccepted',
      'problemDetailsAcceptsEveryContractBody',
      'providerListResponseMatchesContract',
      'scheduleRangeNotCoveredProblemIsAccepted',
      'serviceAreaCapabilityMatchesContract',
      'serviceAreaListResponseMatchesContract',
      'upstreamSourceInvalidProblemIsAccepted',
      'upstreamSourceUnavailableProblemIsAccepted',
      'validationProblemIsAccepted',
    ]);
  });

  it('holds for every pinned member', () => {
    for (const [name, holds] of Object.entries(CONTRACT_COMPATIBILITY_ASSERTIONS)) {
      expect(holds, name).toBe(true);
    }
  });
});
