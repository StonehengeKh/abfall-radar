import { useCallback, useEffect, useState } from 'react';
import {
  type AppSettings,
  AppSettingsSchema,
  appSettingsItem,
  defaultSettings,
  resolveSettings,
  updateSettings,
} from '@/src/storage/settings';

export const useSettings = () => {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    let isActive = true;

    void appSettingsItem.getValue().then((storedSettings) => {
      if (!isActive) {
        return;
      }

      setSettings(resolveSettings(storedSettings));
      setIsHydrated(true);
    });

    const unwatch = appSettingsItem.watch((nextSettings) => {
      setSettings(resolveSettings(nextSettings));
    });

    return () => {
      isActive = false;
      unwatch();
    };
  }, []);

  const saveSettings = useCallback(async (nextSettings: AppSettings) => {
    const parsedSettings = AppSettingsSchema.parse(nextSettings);
    setSettings(parsedSettings);
    await updateSettings(parsedSettings);
  }, []);

  return {
    isHydrated,
    saveSettings,
    settings,
  };
};
