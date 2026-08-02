import { type WasteType, wasteLabels } from '@abfall-radar/domain';
import { ArrowLeft, BellRing, Check, Clock3, MapPin } from 'lucide-react';
import { type Ref, useEffect, useId, useState } from 'react';
import { AreaStatePanel } from '@/src/features/areas/area-state-panel';
import {
  type AreaCatalogueState,
  areaStateProviderId,
  areasOf,
  offerableProviders,
} from '@/src/hooks/use-catalogue';
import type { ProviderSummary, ServiceAreaSummary } from '@/src/messaging/contract';
import type { ServiceAreaCapabilityEvidence } from '@/src/schedule/capability';
import type { AppSettings, ServiceAreaSelection } from '@/src/storage/settings';

/**
 * Settings is transactional.
 *
 * Opening it creates a local draft, and **nothing** reaches storage until Save. Changing the provider, the
 * area, the waste types, or the reminder settings edits the draft only, so Back discards the whole edit and
 * leaves the previously persisted value exactly as it was. Saving persists the complete value through the
 * repository as one logical operation rather than as a sequence of partial writes.
 *
 * The onboarding surface is deliberately different: confirming there *is* the explicit act of choosing, so
 * it persists immediately.
 */
export type SettingsSaveOutcome =
  | 'persisted'
  /**
   * The selection changed after this draft was created, so nothing was written.
   *
   * Not a failure: a reminder discovered the area was withdrawn, or another window chose a different one, and
   * either is newer and more authoritative than the draft. The surface adopts the current value and asks the
   * person to look again.
   */
  | 'conflict'
  | 'rejected_unavailable'
  | 'rejected_unknown_capability';

export interface SettingsSaveInput {
  readonly settings: AppSettings;
  /**
   * The current capability of the drafted area, **naming the area it was read for**, so the repository can refuse
   * an unavailable one — and refuse one that describes a different area altogether.
   */
  readonly evidence?: ServiceAreaCapabilityEvidence | undefined;
  /**
   * The selection that was stored when this draft was created.
   *
   * Sent with the save so the owner can refuse a stale draft. A Settings session stays open while a person edits,
   * and both a reminder clearing a withdrawn area and another window choosing a different one are newer than the
   * draft — writing it anyway would resurrect the first or overwrite the second.
   */
  readonly expectedSelection: ServiceAreaSelection | null;
}

export interface SettingsViewProps {
  readonly providers: readonly ProviderSummary[];
  /**
   * How far the area request has got, and for which provider.
   *
   * The state rather than a bare list, because a list alone could not say whose areas it held or whether an
   * empty one meant "asked and got none", "not asked yet", or "asked and it failed". Settings reads all
   * three differently: only the last offers a retry, and only the first may be presented as an answer.
   */
  readonly areaState: AreaCatalogueState;
  readonly initialSettings: AppSettings;
  readonly onCancel: () => void;
  /** Persists the whole value in one operation and reports what the repository decided. */
  readonly onSave: (input: SettingsSaveInput) => Promise<SettingsSaveOutcome>;
  /** Loads the areas of a provider, once. Reads only; it persists nothing. */
  readonly onRequestAreas: (providerId: string) => void;
  /** Starts one more area attempt after a failure. Reachable only from the failed state. */
  readonly onRetryAreas: (providerId: string) => void;
  /**
   * The heading, exposed so focus can be moved here when Settings opens.
   *
   * Opening Settings replaces the whole surface, so focus falls back to `<body>` and the next Tab restarts from
   * the top of the document. Moving it to the heading announces the screen a person has arrived on and continues
   * their keyboard journey from there.
   */
  readonly headingRef?: Ref<HTMLHeadingElement> | undefined;
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
  providers,
  areaState,
  initialSettings,
  onCancel,
  onSave,
  onRequestAreas,
  onRetryAreas,
  headingRef,
}: SettingsViewProps) => {
  const [draft, setDraft] = useState(initialSettings);
  /**
   * Captured once, when the draft is created, and never updated for the life of this session.
   *
   * It is the *premise* of the draft rather than a live value: the whole point is to detect that the stored
   * selection has moved on since. Refreshing it would defeat the check entirely.
   */
  const [expectedSelection] = useState<ServiceAreaSelection | null>(initialSettings.selection);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [areaError, setAreaError] = useState<string | null>(null);
  /**
   * The provider being edited, tracked separately from the drafted area.
   *
   * Deriving it from `draft.selection` would make the controlled select fall back to its placeholder the
   * moment the provider changes — because choosing a provider clears the drafted area — so the field would
   * appear to reset itself while the new provider's areas were still loading.
   */
  const [draftProviderId, setDraftProviderId] = useState<string | null>(
    initialSettings.selection?.providerId ?? null,
  );
  const providerFieldId = useId();
  const areaLabelId = useId();
  const unavailableHintId = useId();
  const timeFieldId = useId();

  const selection: ServiceAreaSelection | null = draft.selection;
  const offered = offerableProviders(providers);
  /**
   * Areas of the provider being edited, and of nobody else.
   *
   * `areasOf` answers from the state's own provider rather than by filtering a list that might belong to
   * someone else, so an identifier cannot be carried across providers even if the state on hand is stale.
   */
  const draftAreas = areasOf(areaState, draftProviderId);

  /**
   * Asks for the edited provider's areas whenever the state on hand is about someone else.
   *
   * Cancelling a provider change discards the draft but not the areas that change loaded, so reopening
   * Settings can arrive with another provider's state. Without this the area list would stay empty forever,
   * because the surrounding catalogue only fetches for the *stored* provider. Requesting here keeps the view
   * correct whatever it is handed.
   *
   * It cannot loop: once the request is in flight, or has answered, or has failed, the state names this
   * provider and the condition is false. A failure is therefore not retried here — that is
   * `onRetryAreas`, which a person triggers.
   */
  useEffect(() => {
    if (draftProviderId !== null && areaStateProviderId(areaState) !== draftProviderId) {
      onRequestAreas(draftProviderId);
    }
  }, [areaState, draftProviderId, onRequestAreas]);

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

  /**
   * The capability of the drafted area, carrying the identity it was read for.
   *
   * Built from the found area's **own** `providerId` and `id` rather than from the drafted selection, which is
   * what makes it evidence rather than an assertion: a list shown for one provider could contain an area id that
   * also exists under another, and lifting a bare availability flag out of it would have confirmed the drafted
   * area on a different one's calendar. The repository compares the two identities and writes nothing on a
   * mismatch.
   */
  const draftEvidence: ServiceAreaCapabilityEvidence | undefined = (() => {
    if (selection === null) {
      return undefined;
    }

    const area = draftAreas.find((candidate) => candidate.id === selection.serviceAreaId);

    return area === undefined
      ? undefined
      : {
          providerId: area.providerId,
          serviceAreaId: area.id,
          collectionEvents: area.collectionEvents,
        };
  })();

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(null);

    try {
      // One operation: the complete value, checked against the drafted area's current capability. Never a
      // selection write followed by a settings write, which would leave storage half-changed on a failure.
      const outcome = await onSave({
        settings: draft,
        evidence: draftEvidence,
        expectedSelection,
      });

      if (outcome === 'persisted') {
        return;
      }

      if (outcome === 'conflict') {
        /**
         * The stored selection moved on while this draft was open, so nothing was written.
         *
         * Its own copy, because it is not a failure and the generic retry message would be misleading: pressing
         * Save again would be refused for the same reason. The person has to look at what changed, which is why
         * the surface tells them to reopen rather than offering to try again.
         */
        setSaveError(
          'Das gespeicherte Sammelgebiet hat sich zwischenzeitlich geändert. Die Einstellungen wurden nicht gespeichert. Bitte schließe die Einstellungen und prüfe die Auswahl erneut.',
        );

        return;
      }

      // Refused by the repository. The view stays open and the previously stored value is untouched.
      setSaveError(
        outcome === 'rejected_unavailable'
          ? 'Für dieses Gebiet veröffentlicht der Entsorgungsbetrieb keinen offiziellen Kalender.'
          : 'Die Einstellungen konnten nicht gespeichert werden. Bitte erneut versuchen.',
      );
    } catch {
      setSaveError('Die Einstellungen konnten nicht gespeichert werden. Bitte erneut versuchen.');
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Edits the draft only. Nothing is persisted until Save, so this is not a confirmation.
   *
   * The unavailable capability is still checked here, because the disabled control is appearance and keyboard
   * behavior rather than a guarantee — and the repository checks it again independently at Save.
   */
  const handleSelectArea = (area: ServiceAreaSummary) => {
    setAreaError(null);
    setSaveError(null);

    if (area.collectionEvents.availability === 'unavailable') {
      setAreaError(
        'Für dieses Gebiet veröffentlicht der Entsorgungsbetrieb keinen offiziellen Kalender.',
      );

      return;
    }

    setDraft((current) => ({
      ...current,
      selection: { providerId: area.providerId, serviceAreaId: area.id },
    }));
  };

  const handleSelectProvider = (providerId: string) => {
    setAreaError(null);
    setSaveError(null);
    setDraftProviderId(providerId === '' ? null : providerId);
    // Only the drafted area is cleared. The persisted selection is untouched until Save, and an identifier is
    // never carried across providers.
    setDraft((current) => ({ ...current, selection: null }));

    if (providerId !== '') {
      onRequestAreas(providerId);
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
          {/*
            `tabIndex={-1}` makes the heading programmatically focusable without adding it to the tab order: a
            heading is not focusable by default, so moving focus here would otherwise do nothing at all.
          */}
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-lg font-semibold tracking-tight outline-none"
          >
            Einstellungen
          </h1>
        </div>
      </header>

      <section className="mt-5 rounded-3xl border border-ar-border bg-ar-surface p-4 shadow-ar-sm">
        <label className="flex items-center gap-2 text-sm font-semibold" htmlFor={providerFieldId}>
          <MapPin size={17} className="text-ar-brand" />
          Entsorgungsbetrieb
        </label>
        <select
          id={providerFieldId}
          className="mt-3 min-h-11 w-full rounded-2xl border border-ar-border bg-ar-surface-muted px-3.5 py-3 text-sm font-medium outline-none transition focus:border-ar-brand focus:ring-3 focus:ring-ar-brand-soft"
          // Bound to the draft provider, so it keeps showing the chosen provider while its areas load.
          value={draftProviderId ?? ''}
          onChange={(event) => handleSelectProvider(event.target.value)}
        >
          <option value="" disabled>
            Bitte wählen
          </option>
          {offered.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </select>

        {draftAreas.length > 0 && (
          <>
            <p className="mt-4 text-sm font-semibold" id={areaLabelId}>
              Sammelgebiet
            </p>
            <p className="sr-only" id={unavailableHintId}>
              Für dieses Gebiet veröffentlicht der Entsorgungsbetrieb keinen offiziellen Kalender.
            </p>
            <ul className="mt-2 space-y-2" aria-labelledby={areaLabelId}>
              {draftAreas.map((area) => {
                const isUnavailable = area.collectionEvents.availability === 'unavailable';
                const isSelected = area.id === selection?.serviceAreaId;

                return (
                  <li key={area.id}>
                    <button
                      type="button"
                      // Genuinely disabled: not operable by pointer or keyboard, out of the tab order, and
                      // announced as unavailable. Appearance is never the mechanism.
                      disabled={isUnavailable}
                      aria-pressed={isSelected}
                      aria-describedby={isUnavailable ? unavailableHintId : undefined}
                      className={[
                        'flex min-h-11 w-full items-start gap-2 rounded-2xl border px-3.5 py-3 text-left transition focus-visible:outline-ar-focus',
                        isSelected
                          ? 'border-ar-brand bg-ar-brand-soft text-ar-brand-strong'
                          : 'border-ar-border bg-ar-surface',
                        isUnavailable ? 'cursor-not-allowed opacity-70' : '',
                      ].join(' ')}
                      onClick={() => handleSelectArea(area)}
                    >
                      {isSelected && <Check size={15} className="mt-0.5 shrink-0" />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">
                          {area.locality} · {area.name}
                        </span>
                        {isUnavailable && (
                          <span className="mt-0.5 block text-xs text-ar-text-muted">
                            Kein offizieller Kalender veröffentlicht
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {/*
          Every area-request state, including the failure and its retry. The area list above renders only a
          successful, non-empty answer, so without this the other four states would be an empty panel that
          reads as a request still running.
        */}
        <AreaStatePanel state={areaState} providerId={draftProviderId} onRetry={onRetryAreas} />

        {areaError !== null && (
          <p className="mt-3 text-sm text-ar-danger" role="alert">
            {areaError}
          </p>
        )}
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

        <label className="mt-4 flex items-center gap-2 text-sm font-semibold" htmlFor={timeFieldId}>
          <Clock3 size={17} className="text-ar-brand" />
          Uhrzeit
        </label>
        <select
          id={timeFieldId}
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
