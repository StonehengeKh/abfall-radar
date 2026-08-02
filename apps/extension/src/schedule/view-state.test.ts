import { describe, expect, it } from 'vitest';
import { curbsideEvent, mobileDropOffEvent, restoredSchedule, schedule } from '@/src/test/fixtures';
import { deriveScheduleView } from './view-state';

/**
 * A schedule that cannot be mapped onto the domain must become a stated error, never an exception.
 *
 * This derivation runs **during React rendering**, where a throw takes the whole popup down with no error
 * boundary to catch it. Every boundary above now enforces what the domain requires, so this should be
 * unreachable — which is exactly why it has to degrade rather than crash if a defect ever makes it reachable.
 */
describe('a schedule the domain refuses', () => {
  /**
   * A drop-off whose window is inverted.
   *
   * The domain refuses it, the transport and the persisted-cache validator both refuse it, so constructing one
   * here means bypassing all three — which is the only way to reach the branch under test.
   */
  const inverted = {
    ...mobileDropOffEvent('2026-03-21'),
    timing: {
      kind: 'time_window' as const,
      startsAt: '2026-03-21T12:00:00Z',
      endsAt: '2026-03-21T10:00:00Z',
      timeZone: 'Europe/Berlin',
    },
  };

  it('reports a live response as unusable rather than throwing', () => {
    const view = deriveScheduleView({
      hasSelection: true,
      phase: { kind: 'succeeded', schedule: schedule({ events: [inverted] }) },
    });

    expect(view).toEqual({
      kind: 'error',
      failure: { kind: 'invalid_response', operation: 'listCollectionEvents', status: 0 },
    });
  });

  it('reports a restored cache as unusable rather than throwing', () => {
    const view = deriveScheduleView({
      hasSelection: true,
      restored: restoredSchedule({ events: [inverted] }),
      phase: { kind: 'failed', failure: { kind: 'network', operation: 'listCollectionEvents' } },
    });

    expect(view.kind).toBe('error');
  });

  it('reports a retained-newer cache as unusable rather than throwing', () => {
    const view = deriveScheduleView({
      hasSelection: true,
      phase: {
        kind: 'retained_newer_cache',
        restored: restoredSchedule({ events: [inverted] }),
      },
    });

    expect(view.kind).toBe('error');
  });

  it('still derives an ordinary view for a schedule the domain accepts', () => {
    // The mirror image, so the three above cannot pass by everything becoming an error.
    const view = deriveScheduleView({
      hasSelection: true,
      phase: { kind: 'succeeded', schedule: schedule({ events: [curbsideEvent('2026-03-10')] }) },
    });

    expect(view.kind).toBe('live');
  });
});
