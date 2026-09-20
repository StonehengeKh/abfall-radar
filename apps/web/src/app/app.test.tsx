import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppShell } from '@/src/app/app';
import { SUPPORTED_LOCALES } from '@/src/i18n/locale';
import { MESSAGES } from '@/src/i18n/messages';
import { RANGE_RECOVERY_INTERVAL_MS } from '@/src/schedule/range-recovery-coordinator';
import { APP_VIEW_KINDS } from '@/src/schedule/view-state';
import {
  AREA_ID,
  area,
  CITY_ID,
  areas,
  curbside,
  DEMO_PROVIDER,
  dropOff,
  events,
  KOBLENZ_CITY,
  OFFICIAL_PROVIDER,
  PROVIDER_ID,
  providers,
} from '@/src/test/fixtures';
import { createHarness, fail, type Harness, ok } from '@/src/test/harness';

/** The default locale: every assertion below is written in the language the app starts in. */
const DE = MESSAGES.de;

/**
 * Component tests for the rendered surfaces. A colocated test file, so Tailwind must never scan it:
 * `tracking-[0.4242em]` is planted here and asserted absent from generated CSS by the post-build
 * verifier.
 */
const PLANTED_TAILWIND_CANDIDATE = 'tracking-[0.4242em]';

const CATALOGUE = providers(DEMO_PROVIDER, OFFICIAL_PROVIDER);
const MIXED_AREAS = areas(
  area(),
  area({ id: 'randlage', name: 'Randlage', collectionEvents: { availability: 'unavailable' } }),
);
const DROP_OFF = dropOff({
  id: 'drop-2026-09-12',
  date: '2026-09-12',
  timing: {
    kind: 'time_window',
    startsAt: '2026-09-12T10:00:00Z',
    endsAt: '2026-09-12T12:00:00Z',
    timeZone: 'Europe/Berlin',
  },
});

const renderApp = (harness: Harness) => {
  const view = render(<AppShell controller={harness.controller} snapshot={harness.snapshot()} />);
  const rerender = (): void => {
    view.rerender(<AppShell controller={harness.controller} snapshot={harness.snapshot()} />);
  };

  harness.controller.subscribe(rerender);

  return { rerender };
};

const UNCOVERED_AREAS = areas(
  area({
    collectionEvents: {
      availability: 'available',
      timeZone: 'Europe/Berlin',
      validity: { from: '2020-01-01', to: '2020-12-31' },
    },
  }),
);

const bootstrap = async (harness: Harness): Promise<{ rerender: () => void }> => {
  const rendered = renderApp(harness);
  harness.controller.start();
  await harness.flush();
  rendered.rerender();

  return rendered;
};

/** Bootstraps, picks the offered provider and its available area, and confirms, through the UI. */
const reachSchedule = async (harness: Harness): Promise<{ rerender: () => void }> => {
  const rendered = await bootstrap(harness);

  await userEvent.click(screen.getByRole('button', { name: KOBLENZ_CITY.name }));
  await harness.flush();
  rendered.rerender();
  await userEvent.click(screen.getByRole('button', { name: /Stadtmitte/ }));
  rendered.rerender();
  await userEvent.click(screen.getByRole('button', { name: DE.actions.confirm }));
  await harness.flush();
  rendered.rerender();

  return rendered;
};

describe('the selection surface', () => {
  it('offers only official providers, preselects nothing, and needs an explicit confirmation', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(MIXED_AREAS))
      .queueEvents(ok(events([curbside()])));
    const rendered = await bootstrap(harness);

    expect(
      screen.getByRole('heading', { name: DE.states.needs_selection.heading }),
    ).toBeInTheDocument();
    expect(screen.queryByText(DEMO_PROVIDER.name)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: KOBLENZ_CITY.name }));
    await harness.flush();
    rendered.rerender();

    const confirm = screen.getByRole('button', { name: DE.actions.confirm });

    expect(confirm).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: /Stadtmitte/ }));
    rendered.rerender();
    await userEvent.click(screen.getByRole('button', { name: DE.actions.confirm }));
    await harness.flush();
    rendered.rerender();

    expect(screen.getByRole('heading', { name: DE.states.live.heading })).toBeInTheDocument();
  });

  it('renders an unavailable area as a native-disabled control with its explanation', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(MIXED_AREAS));
    const rendered = await bootstrap(harness);

    await userEvent.click(screen.getByRole('button', { name: KOBLENZ_CITY.name }));
    await harness.flush();
    rendered.rerender();

    const unavailable = screen.getByRole('button', { name: /Randlage/ });

    expect(unavailable).toBeDisabled();
    expect(unavailable).toHaveAttribute('disabled');
    expect(screen.getByText(/veröffentlicht die Quelle keinen Kalender/)).toBeInTheDocument();

    // A native-disabled control dispatches nothing and is skipped by sequential navigation.
    await userEvent.click(unavailable);
    rendered.rerender();

    expect(screen.getByRole('button', { name: DE.actions.confirm })).toBeDisabled();
  });

  it('exposes Zurück on the area step and returns to the step that opened it', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(MIXED_AREAS));
    const rendered = await bootstrap(harness);

    await userEvent.click(screen.getByRole('button', { name: KOBLENZ_CITY.name }));
    await harness.flush();
    rendered.rerender();
    await userEvent.click(screen.getByRole('button', { name: DE.actions.back }));
    await harness.flush();
    rendered.rerender();

    // One step back: this city offers a single provider, so no provider screen was shown and the
    // city step is what opened the area step.
    expect(screen.getByRole('heading', { name: DE.steps.city })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: KOBLENZ_CITY.name })).toBeInTheDocument();
  });
});

describe('the schedule surface', () => {
  const reachSchedule = async (harness: Harness) => {
    const rendered = await bootstrap(harness);

    harness.controller.selectCity(CITY_ID);
    await harness.flush();
    harness.controller.selectArea(AREA_ID);
    harness.controller.confirm();
    await harness.flush();
    rendered.rerender();

    return rendered;
  };

  it('renders one row per normalized event, keeping both events of one appointment', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(MIXED_AREAS))
      .queueEvents(
        ok(
          events([
            DROP_OFF,
            { ...DROP_OFF, id: 'drop-2026-09-12-electronics', wasteType: 'small_electronics' },
            curbside(),
          ]),
        ),
      );
    await reachSchedule(harness);
    const rows = screen.getAllByTestId('event-row');

    /*
     * Three normalized events, one of them featured in the hero card and therefore not repeated below.
     * The two that share an appointment — same date, same window, different waste type — both keep a
     * row: only the featured event's own identifier is excluded.
     */
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText('Schadstoffe')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Elektrokleinteile')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('next-collection')).getByText('Altpapier'),
    ).toBeInTheDocument();
    expect(rows.some((row) => row.textContent?.includes('Altpapier'))).toBe(false);
  });

  it('shows the drop-off window with both offsets and the zone, and the location', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(MIXED_AREAS))
      .queueEvents(ok(events([DROP_OFF])));
    await reachSchedule(harness);

    expect(screen.getByText('12:00 UTC+02:00–14:00 UTC+02:00 (Europe/Berlin)')).toBeInTheDocument();
    expect(screen.getByText('Rizzastraße Ecke Südallee')).toBeInTheDocument();
  });

  it('renders a curbside event without a window or a location', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(MIXED_AREAS))
      .queueEvents(ok(events([curbside()])));
    await reachSchedule(harness);

    expect(screen.queryByText(/UTC\+/)).not.toBeInTheDocument();
    expect(screen.queryByText('Rizzastraße Ecke Südallee')).not.toBeInTheDocument();
  });

  it('keeps provenance and the declared coverage visible for a successful empty response', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(MIXED_AREAS))
      .queueEvents(ok(events([])));
    await reachSchedule(harness);

    expect(screen.getByRole('heading', { name: DE.states.empty.heading })).toBeInTheDocument();
    expect(screen.getByText('Kommunaler Servicebetrieb, Koblenz')).toBeInTheDocument();
    expect(screen.getByText(/Altpapier, Gelber Sack/)).toBeInTheDocument();
    expect(screen.queryAllByTestId('event-row')).toHaveLength(0);
  });

  it('renders the three provenance values separately and links the validated landing page', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(MIXED_AREAS))
      .queueEvents(ok(events([curbside()])));
    await reachSchedule(harness);
    const link = screen.getByRole('link', { name: 'Quelle öffnen' });

    expect(screen.getByText('Kommunaler Servicebetrieb')).toBeInTheDocument();
    expect(screen.getByText('Kommunaler Servicebetrieb, Koblenz')).toBeInTheDocument();
    expect(link).toHaveAttribute('href', 'https://servicebetrieb.example.test/entsorgungstermine/');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('leaks no injected sentinel while still rendering the required product data', async () => {
    const harness = createHarness();
    // Test-only keys, injected into the raw payload before validation. `z.object` strips unknown keys,
    // so the response still parses successfully and the api-client contract is untouched.
    const rawMeta = {
      ...events([curbside()]).meta,
      __arRawSentinel: 'AR005-LEAK-META-91c2',
      source: { ...events([curbside()]).meta.source, __arDebugSentinel: 'AR005-LEAK-SOURCE-7f3a' },
    };
    const payload = events([{ ...curbside(), __arEventSentinel: 'AR005-LEAK-EVENT-b40e' }]);
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(MIXED_AREAS))
      .queueEvents(ok({ ...payload, meta: { ...payload.meta, ...rawMeta } }));
    await reachSchedule(harness);
    const markup = document.body.innerHTML;

    for (const sentinel of [
      'AR005-LEAK-META-91c2',
      'AR005-LEAK-SOURCE-7f3a',
      'AR005-LEAK-EVENT-b40e',
    ]) {
      expect(markup).not.toContain(sentinel);
    }

    // The test fails just as loudly if required validated data stops rendering.
    expect(screen.getByText('Kommunaler Servicebetrieb, Koblenz')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Quelle öffnen' })).toHaveAttribute(
      'href',
      'https://servicebetrieb.example.test/entsorgungstermine/',
    );
    // The one published event is the featured one, so it is rendered by the hero card.
    expect(screen.queryAllByTestId('event-row')).toHaveLength(0);
    expect(screen.getByTestId('next-collection')).toHaveTextContent('Altpapier');
  });
});

describe('failure surfaces', () => {
  it('renders a network failure with its own copy and no identifier', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(fail({ kind: 'network', operation: 'listProviders' }));
    const rendered = await bootstrap(harness);

    await userEvent.click(screen.getByRole('button', { name: KOBLENZ_CITY.name }));
    await harness.flush();
    rendered.rerender();

    expect(screen.getByText(DE.failures.network)).toBeInTheDocument();
    expect(screen.queryByText(/Kennung/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: DE.actions.retry })).toBeInTheDocument();
  });

  it('renders an unrecognized problem code with generic copy and its validated identifier', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(
      fail({
        kind: 'problem',
        operation: 'listProviders',
        status: 500,
        code: 'SOMETHING_NEW',
        requestId: 'req-77',
      }),
    );
    const rendered = await bootstrap(harness);

    await userEvent.click(screen.getByRole('button', { name: KOBLENZ_CITY.name }));
    await harness.flush();
    rendered.rerender();

    expect(screen.getByText(DE.failures.problem)).toBeInTheDocument();
    expect(screen.getByText('req-77')).toBeInTheDocument();
  });

  it('renders the configuration error without a retry or a change-selection action', async () => {
    const harness = createHarness({ gateway: null });
    await bootstrap(harness);

    expect(
      screen.getByRole('heading', { name: DE.states.configuration_error.heading }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: DE.actions.retry })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: DE.actions.changeSelection }),
    ).not.toBeInTheDocument();
  });

  it('shows no server diagnostic string anywhere', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(
      fail({
        kind: 'problem',
        operation: 'listProviders',
        status: 500,
        code: 'INTERNAL_SERVER_ERROR',
        requestId: 'req-9',
      }),
    );
    await bootstrap(harness);

    expect(document.body.innerHTML).not.toContain('urn:abfall-radar');
  });
});

describe('copy and announcements are exhaustive', () => {
  it('gives every state member non-empty copy and an announcement in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const kind of APP_VIEW_KINDS) {
        const copy = MESSAGES[locale].states[kind];

        expect(copy.heading.length).toBeGreaterThan(0);
        expect(copy.body.length).toBeGreaterThan(0);
        expect(copy.announcement.length).toBeGreaterThan(0);
      }
    }
  });

  it('gives every renderable failure kind its own message, with cancelled excluded by the type', () => {
    const kinds = [
      'network',
      'timeout',
      'invalid_response',
      'problem',
      'source_date_unavailable',
    ] as const;

    for (const locale of SUPPORTED_LOCALES) {
      const messages = kinds.map((kind) => MESSAGES[locale].failures[kind]);

      // Distinct within the locale, so a renderer collapsing two subtypes into one wording fails.
      expect(new Set(messages).size).toBe(kinds.length);
      expect(Object.keys(MESSAGES[locale].failures)).not.toContain('cancelled');
    }
  });

  it('replaces a transient notice as soon as the state it belongs to is gone', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(providers(OFFICIAL_PROVIDER)), ok(providers(OFFICIAL_PROVIDER)))
      .queueAreas(
        fail({
          kind: 'problem',
          operation: 'listServiceAreas',
          status: 404,
          code: 'PROVIDER_NOT_FOUND',
          requestId: 'req-gone',
        }),
        ok(areas(area())),
      )
      .queueEvents(ok(events([curbside()])));
    const rendered = await bootstrap(harness);

    await userEvent.click(screen.getByRole('button', { name: KOBLENZ_CITY.name }));
    await harness.flush();
    rendered.rerender();

    expect(screen.getByTestId('live-region').textContent).toBe(DE.notices.provider_invalidated);

    // Recovery always waits for an explicit choice, so the refreshed provider is chosen by hand.
    await userEvent.click(screen.getByRole('button', { name: OFFICIAL_PROVIDER.name }));
    await harness.flush();
    rendered.rerender();
    await userEvent.click(screen.getByRole('button', { name: /Stadtmitte/ }));
    rendered.rerender();
    await userEvent.click(screen.getByRole('button', { name: DE.actions.confirm }));
    await harness.flush();
    rendered.rerender();

    // The stored message used to survive every later transition, so the live region kept reporting an
    // unavailable provider while a schedule was on screen.
    expect(screen.getByTestId('live-region').textContent).toBe(DE.states.live.announcement);
  });

  it('announces a failed recovery attempt and an unavailable source date', async () => {
    const harness = createHarness();
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(
        ok(
          areas(
            area({
              collectionEvents: {
                availability: 'available',
                timeZone: 'Europe/Berlin',
                validity: { from: '2020-01-01', to: '2020-12-31' },
              },
            }),
          ),
        ),
      )
      .queueEvents(ok(events([curbside()])));
    const rendered = await bootstrap(harness);

    await userEvent.click(screen.getByRole('button', { name: KOBLENZ_CITY.name }));
    await harness.flush();
    rendered.rerender();
    await userEvent.click(screen.getByRole('button', { name: /Stadtmitte/ }));
    rendered.rerender();
    await userEvent.click(screen.getByRole('button', { name: DE.actions.confirm }));
    await harness.flush();
    rendered.rerender();

    expect(screen.getByTestId('live-region').textContent).toBe(
      DE.states.range_not_covered.announcement,
    );

    harness.gateway.replaceProviders(fail({ kind: 'network', operation: 'listProviders' }));
    harness.timers.fire(RANGE_RECOVERY_INTERVAL_MS);
    await harness.flush();
    rendered.rerender();

    // A confirmed recovery failure was silent: the nested diagnostic changed nothing about the state.
    expect(screen.getByTestId('live-region').textContent).toContain(DE.failures.network);

    harness.gateway.replaceProviders(ok(CATALOGUE));
    harness.clock.set('invalid');
    harness.timers.fire(RANGE_RECOVERY_INTERVAL_MS);
    await harness.flush();
    rendered.rerender();

    expect(screen.getByTestId('live-region').textContent).toContain(
      DE.failures.source_date_unavailable,
    );
  });

  it('announces the current state through one polite live region', async () => {
    const harness = createHarness();
    harness.gateway.queueProviders(ok(CATALOGUE));
    await bootstrap(harness);
    const region = screen.getByTestId('live-region');

    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region.textContent?.length).toBeGreaterThan(0);
    // The planted candidate lives only in this colocated test file.
    expect(PLANTED_TAILWIND_CANDIDATE).toContain('0.4242em');
  });
});

/**
 * Every renderable failure type, rendered in every phase that can carry it.
 *
 * The assertion is deliberately two-sided: the top-level state and the subtype's own copy, so a
 * renderer that collapses the four transport failures into one message fails here. `cancelled` is
 * excluded by the renderable type and is asserted to render nothing at all.
 */
describe('failure subtypes, announcements, and the identifier policy', () => {
  const transport = (operation: 'listProviders' | 'listServiceAreas' | 'listCollectionEvents') =>
    [
      { failure: { kind: 'network', operation }, copy: DE.failures.network, identifier: null },
      {
        failure: { kind: 'timeout', operation, timeoutMs: 8000 },
        copy: DE.failures.timeout,
        identifier: null,
      },
      {
        failure: { kind: 'invalid_response', operation, status: 502 },
        copy: DE.failures.invalid_response,
        identifier: null,
      },
      {
        failure: {
          kind: 'problem',
          operation,
          status: 500,
          code: 'INTERNAL_SERVER_ERROR',
          requestId: 'req-42',
        },
        copy: DE.failures.problem,
        identifier: 'req-42',
      },
    ] as const;

  const assertSurface = (copy: string, identifier: string | null): void => {
    expect(screen.getByRole('heading', { name: DE.states.error.heading })).toBeInTheDocument();
    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(screen.getByTestId('live-region').textContent).toContain(copy);

    if (identifier === null) {
      // Asserted on the absence of the value, not on a placeholder.
      expect(screen.queryByText(/^req-/)).not.toBeInTheDocument();
    } else {
      expect(screen.getByText(identifier)).toBeInTheDocument();
    }
  };

  for (const { failure, copy, identifier } of transport('listProviders')) {
    it(`renders ${failure.kind} in selection_providers with its own copy`, async () => {
      const harness = createHarness();
      harness.gateway.queueProviders(fail(failure));
      const rendered = await bootstrap(harness);

      await userEvent.click(screen.getByRole('button', { name: KOBLENZ_CITY.name }));
      await harness.flush();
      rendered.rerender();

      assertSurface(copy, identifier);
    });
  }

  for (const { failure, copy, identifier } of transport('listServiceAreas')) {
    it(`renders ${failure.kind} in selection_areas with its own copy`, async () => {
      const harness = createHarness();
      harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(fail(failure));
      const rendered = await bootstrap(harness);

      await userEvent.click(screen.getByRole('button', { name: KOBLENZ_CITY.name }));
      await harness.flush();
      rendered.rerender();

      assertSurface(copy, identifier);
      expect(screen.getByRole('button', { name: DE.actions.back })).toBeInTheDocument();
    });
  }

  for (const { failure, copy, identifier } of transport('listCollectionEvents')) {
    it(`renders ${failure.kind} in schedule_pipeline with its own copy`, async () => {
      const harness = createHarness();
      harness.gateway
        .queueProviders(ok(CATALOGUE))
        .queueAreas(ok(MIXED_AREAS))
        .queueEvents(fail(failure));
      const rendered = await reachSchedule(harness);

      assertSurface(copy, identifier);
      expect(rendered).toBeDefined();
    });
  }

  for (const { failure, copy, identifier } of transport('listProviders')) {
    it(`announces ${failure.kind} inside range recovery without leaving the state`, async () => {
      const harness = createHarness();
      harness.gateway
        .queueProviders(ok(CATALOGUE))
        .queueAreas(ok(UNCOVERED_AREAS))
        .queueEvents(ok(events([curbside()])));
      const rendered = await reachSchedule(harness);

      harness.gateway.replaceProviders(fail(failure));
      harness.timers.fire(RANGE_RECOVERY_INTERVAL_MS);
      await harness.flush();
      rendered.rerender();

      expect(
        screen.getByRole('heading', { name: DE.states.range_not_covered.heading }),
      ).toBeInTheDocument();
      // The nested diagnostic is on the surface as well as in the live region, so both are present.
      expect(screen.getAllByText(new RegExp(copy.slice(0, 24))).length).toBeGreaterThan(0);
      expect(screen.getByTestId('live-region').textContent).toContain(copy);

      if (identifier === null) {
        expect(screen.queryByText(/^req-/)).not.toBeInTheDocument();
      } else {
        expect(screen.getByText(identifier)).toBeInTheDocument();
      }
    });
  }

  it('renders the local source-date failure with no identifier in either owning phase', async () => {
    const pipeline = createHarness();

    pipeline.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(MIXED_AREAS))
      .queueEvents(ok(events([curbside()])));
    pipeline.clock.set('invalid');
    await reachSchedule(pipeline);

    assertSurface(DE.failures.source_date_unavailable, null);
    cleanup();

    const recovery = createHarness();

    recovery.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(UNCOVERED_AREAS))
      .queueEvents(ok(events([curbside()])));
    const rendered = await reachSchedule(recovery);

    recovery.clock.set('invalid');
    recovery.timers.fire(RANGE_RECOVERY_INTERVAL_MS);
    await recovery.flush();
    rendered.rerender();

    expect(screen.getByTestId('live-region').textContent).toContain(
      DE.failures.source_date_unavailable,
    );
    expect(screen.queryByText(/^req-/)).not.toBeInTheDocument();
  });

  it('renders no error surface for a cancelled attempt', async () => {
    const harness = createHarness();

    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(MIXED_AREAS))
      .defer('listServiceAreas');
    const rendered = await bootstrap(harness);

    await userEvent.click(screen.getByRole('button', { name: KOBLENZ_CITY.name }));
    await harness.flush();
    rendered.rerender();
    await userEvent.click(screen.getByRole('button', { name: DE.actions.back }));
    await harness.flush();
    harness.gateway.release();
    await harness.flush();
    rendered.rerender();

    expect(
      screen.queryByRole('heading', { name: DE.states.error.heading }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(DE.failures.network)).not.toBeInTheDocument();
    expect(screen.getByTestId('live-region').textContent).not.toContain('konnten nicht geladen');
  });
});

describe('the district double-click shortcut', () => {
  const scheduled = (harness: Harness) =>
    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(MIXED_AREAS))
      .queueEvents(ok(events([curbside()])));

  it('confirms the district that was double-clicked and loads its schedule once', async () => {
    const harness = createHarness();

    scheduled(harness);
    const rendered = await bootstrap(harness);

    await userEvent.click(screen.getByRole('button', { name: KOBLENZ_CITY.name }));
    await harness.flush();
    rendered.rerender();
    await userEvent.dblClick(screen.getByRole('button', { name: /Stadtmitte/ }));
    await harness.flush();
    rendered.rerender();

    expect(screen.getByRole('heading', { name: DE.states.live.heading })).toBeInTheDocument();
    // Exactly one pipeline: a double click is two clicks, and only the shortcut confirms.
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(1);
  });

  it('confirms the district under the pointer, not a district selected earlier', async () => {
    const harness = createHarness();
    const twoAreas = areas(area(), area({ id: 'koblenz-neuendorf', name: 'Neuendorf' }));

    harness.gateway
      .queueProviders(ok(CATALOGUE))
      .queueAreas(ok(twoAreas))
      .queueEvents(ok(events([curbside()])));
    const rendered = await bootstrap(harness);

    await userEvent.click(screen.getByRole('button', { name: KOBLENZ_CITY.name }));
    await harness.flush();
    rendered.rerender();

    // One district is already the draft when another is double-clicked.
    await userEvent.click(screen.getByRole('button', { name: /Stadtmitte/ }));
    rendered.rerender();
    await userEvent.dblClick(screen.getByRole('button', { name: /Neuendorf/ }));
    await harness.flush();
    rendered.rerender();

    expect(harness.gateway.eventsCalls).toHaveLength(1);
    expect(harness.gateway.eventsCalls[0]?.serviceAreaId).toBe('koblenz-neuendorf');
  });

  it('leaves a single click on the draft, with the confirm button still the documented path', async () => {
    const harness = createHarness();

    scheduled(harness);
    const rendered = await bootstrap(harness);

    await userEvent.click(screen.getByRole('button', { name: KOBLENZ_CITY.name }));
    await harness.flush();
    rendered.rerender();
    await userEvent.click(screen.getByRole('button', { name: /Stadtmitte/ }));
    await harness.flush();
    rendered.rerender();

    // Selecting is not confirming.
    expect(harness.gateway.countOf('listCollectionEvents')).toBe(0);

    const confirm = screen.getByRole('button', { name: DE.actions.confirm });

    expect(confirm).toBeEnabled();

    await userEvent.click(confirm);
    await harness.flush();
    rendered.rerender();

    expect(harness.gateway.countOf('listCollectionEvents')).toBe(1);
  });

  it('never confirms an unavailable district, however it is clicked', async () => {
    const harness = createHarness();

    scheduled(harness);
    const rendered = await bootstrap(harness);

    await userEvent.click(screen.getByRole('button', { name: KOBLENZ_CITY.name }));
    await harness.flush();
    rendered.rerender();

    const unavailable = screen.getByRole('button', { name: /Randlage/ });

    expect(unavailable).toBeDisabled();

    await userEvent.dblClick(unavailable);
    await harness.flush();
    rendered.rerender();

    expect(harness.gateway.countOf('listCollectionEvents')).toBe(0);
    expect(harness.view().kind).toBe('needs_selection');
  });
});

describe('the district grid', () => {
  /** Twelve districts: past the threshold where search appears, and enough to fill several rows. */
  const MANY = areas(
    area(),
    ...[
      'Neuendorf',
      'Karthause 1',
      'Karthause 2',
      'Lützel',
      'Moselweiß',
      'Metternich',
      'Güls',
      'Rübenach',
      'Arenberg',
      'Pfaffendorf',
      'Horchheim',
    ].map((name, index) =>
      area({
        id: `koblenz-${index}`,
        name,
        ...(name === 'Horchheim' ? { collectionEvents: { availability: 'unavailable' } } : {}),
      }),
    ),
  );

  const reachDistricts = async (harness: Harness): Promise<{ rerender: () => void }> => {
    harness.gateway.queueProviders(ok(CATALOGUE)).queueAreas(ok(MANY));

    const rendered = await bootstrap(harness);

    await userEvent.click(screen.getByRole('button', { name: KOBLENZ_CITY.name }));
    await harness.flush();
    rendered.rerender();

    return rendered;
  };

  it('lays the districts out as a responsive grid the page scrolls, not a nested scroll box', async () => {
    const harness = createHarness();

    await reachDistricts(harness);

    const list = screen.getAllByTestId('area-choice')[0]?.closest('ul');

    expect(list).not.toBeNull();
    // One column on a narrow phone, two and then three where there is room.
    expect(list?.className).toContain('grid-cols-1');
    expect(list?.className).toContain('sm:grid-cols-2');
    expect(list?.className).toContain('lg:grid-cols-3');
    // Nothing clips the list or scrolls inside it.
    expect(list?.className).not.toMatch(/overflow|max-h-/);
  });

  it('reports how many districts are shown out of how many there are, and updates while typing', async () => {
    const harness = createHarness();

    await reachDistricts(harness);

    expect(screen.getByTestId('district-count').textContent).toBe(
      DE.schedule.districtCount(12, 12),
    );

    await userEvent.type(screen.getByRole('searchbox'), 'karthause');

    expect(screen.getAllByTestId('area-choice')).toHaveLength(2);
    expect(screen.getByTestId('district-count').textContent).toBe(DE.schedule.districtCount(2, 12));
    // The count is a status, so the change is announced rather than only drawn.
    expect(screen.getByTestId('district-count')).toHaveAttribute('role', 'status');
  });

  it('keeps the official names exactly as published, including the numbered ones', async () => {
    const harness = createHarness();

    await reachDistricts(harness);

    expect(screen.getByRole('button', { name: 'Karthause 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Karthause 2' })).toBeInTheDocument();
  });

  it('reports no match without emptying the count, and recovers when the search is cleared', async () => {
    const harness = createHarness();

    await reachDistricts(harness);

    const search = screen.getByRole('searchbox');

    await userEvent.type(search, 'zzz');

    expect(screen.queryAllByTestId('area-choice')).toHaveLength(0);
    expect(screen.getByText(DE.schedule.noMatches)).toBeInTheDocument();
    expect(screen.getByTestId('district-count').textContent).toBe(DE.schedule.districtCount(0, 12));

    await userEvent.clear(search);

    expect(screen.getAllByTestId('area-choice')).toHaveLength(12);
  });

  it('marks the selected card, leaves the others unmarked, and keeps an unavailable one inert', async () => {
    const harness = createHarness();
    const rendered = await reachDistricts(harness);

    await userEvent.click(screen.getByRole('button', { name: /Stadtmitte/ }));
    rendered.rerender();

    expect(screen.getByRole('button', { name: /Stadtmitte/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Neuendorf' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    const unavailable = screen.getByRole('button', { name: /Horchheim/ });

    expect(unavailable).toBeDisabled();
    expect(screen.getByText(DE.steps.areaUnavailable)).toBeInTheDocument();
    expect(unavailable).toHaveAccessibleDescription(DE.steps.areaUnavailable);
  });
});
