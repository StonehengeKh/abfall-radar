import { ArrowLeft, BellRing, Check, Clock3, MapPin } from 'lucide-react';
import { useState } from 'react';
import { type District, type WasteType, wasteLabels } from '@abfall-radar/domain';
import type { AppSettings } from '@/src/storage/settings';

interface SettingsViewProps {
  districts: District[];
  initialSettings: AppSettings;
  onCancel: () => void;
  onSave: (settings: AppSettings) => Promise<void>;
}

const selectableWasteTypes: WasteType[] = [
  'residual',
  'bio',
  'paper',
  'yellow_bag',
  'green_waste',
  'small_electronics',
];

export const SettingsView = ({
  districts,
  initialSettings,
  onCancel,
  onSave,
}: SettingsViewProps) => {
  const [draft, setDraft] = useState(initialSettings);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const toggleWasteType = (type: WasteType) => {
    const isSelected = draft.visibleWasteTypes.includes(type);
    if (isSelected && draft.visibleWasteTypes.length === 1) {
      return;
    }

    setDraft((current) => ({
      ...current,
      visibleWasteTypes: isSelected
        ? current.visibleWasteTypes.filter((currentType) => currentType !== type)
        : [...current.visibleWasteTypes, type],
    }));
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(null);

    try {
      await onSave(draft);
    } catch {
      setSaveError('Die Einstellungen konnten nicht gespeichert werden. Bitte erneut versuchen.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <main className="min-h-full px-4 pb-4 pt-5 text-ar-text">
      <header className="flex items-center gap-3">
        <button
          type="button"
          className="grid size-11 place-items-center rounded-2xl border border-ar-border bg-ar-surface text-ar-text-muted shadow-ar-sm focus-visible:outline-ar-focus"
          aria-label="Zurück"
          onClick={onCancel}
        >
          <ArrowLeft size={19} />
        </button>
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-ar-brand">
            AbfallRadar
          </p>
          <h1 className="text-lg font-semibold tracking-tight">Einstellungen</h1>
        </div>
      </header>

      <section className="mt-5 rounded-3xl border border-ar-border bg-ar-surface p-4 shadow-ar-sm">
        <label className="flex items-center gap-2 text-sm font-semibold" htmlFor="district">
          <MapPin size={17} className="text-ar-brand" />
          Bezirk
        </label>
        <select
          id="district"
          className="mt-3 min-h-11 w-full rounded-2xl border border-ar-border bg-ar-surface-muted px-3.5 py-3 text-sm font-medium outline-none transition focus:border-ar-brand focus:ring-3 focus:ring-ar-brand-soft"
          value={draft.districtId}
          onChange={(event) =>
            setDraft((current) => ({ ...current, districtId: event.target.value }))
          }
        >
          {districts.map((district) => (
            <option key={district.id} value={district.id}>
              {district.city} · {district.name}
            </option>
          ))}
        </select>
      </section>

      <section className="mt-3 rounded-3xl border border-ar-border bg-ar-surface p-4 shadow-ar-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <BellRing size={17} className="text-ar-brand" />
            <div>
              <p className="text-sm font-semibold">Erinnerungen</p>
              <p className="text-xs text-ar-text-muted">Am Vorabend erinnern</p>
            </div>
          </div>
          <label className="relative inline-flex min-h-11 cursor-pointer items-center">
            <input
              type="checkbox"
              className="peer sr-only"
              checked={draft.remindersEnabled}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  remindersEnabled: event.target.checked,
                }))
              }
            />
            <span className="h-7 w-12 rounded-full bg-ar-border transition peer-checked:bg-ar-brand peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ar-focus after:absolute after:left-1 after:top-3 after:size-5 after:rounded-full after:bg-ar-surface after:shadow-ar-sm after:transition-transform peer-checked:after:translate-x-5" />
            <span className="sr-only">Erinnerungen aktivieren</span>
          </label>
        </div>

        <label className="mt-4 flex items-center gap-2 text-sm font-semibold" htmlFor="time">
          <Clock3 size={17} className="text-ar-brand" />
          Uhrzeit
        </label>
        <select
          id="time"
          className="mt-3 min-h-11 w-full rounded-2xl border border-ar-border bg-ar-surface-muted px-3.5 py-3 text-sm font-medium outline-none transition focus:border-ar-brand focus:ring-3 focus:ring-ar-brand-soft disabled:cursor-not-allowed disabled:opacity-50"
          value={draft.reminderTime}
          disabled={!draft.remindersEnabled}
          onChange={(event) =>
            setDraft((current) => ({ ...current, reminderTime: event.target.value }))
          }
        >
          <option value="17:00">17:00</option>
          <option value="18:00">18:00</option>
          <option value="19:00">19:00</option>
          <option value="20:00">20:00</option>
        </select>
      </section>

      <fieldset className="mt-3 rounded-3xl border border-ar-border bg-ar-surface p-4 shadow-ar-sm">
        <legend className="px-1 text-sm font-semibold">Abfallarten</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {selectableWasteTypes.map((type) => {
            const isSelected = draft.visibleWasteTypes.includes(type);

            return (
              <button
                key={type}
                type="button"
                className={[
                  'inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 py-2 text-xs font-semibold transition focus-visible:outline-ar-focus',
                  isSelected
                    ? 'border-ar-brand bg-ar-brand-soft text-ar-brand-strong'
                    : 'border-ar-border bg-ar-surface text-ar-text-muted',
                ].join(' ')}
                aria-pressed={isSelected}
                onClick={() => toggleWasteType(type)}
              >
                {isSelected && <Check size={13} />}
                {wasteLabels[type]}
              </button>
            );
          })}
        </div>
      </fieldset>

      <button
        type="button"
        className="mt-4 min-h-11 w-full rounded-2xl bg-ar-brand px-4 py-3.5 text-sm font-semibold text-ar-on-brand shadow-ar-brand transition hover:bg-ar-brand-strong focus-visible:outline-ar-focus disabled:cursor-wait disabled:opacity-70"
        disabled={isSaving}
        onClick={() => void handleSave()}
      >
        {isSaving ? 'Wird gespeichert…' : 'Einstellungen speichern'}
      </button>
      {saveError && (
        <p className="mt-3 text-center text-sm text-ar-danger" role="alert">
          {saveError}
        </p>
      )}
    </main>
  );
};
