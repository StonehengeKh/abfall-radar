/**
 * Calendar dates must render as the same calendar date on every device.
 *
 * A `YYYY-MM-DD` from the API is a calendar date, not an instant. It is read as UTC midnight, so a
 * formatter left on the device zone renders that midnight in local time and shifts the date backwards for
 * every zone west of UTC: `2026-03-01` appears as 28 February in New York. That is a wrong collection date
 * shown confidently, which is the class of error this project exists to avoid.
 *
 * The process zone is pinned **before** the component module is imported, because its formatters are
 * created at module load. The assignment therefore has to precede the import, which is why this lives in
 * its own file and uses a dynamic import rather than a static one.
 */
process.env.TZ = 'America/New_York';

const { render, screen } = await import('@testing-library/react');
const { describe, expect, it, vi } = await import('vitest');
const { deriveScheduleView } = await import('@/src/schedule/view-state');
const { curbsideEvent, restoredSchedule, schedule } = await import('@/src/test/fixtures');
const { DashboardView } = await import('./dashboard-view');

const referenceDate = new Date('2026-03-09T10:00:00Z');

const renderView = (view: Parameters<typeof DashboardView>[0]['view']) => {
  render(
    <DashboardView
      view={view}
      visibleWasteTypes={['paper']}
      onOpenSettings={vi.fn()}
      onRetry={vi.fn()}
      referenceDate={referenceDate}
    />,
  );
};

describe('in a device zone west of UTC', () => {
  it('really is running west of UTC, so the assertions below are not vacuous', () => {
    // Without this, a runtime that ignored the pinned zone would make every test here pass for the wrong
    // reason: UTC midnight would simply format as the same date.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/New_York');
    expect(new Date('2026-03-01T00:00:00Z').getDate()).toBe(28);
  });

  it('renders a calendar date as that date, not as the previous day', () => {
    renderView(
      deriveScheduleView({
        hasSelection: true,
        phase: {
          kind: 'succeeded',
          schedule: schedule({
            events: [curbsideEvent('2026-03-10')],
            servedRange: { from: '2026-03-01', to: '2026-05-30' },
          }),
        },
      }),
    );

    const period = screen.getByText(/^Zeitraum/);

    expect(period).toHaveTextContent('01.03.2026');
    expect(period).not.toHaveTextContent('28.02.2026');
  });

  it('renders the end of a range as that date', () => {
    renderView(
      deriveScheduleView({
        hasSelection: true,
        phase: {
          kind: 'succeeded',
          schedule: schedule({
            events: [curbsideEvent('2026-03-10')],
            servedRange: { from: '2026-03-01', to: '2026-06-01' },
          }),
        },
      }),
    );

    expect(screen.getByText(/^Zeitraum/)).toHaveTextContent('01.06.2026');
  });

  it('states the partial-cache end date without shifting it', () => {
    renderView(
      deriveScheduleView({
        hasSelection: true,
        restored: restoredSchedule({
          events: [curbsideEvent('2026-03-10')],
          rangeCoverage: 'partial',
          displayRange: { from: '2026-03-01', to: '2026-05-01' },
        }),
        phase: { kind: 'failed', failure: { kind: 'network', operation: 'listCollectionEvents' } },
      }),
    );

    expect(screen.getByText(/reichen nur bis zum/)).toHaveTextContent('01.05.2026');
  });

  it('states an empty covered period without shifting either bound', () => {
    renderView(
      deriveScheduleView({
        hasSelection: true,
        phase: {
          kind: 'succeeded',
          schedule: schedule({ events: [], servedRange: { from: '2026-03-01', to: '2026-05-01' } }),
        },
      }),
    );

    const description = screen.getByText(/keine passende Abholung/);

    expect(description).toHaveTextContent('01.03.2026');
    expect(description).toHaveTextContent('01.05.2026');
    expect(description).not.toHaveTextContent('28.02.2026');
  });

  it('still shows a retrieval timestamp in the device zone, because an instant is not a calendar date', () => {
    renderView(
      deriveScheduleView({
        hasSelection: true,
        phase: {
          kind: 'succeeded',
          schedule: schedule({
            events: [curbsideEvent('2026-03-10')],
            retrievedAt: '2026-03-01T02:00:00.000Z',
          }),
        },
      }),
    );

    // 02:00 UTC is 21:00 on 28 February in New York. That is correct for an instant and must not be
    // "fixed" to UTC: a reader wants to know when it was retrieved in their own time.
    expect(screen.getByText(/Aktuell abgerufen am/)).toHaveTextContent('28.02.2026');
  });
});

describe('relative day labels', () => {
  /**
   * A relative label answers "which day is this, relative to today" — and for an official collection date,
   * today means today in the **source's** zone.
   *
   * At 23:30 UTC the device (New York) is still on 1 March while Berlin has moved to the 2nd. The domain helper
   * compares against the device day, so the same collection would read "Morgen" here and "Heute" in Berlin.
   */
  const AT_BERLIN_MIDNIGHT_CROSSING = new Date('2026-03-01T23:30:00Z');

  const renderAt = (reference: Date, events: ReturnType<typeof curbsideEvent>[]) => {
    render(
      <DashboardView
        view={deriveScheduleView({
          hasSelection: true,
          phase: {
            kind: 'succeeded',
            schedule: schedule({ events, servedRange: { from: '2026-03-01', to: '2026-05-30' } }),
          },
        })}
        visibleWasteTypes={['paper']}
        onOpenSettings={vi.fn()}
        onRetry={vi.fn()}
        referenceDate={reference}
      />,
    );
  };

  it('confirms the device and the source disagree at this instant', () => {
    // 1 March in New York, already 2 March in Berlin.
    expect(new Date(AT_BERLIN_MIDNIGHT_CROSSING).getDate()).toBe(1);
    expect(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(
        AT_BERLIN_MIDNIGHT_CROSSING,
      ),
    ).toContain('03-02');
  });

  it('labels the source’s today as Heute, not Morgen', () => {
    renderAt(AT_BERLIN_MIDNIGHT_CROSSING, [curbsideEvent('2026-03-02')]);

    expect(screen.getByText('Heute')).toBeInTheDocument();
    expect(screen.queryByText('Morgen')).not.toBeInTheDocument();
  });

  it('labels the source’s tomorrow as Morgen', () => {
    renderAt(AT_BERLIN_MIDNIGHT_CROSSING, [curbsideEvent('2026-03-03')]);

    expect(screen.getByText('Morgen')).toBeInTheDocument();
  });

  it('labels the device’s today as a past-free relative day rather than Heute', () => {
    // 1 March is yesterday for the source, so it is neither Heute nor Morgen.
    renderAt(AT_BERLIN_MIDNIGHT_CROSSING, [curbsideEvent('2026-03-01')]);

    expect(screen.queryByText('Heute')).not.toBeInTheDocument();
    expect(screen.queryByText('Morgen')).not.toBeInTheDocument();
  });

  it('labels a later event relative to the source day too', () => {
    renderAt(AT_BERLIN_MIDNIGHT_CROSSING, [
      curbsideEvent('2026-03-02'),
      curbsideEvent('2026-03-04'),
    ]);

    // Two days after the source's today, listed under "Danach".
    expect(screen.getByText('In 2 Tagen')).toBeInTheDocument();
  });

  it('falls back to a short date beyond a week, formatted as a calendar date', () => {
    renderAt(AT_BERLIN_MIDNIGHT_CROSSING, [curbsideEvent('2026-03-20')]);

    // Read as UTC midnight and formatted in UTC, so the weekday and day never shift.
    expect(screen.getByText(/20\. März|20\. Mär/)).toBeInTheDocument();
  });

  it('gives the same label east of UTC for the same instant', () => {
    // Tokyo is already 2 March here as well, and so is Berlin: the source decides, so the label is identical.
    process.env.TZ = 'Asia/Tokyo';

    renderAt(AT_BERLIN_MIDNIGHT_CROSSING, [curbsideEvent('2026-03-02')]);

    expect(screen.getByText('Heute')).toBeInTheDocument();

    process.env.TZ = 'America/New_York';
  });
});
