import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { deriveScheduleView } from '@/src/schedule/view-state';
import { curbsideEvent, mobileDropOffEvent, restoredSchedule, schedule } from '@/src/test/fixtures';
import { DashboardView } from './dashboard-view';

const referenceDate = new Date('2026-03-09T10:00:00Z');

const ALL_VISIBLE = ['paper', 'hazardous', 'bio'] as const;

const renderView = (
  view: Parameters<typeof DashboardView>[0]['view'],
  visibleWasteTypes: readonly ('paper' | 'hazardous' | 'bio')[] = ALL_VISIBLE,
) => {
  const onOpenSettings = vi.fn();
  const onRetry = vi.fn();

  const result = render(
    <DashboardView
      view={view}
      visibleWasteTypes={[...visibleWasteTypes]}
      onOpenSettings={onOpenSettings}
      onRetry={onRetry}
      referenceDate={referenceDate}
    />,
  );

  return { ...result, onOpenSettings, onRetry };
};

const liveView = (options: Parameters<typeof schedule>[0] = {}) =>
  deriveScheduleView({
    hasSelection: true,
    phase: { kind: 'succeeded', schedule: schedule(options) },
  });

const cachedView = (options: Parameters<typeof restoredSchedule>[0] = {}, offline = true) =>
  deriveScheduleView({
    hasSelection: true,
    restored: restoredSchedule(options),
    phase: {
      kind: 'failed',
      failure: offline
        ? { kind: 'network', operation: 'listCollectionEvents' }
        : { kind: 'invalid_response', operation: 'listCollectionEvents', status: 500 },
    },
  });

describe('DashboardView provenance', () => {
  it('shows the source, its attribution link, and the retrieval time', () => {
    renderView(liveView({ events: [curbsideEvent('2026-03-10')] }));

    expect(screen.getByText('Kommunaler Servicebetrieb')).toBeInTheDocument();
    expect(screen.getByText('Kommunaler Servicebetrieb, Koblenz')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Offizielle Seite des Betriebs/ })).toHaveAttribute(
      'href',
      'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/',
    );
    expect(screen.getByText(/Aktuell abgerufen am/)).toBeInTheDocument();
  });

  it('shows the area under its official naming', () => {
    renderView(liveView());

    expect(screen.getByText('Koblenz · Stadtmitte')).toBeInTheDocument();
  });

  it('names the waste types the source does not publish, separately from an empty result', () => {
    // A selected waste type outside the declared coverage is "this source does not publish it", which is a
    // different statement from "no collection in this period".
    renderView(liveView({ events: [curbsideEvent('2026-03-10')], coverage: ['paper'] }), [
      'paper',
      'bio',
    ]);

    expect(screen.getByText(/veröffentlicht keine Termine für/)).toHaveTextContent('Biotonne');
  });

  it('does not claim an unpublished waste type when the source covers everything selected', () => {
    renderView(liveView({ events: [curbsideEvent('2026-03-10')] }), ['paper']);

    expect(screen.queryByText(/veröffentlicht keine Termine für/)).not.toBeInTheDocument();
  });
});

describe('DashboardView event variants', () => {
  it('shows the window, the zone, and the location of a mobile drop-off', () => {
    renderView(liveView({ events: [mobileDropOffEvent('2026-03-10')] }));

    expect(screen.getByText(/Europe\/Berlin/)).toBeInTheDocument();
    expect(screen.getByText('Rizzastraße Ecke Südallee')).toBeInTheDocument();
  });

  it('shows neither a window nor a location for a curbside collection', () => {
    renderView(liveView({ events: [curbsideEvent('2026-03-10')] }));

    expect(screen.queryByText(/Europe\/Berlin/)).not.toBeInTheDocument();
    expect(screen.queryByText('Rizzastraße Ecke Südallee')).not.toBeInTheDocument();
  });

  it('shows the next collection and its relative label', () => {
    renderView(liveView({ events: [curbsideEvent('2026-03-10')] }));

    expect(screen.getByText('Morgen')).toBeInTheDocument();
    expect(screen.getByText('Altpapier')).toBeInTheDocument();
  });
});

/**
 * A drop-off further down the list is no less something a person has to attend.
 *
 * The reported defect: only the hero event rendered the window, the zone, and the place, so a drop-off in the
 * "Danach" list appeared as a waste type and a relative day. That row reads as complete while withholding both
 * things needed to act on it — when to be there and where to go — which is worse than omitting it, because
 * nothing signals that anything is missing.
 *
 * Asserted through the rendered later-event row rather than through the shared renderer in isolation, because
 * a helper that is never reached from that branch passes its own test and changes nothing on screen.
 */
describe('DashboardView later mobile drop-off events', () => {
  /** Curbside first so the drop-off is genuinely in the later list, not the hero. */
  const firstCurbsideThenDropOff = () =>
    liveView({ events: [curbsideEvent('2026-03-10'), mobileDropOffEvent('2026-03-21')] });

  /** The list section the later events are rendered into. */
  const laterSection = (): HTMLElement => {
    const heading = screen.getByRole('heading', { name: 'Danach' });
    const section = heading.closest('section');

    if (section === null) {
      throw new Error('The later-events heading is expected to sit inside a section.');
    }

    return section;
  };

  it('puts the curbside event in the hero and the drop-off in the later list', () => {
    renderView(firstCurbsideThenDropOff());

    // The premise of every assertion below. Without it they could all pass against the hero event.
    expect(screen.getByText('Altpapier')).toBeInTheDocument();
    expect(laterSection()).toHaveTextContent('Schadstoffe');
  });

  it('shows the window of a later drop-off', () => {
    renderView(firstCurbsideThenDropOff());

    // 10:00–12:00 UTC rendered in the source's zone, which is 11:00–13:00 in Berlin in March.
    expect(laterSection()).toHaveTextContent('11:00–13:00');
  });

  it('shows the declared time zone of a later drop-off', () => {
    renderView(firstCurbsideThenDropOff());

    // A time without its zone is not actionable, so the zone travels with the window.
    expect(laterSection()).toHaveTextContent('Europe/Berlin');
  });

  it('shows the location of a later drop-off', () => {
    renderView(firstCurbsideThenDropOff());

    expect(laterSection()).toHaveTextContent('Rizzastraße Ecke Südallee');
  });

  it('shows no window, zone, or location for a later curbside collection', () => {
    // Curbside has nowhere to go and no window to keep, so inventing either would state a constraint the
    // source never published.
    renderView(
      liveView({ events: [curbsideEvent('2026-03-10'), curbsideEvent('2026-03-24', 'bio')] }),
    );

    const section = laterSection();

    expect(section).not.toHaveTextContent('Europe/Berlin');
    expect(section).not.toHaveTextContent('Rizzastraße Ecke Südallee');
    expect(section).not.toHaveTextContent(/\d{2}:\d{2}–\d{2}:\d{2}/);
  });

  it('renders the same three details for the hero drop-off and a later one', () => {
    // One renderer for both, so neither can quietly lose a field.
    renderView(
      liveView({
        events: [
          mobileDropOffEvent('2026-03-10'),
          { ...mobileDropOffEvent('2026-03-21'), id: 'later-drop-off' },
        ],
      }),
    );

    expect(screen.getAllByText(/Europe\/Berlin/)).toHaveLength(2);
    expect(screen.getAllByText('Rizzastraße Ecke Südallee')).toHaveLength(2);
  });
});

describe('DashboardView freshness labelling', () => {
  it('labels a current response as freshly retrieved', () => {
    renderView(liveView({ events: [curbsideEvent('2026-03-10')] }));

    expect(screen.getByText(/Aktuell abgerufen am/)).toBeInTheDocument();
    expect(screen.queryByText(/Gespeicherte Termine/)).not.toBeInTheDocument();
  });

  it('labels a stale response without claiming it is current', () => {
    renderView(liveView({ events: [curbsideEvent('2026-03-10')], freshness: 'stale' }));

    // `Stand vom` appears only on the status line; the live region carries its own wording, so this
    // query cannot match both.
    expect(screen.getByText(/Stand vom/)).toBeInTheDocument();
    expect(screen.queryByText(/Aktuell abgerufen am/)).not.toBeInTheDocument();
  });

  it('labels a restored entry as offline and never as fresh', () => {
    renderView(cachedView({ events: [curbsideEvent('2026-03-10')] }));

    expect(screen.getByText(/API nicht erreichbar/)).toBeInTheDocument();
    expect(screen.queryByText(/Aktuell abgerufen am/)).not.toBeInTheDocument();
  });

  it('distinguishes a failed refresh from being offline', () => {
    renderView(cachedView({ events: [curbsideEvent('2026-03-10')] }, false));

    expect(screen.getByText(/Aktualisierung fehlgeschlagen/)).toBeInTheDocument();
  });

  it('shows both its own storage time and the source retrieval time', () => {
    renderView(cachedView({ events: [curbsideEvent('2026-03-10')] }));

    expect(screen.getByText(/Gespeichert am/)).toBeInTheDocument();
    expect(screen.getByText(/Von der Quelle abgerufen am/)).toBeInTheDocument();
  });
});

/**
 * The refresh **succeeded** and returned a retrieval older than the one already stored.
 *
 * Nothing failed and nothing is offline, so every other cached wording would be untrue — and the kept entry
 * is the newer of the two, which is still not the same claim as being the current live response.
 */
describe('DashboardView retained-newer labelling', () => {
  const retainedView = () =>
    deriveScheduleView({
      hasSelection: true,
      phase: {
        kind: 'retained_newer_cache',
        restored: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
      },
    });

  it('explains that a newer stored schedule was kept because the refresh returned an older retrieval', () => {
    renderView(retainedView());

    // The status line's own wording. The live region carries a different sentence, so this query cannot
    // match both.
    const message = screen.getByText(/Gespeicherte Termine, weil die Aktualisierung einen älteren/);

    expect(message).toHaveTextContent(/Der neuere gespeicherte Stand wurde beibehalten/);
  });

  it('never presents it as a current response', () => {
    renderView(retainedView());

    expect(screen.queryByText(/Aktuell abgerufen am/)).not.toBeInTheDocument();
    // Still labelled as stored data, with its own storage time.
    expect(screen.getByText(/Gespeichert am/)).toBeInTheDocument();
  });

  it('claims neither a failure nor being offline', () => {
    renderView(retainedView());

    expect(screen.queryByText(/nicht erreichbar/)).not.toBeInTheDocument();
    expect(screen.queryByText(/fehlgeschlagen/)).not.toBeInTheDocument();
  });

  it('announces it truthfully to a screen reader', () => {
    renderView(retainedView());

    expect(screen.getByRole('status')).toHaveTextContent(
      'Die Aktualisierung hat einen älteren Abruf der Quelle geliefert. Der neuere gespeicherte Stand wird weiterhin angezeigt.',
    );
  });
});

describe('DashboardView cache coverage', () => {
  it('states the date through which data is available when the tail is uncovered', () => {
    // Uncovered tail only: the entry starts where the window starts and stops before it ends.
    renderView(
      cachedView({
        events: [curbsideEvent('2026-03-10')],
        rangeCoverage: 'partial',
        displayRange: { from: '2026-03-02', to: '2026-05-30' },
        requestedRange: { from: '2026-03-02', to: '2026-06-30' },
      }),
    );

    const message = screen.getByText(/reichen nur bis zum/);

    expect(message).toBeInTheDocument();
    expect(message).toHaveTextContent('30.05.2026');
    expect(message).toHaveTextContent(/Für die Zeit danach/);
    expect(message).toHaveTextContent(/keine Daten vor/);
  });

  it('states the date from which data is available when the head is uncovered', () => {
    // The ordinary daily case: the window moved forward, so the days before the entry's start are missing.
    // Naming the tail here — the single message this replaces — described the wrong period entirely.
    renderView(
      cachedView({
        events: [curbsideEvent('2026-03-10')],
        rangeCoverage: 'partial',
        displayRange: { from: '2026-03-02', to: '2026-05-30' },
        requestedRange: { from: '2026-03-01', to: '2026-05-30' },
      }),
    );

    const message = screen.getByText(/liegen erst ab dem/);

    expect(message).toHaveTextContent('02.03.2026');
    expect(message).toHaveTextContent(/Für die Zeit davor/);
    expect(screen.queryByText(/reichen nur bis zum/)).not.toBeInTheDocument();
  });

  it('names both boundaries when neither end is covered', () => {
    renderView(
      cachedView({
        events: [curbsideEvent('2026-03-10')],
        rangeCoverage: 'partial',
        displayRange: { from: '2026-03-02', to: '2026-04-30' },
        requestedRange: { from: '2026-03-01', to: '2026-05-31' },
      }),
    );

    const message = screen.getByText(/liegen nur vom/);

    expect(message).toHaveTextContent('02.03.2026');
    expect(message).toHaveTextContent('30.04.2026');
    expect(message).toHaveTextContent(/davor und danach/);
  });

  it('does not show the partial message for a fully covering cache', () => {
    renderView(cachedView({ events: [curbsideEvent('2026-03-10')] }));

    expect(screen.queryByText(/reichen nur bis zum/)).not.toBeInTheDocument();
    expect(screen.queryByText(/liegen erst ab dem/)).not.toBeInTheDocument();
    expect(screen.queryByText(/liegen nur vom/)).not.toBeInTheDocument();
  });

  it('bounds the stated period by the display range rather than the requested range', () => {
    renderView(
      cachedView({
        events: [curbsideEvent('2026-03-10')],
        rangeCoverage: 'partial',
        displayRange: { from: '2026-03-02', to: '2026-04-30' },
        requestedRange: { from: '2026-03-02', to: '2026-05-31' },
      }),
    );

    expect(screen.getByText(/^Zeitraum/)).toHaveTextContent('30.04.2026');
    expect(screen.getByText(/^Zeitraum/)).not.toHaveTextContent('31.05.2026');
  });
});

describe('DashboardView empty and unavailable states', () => {
  it('reads an empty result inside a covered range as no collection in this period', () => {
    renderView(liveView({ events: [] }));

    expect(screen.getByText('Keine Abholung in diesem Zeitraum')).toBeInTheDocument();
    expect(screen.getByText(/keine passende Abholung/)).toBeInTheDocument();
  });

  it('renders the no-calendar-for-this-period state distinctly', () => {
    renderView(deriveScheduleView({ hasSelection: true, phase: { kind: 'outside_validity' } }));

    expect(screen.getByText('Kein Kalender für diesen Zeitraum')).toBeInTheDocument();
  });

  it('renders the range-not-covered state for a 422 rather than a generic error', () => {
    renderView(
      deriveScheduleView({
        hasSelection: true,
        phase: {
          kind: 'failed',
          failure: {
            kind: 'problem',
            operation: 'listCollectionEvents',
            status: 422,
            code: 'SCHEDULE_RANGE_NOT_COVERED',
            requestId: 'req-1',
          },
        },
      }),
    );

    expect(screen.getByText('Kein Kalender für diesen Zeitraum')).toBeInTheDocument();
    expect(screen.queryByText('Termine nicht verfügbar')).not.toBeInTheDocument();
  });

  it('renders the loading state distinctly', () => {
    renderView(deriveScheduleView({ hasSelection: true, phase: { kind: 'pending' } }));

    expect(screen.getByText('Termine werden geladen')).toBeInTheDocument();
  });
});

describe('DashboardView failure states', () => {
  it.each([
    [
      'network',
      { kind: 'network' as const, operation: 'listCollectionEvents' as const },
      /nicht erreichbar/,
    ],
    [
      'timeout',
      { kind: 'timeout' as const, operation: 'listCollectionEvents' as const, timeoutMs: 8000 },
      /zu lange gedauert/,
    ],
    [
      'invalid_response',
      {
        kind: 'invalid_response' as const,
        operation: 'listCollectionEvents' as const,
        status: 500,
      },
      /unlesbar/,
    ],
    ['unsupported_message', { kind: 'unsupported_message' as const }, /nicht abrufen/],
  ])('renders the %s failure with its own message and no identifier', (_kind, failure, message) => {
    renderView(deriveScheduleView({ hasSelection: true, phase: { kind: 'failed', failure } }));

    expect(screen.getByRole('alert')).toHaveTextContent(message);
    // A failure that never reached a server has no identifier, and a placeholder would be worse than none.
    expect(screen.queryByText(/Referenz für den Support/)).not.toBeInTheDocument();
  });

  it('shows the support identifier only for a validated problem response', () => {
    renderView(
      deriveScheduleView({
        hasSelection: true,
        phase: {
          kind: 'failed',
          failure: {
            kind: 'problem',
            operation: 'listCollectionEvents',
            status: 503,
            code: 'UPSTREAM_SOURCE_UNAVAILABLE',
            requestId: 'req-42',
          },
        },
      }),
    );

    expect(screen.getByText(/Referenz für den Support/)).toHaveTextContent('req-42');
  });

  it('degrades an unrecognized problem code to a generic message', () => {
    renderView(
      deriveScheduleView({
        hasSelection: true,
        phase: {
          kind: 'failed',
          failure: {
            kind: 'problem',
            operation: 'listCollectionEvents',
            status: 418,
            code: 'SOME_FUTURE_PROBLEM',
            requestId: 'req-7',
          },
        },
      }),
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Die Termine konnten nicht geladen werden.',
    );
    expect(screen.queryByText('SOME_FUTURE_PROBLEM')).not.toBeInTheDocument();
  });

  it('offers a retry', async () => {
    const user = userEvent.setup();
    const { onRetry } = renderView(
      deriveScheduleView({
        hasSelection: true,
        phase: { kind: 'failed', failure: { kind: 'network', operation: 'listCollectionEvents' } },
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Erneut versuchen' }));

    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('DashboardView accessibility', () => {
  it('announces its state through a polite live region', () => {
    renderView(cachedView({ events: [curbsideEvent('2026-03-10')] }));

    const status = screen.getByRole('status');

    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent(/API ist nicht erreichbar/);
  });

  it('announces a current response differently from a cached one', () => {
    renderView(liveView({ events: [curbsideEvent('2026-03-10')] }));

    expect(screen.getByRole('status')).toHaveTextContent('Aktuelle offizielle Termine geladen.');
  });

  it('gives the settings control an accessible name', async () => {
    const user = userEvent.setup();
    const { onOpenSettings } = renderView(liveView({ events: [curbsideEvent('2026-03-10')] }));

    await user.click(screen.getByRole('button', { name: 'Einstellungen öffnen' }));

    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it('shows no demo badge, because the extension no longer reads demo data', () => {
    renderView(liveView({ events: [curbsideEvent('2026-03-10')] }));

    expect(screen.queryByText(/Demo/)).not.toBeInTheDocument();
  });
});

describe('the live refresh phase', () => {
  const cachedWith = (phase: Parameters<typeof deriveScheduleView>[0]['phase']) =>
    deriveScheduleView({
      hasSelection: true,
      restored: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
      phase,
    });

  it('shows a restored cache as refreshing while the live request is pending', () => {
    // The regression: a pending refresh used to be labelled a failed one, so the ordinary first moments after
    // opening the popup claimed something had gone wrong.
    const view = cachedWith({ kind: 'pending' });

    expect(view).toMatchObject({ kind: 'cached', reason: 'refreshing' });

    renderView(view);

    expect(screen.getByText(/während die aktuellen Termine geladen werden/)).toBeInTheDocument();
    expect(screen.queryByText(/fehlgeschlagen/)).not.toBeInTheDocument();
    expect(screen.queryByText(/nicht erreichbar/)).not.toBeInTheDocument();
  });

  it('never announces a pending refresh as a failure', () => {
    renderView(cachedWith({ kind: 'pending' }));

    const status = screen.getByRole('status');

    expect(status).toHaveTextContent('Aktualisierung läuft');
    expect(status).not.toHaveTextContent(/fehlgeschlagen/);
    expect(status).not.toHaveTextContent(/nicht erreichbar/);
  });

  it('moves from refreshing to a fresh live response', () => {
    const live = deriveScheduleView({
      hasSelection: true,
      restored: restoredSchedule({ events: [curbsideEvent('2026-03-10')] }),
      phase: { kind: 'succeeded', schedule: schedule({ events: [curbsideEvent('2026-03-10')] }) },
    });

    expect(live).toMatchObject({ kind: 'live', freshness: 'fresh' });

    renderView(live);

    expect(screen.getByText(/Aktuell abgerufen am/)).toBeInTheDocument();
    expect(screen.queryByText(/Gespeicherte Termine/)).not.toBeInTheDocument();
  });

  it('respects server freshness when the live response is stale', () => {
    const view = deriveScheduleView({
      hasSelection: true,
      phase: {
        kind: 'succeeded',
        schedule: schedule({ events: [curbsideEvent('2026-03-10')], freshness: 'stale' }),
      },
    });

    expect(view).toMatchObject({ kind: 'live', freshness: 'stale' });
  });

  it('moves from refreshing to offline on a network failure', () => {
    const view = cachedWith({
      kind: 'failed',
      failure: { kind: 'network', operation: 'listCollectionEvents' },
    });

    expect(view).toMatchObject({ kind: 'cached', reason: 'offline' });

    renderView(view);

    expect(screen.getByText(/weil die API nicht erreichbar ist/)).toBeInTheDocument();
  });

  it('treats a timeout as offline rather than as a failed refresh', () => {
    expect(
      cachedWith({
        kind: 'failed',
        failure: { kind: 'timeout', operation: 'listCollectionEvents', timeoutMs: 8000 },
      }),
    ).toMatchObject({ reason: 'offline' });
  });

  it('moves from refreshing to a non-network refresh failure', () => {
    const view = cachedWith({
      kind: 'failed',
      failure: { kind: 'invalid_response', operation: 'listCollectionEvents', status: 500 },
    });

    expect(view).toMatchObject({ kind: 'cached', reason: 'refresh_failed' });

    renderView(view);

    expect(screen.getByText(/weil die Aktualisierung fehlgeschlagen ist/)).toBeInTheDocument();
  });

  it.each([
    ['a supersession', { kind: 'superseded' as const }],
    [
      'a cancellation',
      {
        kind: 'failed' as const,
        failure: { kind: 'cancelled' as const, operation: 'listCollectionEvents' as const },
      },
    ],
  ])('never renders %s as an error or a failed refresh', (_reason, phase) => {
    // A cancellation means a newer selection replaced this request — work the user themselves superseded.
    expect(cachedWith(phase)).toMatchObject({ kind: 'cached', reason: 'refreshing' });

    // And with nothing cached it stays loading rather than becoming an error.
    expect(deriveScheduleView({ hasSelection: true, phase })).toEqual({ kind: 'loading' });
  });

  it('stays loading while no cache exists and no answer has arrived', () => {
    expect(deriveScheduleView({ hasSelection: true, phase: { kind: 'pending' } })).toEqual({
      kind: 'loading',
    });
  });

  it('becomes an error only once a real failure arrives with nothing cached', () => {
    expect(
      deriveScheduleView({
        hasSelection: true,
        phase: {
          kind: 'failed',
          failure: { kind: 'network', operation: 'listCollectionEvents' },
        },
      }),
    ).toMatchObject({ kind: 'error' });
  });

  it('reports range-not-covered rather than a failure when the window is outside validity', () => {
    expect(cachedWith({ kind: 'outside_validity' })).toEqual({ kind: 'range_not_covered' });
  });
});

/**
 * "Nächste Abholung" has to be the earliest collection, not whichever the response listed first.
 *
 * Nothing in the contract promises the API, a cache restore, or a range intersection returns events in date
 * order. The surface took the first element, so a response whose first entry was the later collection put the
 * wrong date under the heading and buried the one that was actually next — a person reading it would miss it.
 */
describe('DashboardView event ordering', () => {
  const laterSection = (): HTMLElement | null => {
    const heading = screen.queryByRole('heading', { name: 'Danach' });

    return heading === null ? null : heading.closest('section');
  };

  /** The rows after the hero, in the order they are rendered. */
  const laterDates = (): string[] => {
    const section = laterSection();

    if (section === null) {
      return [];
    }

    return [...section.querySelectorAll('p.tabular-nums')].map((node) => node.textContent ?? '');
  };

  it('shows the earliest event as the next collection when the response is unsorted', () => {
    // The later collection arrives first, which is exactly the case that used to be rendered as "next".
    renderView(
      liveView({
        events: [curbsideEvent('2026-03-24', 'bio'), curbsideEvent('2026-03-10')],
      }),
    );

    // 2026-03-10 is the day after the reference date, so the earliest event reads as "Morgen".
    expect(screen.getByText('Morgen')).toBeInTheDocument();
    expect(screen.getByText('2026-03-10')).toBeInTheDocument();
    expect(screen.queryByText('2026-03-24')).not.toBeInTheDocument();
  });

  it('renders the rows after the hero in ascending order', () => {
    renderView(
      liveView({
        events: [
          curbsideEvent('2026-04-07', 'bio'),
          curbsideEvent('2026-03-10'),
          curbsideEvent('2026-03-24', 'bio'),
        ],
      }),
    );

    // The hero holds the earliest; the list holds the rest, still ascending.
    expect(screen.getByText('2026-03-10')).toBeInTheDocument();
    // Both are more than a week out, so each renders as a short weekday date — still ascending.
    expect(laterDates()).toEqual(['Di., 24. März', 'Di., 7. Apr.']);
  });

  it('orders an all-day collection before a timed one on the same date', () => {
    // An all-day event names no time, so it cannot be placed after something that does.
    renderView(
      liveView({ events: [mobileDropOffEvent('2026-03-10'), curbsideEvent('2026-03-10')] }),
    );

    // The curbside paper collection is the hero, so its label — not the drop-off's — is the headline.
    expect(screen.getByRole('heading', { name: 'Altpapier' })).toBeInTheDocument();
  });

  it('is deterministic for two events sharing a date and a timing', () => {
    // Same date, both all-day: the waste type then the identifier decide, so the order cannot vary per render.
    const first = { ...curbsideEvent('2026-03-10', 'bio'), id: 'zzz-last' };
    const second = { ...curbsideEvent('2026-03-10', 'paper'), id: 'aaa-first' };

    const { unmount } = renderView(liveView({ events: [first, second] }));
    const initial = screen.getByRole('heading', { name: /Biotonne|Altpapier/ }).textContent;

    unmount();

    // The same set in the opposite order produces the same hero.
    renderView(liveView({ events: [second, first] }));

    expect(screen.getByRole('heading', { name: /Biotonne|Altpapier/ }).textContent).toBe(initial);
    // `bio` sorts before `paper`, so the waste type decides before the identifier is consulted.
    expect(initial).toBe('Biotonne');
  });

  it('applies the waste-type filter before choosing the next collection', () => {
    // The earliest event overall is one the person asked not to see, so it must not become the hero.
    renderView(
      liveView({ events: [curbsideEvent('2026-03-10', 'residual'), curbsideEvent('2026-03-24')] }),
      ['paper'],
    );

    expect(screen.getByText('2026-03-24')).toBeInTheDocument();
    expect(screen.queryByText('2026-03-10')).not.toBeInTheDocument();
  });

  it('bounds the choice by the display range, so an excluded event cannot become the hero', () => {
    // The earliest event sits outside what the cache covers, so it is not presented at all — and certainly not
    // as the next collection.
    renderView(
      cachedView({
        rangeCoverage: 'partial',
        servedRange: { from: '2026-03-01', to: '2026-05-30' },
        displayRange: { from: '2026-03-15', to: '2026-05-30' },
        requestedRange: { from: '2026-03-01', to: '2026-05-30' },
        events: [curbsideEvent('2026-03-02'), curbsideEvent('2026-03-20')],
      }),
    );

    expect(screen.getByText('2026-03-20')).toBeInTheDocument();
    expect(screen.queryByText('2026-03-02')).not.toBeInTheDocument();
  });

  it('reaches the empty state from the filtered and bounded set rather than from the raw list', () => {
    // Events exist, but none of them is both visible and inside the covered range.
    renderView(liveView({ events: [curbsideEvent('2026-03-10', 'residual')] }), ['paper']);

    expect(screen.getByText('Keine Abholung in diesem Zeitraum')).toBeInTheDocument();
    expect(laterSection()).toBeNull();
  });

  it('leaves the array it was given untouched', () => {
    // `sort` mutates, so the copy is what stops this surface reordering a transport or cached array.
    const events = [curbsideEvent('2026-03-24', 'bio'), curbsideEvent('2026-03-10')];
    const original = [...events];
    const view = liveView({ events });

    renderView(view);

    expect(events).toEqual(original);
    expect(events[0]?.date).toBe('2026-03-24');
    // The view's own event array is equally untouched.
    expect(view.kind === 'live' && view.events.map((event) => event.date)).toEqual([
      '2026-03-24',
      '2026-03-10',
    ]);
  });
});

/**
 * The one external link this surface renders.
 *
 * Its scheme is decided at the boundary that accepted it — only `http(s)` without credentials reaches here — and
 * opening it in a new context keeps the repository's `rel` behaviour, so the new document gets neither a referrer
 * nor a handle on this one.
 */
describe('DashboardView external source link', () => {
  it('opens in a new context without leaking a referrer or a window handle', () => {
    renderView(liveView({ events: [curbsideEvent('2026-03-10')] }));

    const link = screen.getByRole('link', { name: /Offizielle Seite des Betriebs/ });

    expect(link).toHaveAttribute('target', '_blank');
    // `noreferrer` implies `noopener`, so the opened document can neither see where it came from nor reach back.
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('renders the operator’s address exactly as it was published', () => {
    renderView(liveView({ events: [curbsideEvent('2026-03-10')] }));

    // Path intact: normalizing it would misrepresent the address, and it is only ever an http(s) URL because the
    // boundary refused anything else.
    expect(screen.getByRole('link', { name: /Offizielle Seite des Betriebs/ })).toHaveAttribute(
      'href',
      'https://servicebetrieb.koblenz.de/abfallwirtschaft/entsorgungstermine-digital/',
    );
  });
});
