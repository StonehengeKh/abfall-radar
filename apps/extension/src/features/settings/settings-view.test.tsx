import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { District } from '@abfall-radar/domain';
import type { AppSettings } from '@/src/storage/settings';
import { SettingsView } from './settings-view';

const districts: District[] = [
  {
    id: 'demo-district',
    city: 'Demo City',
    name: 'Central',
    providerId: 'demo',
  },
];

const settings: AppSettings = {
  districtId: 'demo-district',
  remindersEnabled: true,
  reminderDaysBefore: 1,
  reminderTime: '18:00',
  visibleWasteTypes: ['paper'],
};

describe('SettingsView', () => {
  it('recovers when settings cannot be saved', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(new Error('Storage unavailable'));

    render(
      <SettingsView
        districts={districts}
        initialSettings={settings}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );

    const saveButton = screen.getByRole('button', { name: 'Einstellungen speichern' });
    await user.click(saveButton);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Die Einstellungen konnten nicht gespeichert werden.',
    );
    expect(saveButton).toBeEnabled();
  });
});
