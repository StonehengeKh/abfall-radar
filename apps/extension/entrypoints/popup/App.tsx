import { useMemo, useState } from 'react';
import { createDemoSchedule, demoDistricts } from '@abfall-radar/data-providers';
import { getUpcomingEvents } from '@abfall-radar/domain';
import { DashboardView } from '@/src/features/dashboard/dashboard-view';
import { SettingsView } from '@/src/features/settings/settings-view';
import { useSettings } from '@/src/hooks/use-settings';

function App() {
  const [screen, setScreen] = useState<'dashboard' | 'settings'>('dashboard');
  const { isHydrated, saveSettings, settings } = useSettings();

  const district =
    demoDistricts.find((currentDistrict) => currentDistrict.id === settings.districtId) ??
    demoDistricts[0];

  const events = useMemo(
    () =>
      getUpcomingEvents(createDemoSchedule(settings.districtId)).filter((event) =>
        settings.visibleWasteTypes.includes(event.type),
      ),
    [settings.districtId, settings.visibleWasteTypes],
  );

  if (!isHydrated || !district) {
    return (
      <div className="grid min-h-[520px] place-items-center px-6 text-center text-sm text-ar-text-muted">
        <div>
          <div className="mx-auto size-9 animate-pulse rounded-2xl bg-ar-brand" />
          <p className="mt-3">AbfallRadar wird vorbereitet…</p>
        </div>
      </div>
    );
  }

  if (screen === 'settings') {
    return (
      <SettingsView
        districts={demoDistricts}
        initialSettings={settings}
        onCancel={() => setScreen('dashboard')}
        onSave={async (nextSettings) => {
          await saveSettings(nextSettings);
          setScreen('dashboard');
        }}
      />
    );
  }

  return (
    <DashboardView
      district={district}
      events={events}
      onOpenSettings={() => setScreen('settings')}
    />
  );
}

export default App;
