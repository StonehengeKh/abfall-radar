import type { WasteType } from '@abfall-radar/domain';
import { ArrowLeft, BellRing, Check, Clock3 } from 'lucide-react';
import { type Ref, useId, useState } from 'react';
import { AreaPicker } from '@/src/features/selection/area-picker';
import { PopupHeader } from '@/src/features/shell/popup-header';
import {
  type AreaCatalogueState,
  areasOf,
  type CityCatalogueState,
  type ProviderCatalogueState,
} from '@/src/hooks/use-catalogue';
import { useCopy } from '@/src/i18n/copy';
import type { ServiceAreaSummary } from '@/src/messaging/contract';
import type { ServiceAreaCapabilityEvidence } from '@/src/schedule/capability';
import type { ServiceAreaSelection, SettingsDraft } from '@/src/storage/settings';

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
  /**
   * Everything Settings edits. Language and appearance are not part of it: they are applied the moment they are
   * chosen, from the header, through their own narrow write, so a draft cannot carry a stale copy of them.
   */
  readonly settings: SettingsDraft;
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
  readonly cities: CityCatalogueState;
  readonly catalogue: ProviderCatalogueState;
  /**
   * How far the area request has got, and for which provider.
   *
   * The state rather than a bare list, because a list alone could not say whose areas it held or whether an
   * empty one meant "asked and got none", "not asked yet", or "asked and it failed". Settings reads all
   * three differently: only the last offers a retry, and only the first may be presented as an answer.
   */
  readonly areaStateFor: (providerId: string | null) => AreaCatalogueState;
  readonly initialSettings: SettingsDraft;
  /**
   * The stored selection's city, once derived from successful reads, or `null` until it is.
   *
   * Never guessed: while it is unknown the city field stays empty and the stored selection stays in the draft
   * untouched, so saving reminders or waste types never needs the city at all.
   */
  readonly initialCityId: string | null;
  readonly onRetryCities: () => void;
  readonly onRetryCatalogue: () => void;
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
  cities,
  catalogue,
  areaStateFor,
  initialSettings,
  initialCityId,
  onRetryCities,
  onRetryCatalogue,
  onCancel,
  onSave,
  onRequestAreas,
  onRetryAreas,
  headingRef,
}: SettingsViewProps) => {
  const { messages } = useCopy();
  const [draft, setDraft] = useState<SettingsDraft>(initialSettings);
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
  const timeFieldId = useId();

  const selection: ServiceAreaSelection | null = draft.selection;
  /**
   * Areas of the drafted selection's provider, and of nobody else — the list the evidence below is read from.
   *
   * `areasOf` answers from the state's own provider rather than by filtering a list that might belong to
   * someone else, so an identifier cannot be carried across providers even if the state on hand is stale.
   */
  const draftAreas = areasOf(
    areaStateFor(selection?.providerId ?? null),
    selection?.providerId ?? null,
  );

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
        setSaveError(messages.settings.conflict);

        return;
      }

      // Refused by the repository. The view stays open and the previously stored value is untouched.
      setSaveError(
        outcome === 'rejected_unavailable'
          ? messages.selectionErrors.rejectedUnavailable
          : messages.settings.saveFailed,
      );
    } catch {
      setSaveError(messages.settings.saveFailed);
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
      setAreaError(messages.selectionErrors.rejectedUnavailable);

      return;
    }

    setDraft((current) => ({
      ...current,
      selection: { providerId: area.providerId, serviceAreaId: area.id },
    }));
  };

  /** A changed city or operator clears only the drafted district; nothing is persisted until Save. */
  const handleResetArea = () => {
    setAreaError(null);
    setSaveError(null);
    setDraft((current) => ({ ...current, selection: null }));
  };

  return (
    <main className="min-h-full px-4 pb-4 pt-4 text-ar-text">
      <PopupHeader
        leading={
          <button
            type="button"
            className="relative grid size-9 place-items-center rounded-full border border-ar-border bg-ar-surface text-ar-text transition-colors after:absolute after:-inset-[5px] after:content-[''] hover:bg-ar-surface-muted focus-visible:outline-ar-focus motion-reduce:transition-none"
            aria-label={messages.header.back}
            onClick={onCancel}
          >
            <ArrowLeft size={17} aria-hidden="true" className="rtl:rotate-180" />
          </button>
        }
      />
      {/*
        `tabIndex={-1}` makes the heading programmatically focusable without adding it to the tab order: a
        heading is not focusable by default, so moving focus here would otherwise do nothing at all.
      */}
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="mt-4 text-lg font-semibold tracking-tight break-words outline-none"
      >
        {messages.settings.heading}
      </h1>

      <AreaPicker
        cities={cities}
        catalogue={catalogue}
        areaStateFor={areaStateFor}
        initialCityId={initialCityId}
        initialProviderId={initialSettings.selection?.providerId ?? null}
        chosenAreaId={selection?.serviceAreaId ?? null}
        onChooseArea={handleSelectArea}
        onResetArea={handleResetArea}
        onRetryCities={onRetryCities}
        onRetryCatalogue={onRetryCatalogue}
        onRequestAreas={onRequestAreas}
        onRetryAreas={onRetryAreas}
      >
        {areaError !== null && (
          <p className="mt-3 text-sm text-ar-danger" role="alert">
            {areaError}
          </p>
        )}
      </AreaPicker>

      <section className="mt-3 rounded-ar-xl border border-ar-border bg-ar-surface p-4 shadow-ar-sm">
        {/*
          Wrapping, not fixed: the switch is sized in `rem`, so at 200 % text it is as wide as a phone's
          margin allows and the label beside it no longer fits on one line. The row becomes two rows rather
          than pushing the popup sideways.
        */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <BellRing size={17} className="shrink-0 text-ar-brand" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-semibold break-words">{messages.settings.reminders}</p>
              <p className="text-xs break-words text-ar-text-muted">
                {messages.settings.remindersDescription}
              </p>
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
            <span className="sr-only">{messages.settings.remindersToggle}</span>
          </label>
        </div>

        <label className="mt-4 flex items-center gap-2 text-sm font-semibold" htmlFor={timeFieldId}>
          <Clock3 size={17} className="text-ar-brand" />
          {messages.settings.reminderTime}
        </label>
        <select
          id={timeFieldId}
          className="mt-3 min-h-11 w-full rounded-ar-md border border-ar-border bg-ar-surface-muted px-3.5 py-3 text-sm font-medium outline-none transition focus:border-ar-brand focus:ring-3 focus:ring-ar-brand-soft disabled:cursor-not-allowed disabled:opacity-50"
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

      <fieldset className="mt-3 min-w-0 rounded-ar-xl border border-ar-border bg-ar-surface p-4 shadow-ar-sm">
        <legend className="px-1 text-sm font-semibold">{messages.settings.wasteTypes}</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {selectableWasteTypes.map((type) => {
            const isSelected = draft.visibleWasteTypes.includes(type);

            return (
              <button
                key={type}
                type="button"
                className={[
                  // `max-w-full` with `break-words`, because a waste type is one long compound word in
                  // German: at 200 % text `Elektrokleinteile` is wider than a 320 px popup, and a chip that
                  // cannot break it would push the whole page sideways.
                  'inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full border px-3 py-2 text-start text-xs font-semibold break-words transition focus-visible:outline-ar-focus motion-reduce:transition-none',
                  isSelected
                    ? 'border-ar-brand bg-ar-brand-soft text-ar-brand-strong'
                    : 'border-ar-border bg-ar-surface text-ar-text-muted',
                ].join(' ')}
                aria-pressed={isSelected}
                onClick={() => toggleWasteType(type)}
              >
                {isSelected && <Check size={13} />}
                {messages.waste[type]}
              </button>
            );
          })}
        </div>
      </fieldset>

      <button
        type="button"
        className="mt-4 min-h-11 w-full rounded-ar-md bg-ar-brand px-4 py-3.5 text-sm font-semibold text-ar-on-brand shadow-ar-brand transition hover:bg-ar-brand-strong focus-visible:outline-ar-focus disabled:cursor-wait disabled:opacity-70"
        disabled={isSaving}
        onClick={() => void handleSave()}
      >
        {isSaving ? messages.settings.saving : messages.settings.save}
      </button>
      {saveError && (
        <p className="mt-3 text-center text-sm text-ar-danger" role="alert">
          {saveError}
        </p>
      )}
    </main>
  );
};
