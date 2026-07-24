import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createDemoSchedule, demoDistricts } from '@abfall-radar/data-providers';
import { getUpcomingEvents } from '@abfall-radar/domain';
import { DashboardView } from './dashboard-view';

const referenceDate = new Date('2026-07-23T10:00:00');

describe('DashboardView', () => {
  it('shows the next collection and opens settings', async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    const district = demoDistricts[0];

    if (!district) {
      throw new Error('Demo district is required for this test.');
    }

    render(
      <DashboardView
        district={district}
        events={getUpcomingEvents(createDemoSchedule(district.id, referenceDate), referenceDate)}
        onOpenSettings={onOpenSettings}
        referenceDate={referenceDate}
      />,
    );

    expect(screen.getByText('Morgen')).toBeInTheDocument();
    expect(screen.getByText('Gelber Sack')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Einstellungen öffnen' }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});
