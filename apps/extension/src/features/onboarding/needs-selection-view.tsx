import { BrandMark } from '@abfall-radar/ui';
import { Check, MapPin, RotateCcw } from 'lucide-react';
import { type Ref, useId, useState } from 'react';
import { AreaStatePanel } from '@/src/features/areas/area-state-panel';
import {
  type AreaCatalogueState,
  areaStateProviderId,
  areasOf,
  offerableProviders,
} from '@/src/hooks/use-catalogue';
import type {
  ProviderSummary,
  SelectionWriteOutcomeKind,
  ServiceAreaSummary,
} from '@/src/messaging/contract';

/**
 * The needs-selection surface.
 *
 * Its own small surface rather than a mode flag on the settings view: nothing is preselected, persisted,
 * or fetched on the user's behalf, so choosing an area is a distinct thing a person does once.
 *
 * A provider whose `sourceKind` is `demo` is filtered out **at the catalogue**, so none of its areas is
 * ever listed, reachable, or rendered here. That exclusion is stronger than unselectability and happens
 * earlier, which is why a demo area's capability is never what a user sees.
 *
 * Confirming is the one act on this surface that writes, and it is treated as one: awaited, reported, and
 * recoverable. A storage write can be refused or can fail, and a surface that navigated away regardless would
 * have accepted a choice it never stored.
 */

export interface NeedsSelectionViewProps {
  readonly providers: readonly ProviderSummary[];
  readonly areaState: AreaCatalogueState;
  /** True while the provider catalogue itself is in flight. */
  readonly isCatalogueLoading: boolean;
  readonly errorMessage?: string | undefined;
  /**
   * Reads the provider catalogue again.
   *
   * The error message alone left a person with nothing to do but close and reopen the popup: the catalogue is
   * read once on mount, so the surface that reported the failure could not ask for another attempt.
   */
  readonly onRetryCatalogue: () => void;
  readonly onRequestAreas: (providerId: string) => void;
  /** Starts one more area attempt after a failure. Reachable only from the failed state. */
  readonly onRetryAreas: (providerId: string) => void;
  /** Persists the confirmed area and reports what the repository decided. */
  readonly onConfirm: (area: ServiceAreaSummary) => Promise<ConfirmSelectionOutcome>;
  /**
   * The heading, exposed so focus can be moved here when this surface replaces another.
   *
   * Arriving here is always the end of a transition — a withdrawn area being discarded, or a first run — and the
   * element a person was focused on has been unmounted by it. Without a target, focus falls back to `<body>`.
   */
  readonly headingRef?: Ref<HTMLHeadingElement> | undefined;
}

/**
 * What confirming an area can answer with.
 *
 * Narrower than the draft-save vocabulary on purpose: this surface sends a selection intent, which carries no draft
 * and therefore cannot be stale, so `conflict` would be unreachable copy here.
 */
export type ConfirmSelectionOutcome = SelectionWriteOutcomeKind;

const confirmErrorCopy: Record<Exclude<ConfirmSelectionOutcome, 'persisted'>, string> = {
  rejected_unavailable:
    'Für dieses Gebiet veröffentlicht der Entsorgungsbetrieb keinen offiziellen Kalender.',
  rejected_unknown_capability:
    'Das Gebiet konnte nicht geprüft werden. Bitte erneut versuchen, sobald die Verbindung steht.',
};

const STORAGE_ERROR =
  'Die Auswahl konnte nicht gespeichert werden. Bitte erneut versuchen.' as const;

export const NeedsSelectionView = ({
  providers,
  areaState,
  isCatalogueLoading,
  errorMessage,
  onRetryCatalogue,
  onRequestAreas,
  onRetryAreas,
  onConfirm,
  headingRef,
}: NeedsSelectionViewProps) => {
  const [chosenAreaId, setChosenAreaId] = useState<string | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const providerLabelId = useId();
  const areaLabelId = useId();
  const unavailableHintId = useId();

  const offered = offerableProviders(providers);
  const selectedProviderId = areaStateProviderId(areaState);
  const areas = areasOf(areaState, selectedProviderId);
  const chosenArea = areas.find((area) => area.id === chosenAreaId);

  /**
   * Awaits the write, then reports.
   *
   * Guarded against a second submission rather than relying on the disabled attribute alone: a double
   * activation would otherwise start two writes for one choice. The attempted area stays chosen on a failure,
   * so retrying is one press rather than a re-selection.
   */
  const handleConfirm = async () => {
    if (chosenArea === undefined || isConfirming) {
      return;
    }

    setIsConfirming(true);
    setConfirmError(null);

    try {
      const outcome = await onConfirm(chosenArea);

      if (outcome !== 'persisted') {
        setConfirmError(confirmErrorCopy[outcome]);
      }
    } catch {
      // Nothing about the error is surfaced: it could name an internal storage path.
      setConfirmError(STORAGE_ERROR);
    } finally {
      setIsConfirming(false);
    }
  };

  return (
    <main className="min-h-full px-4 pb-4 pt-5 text-ar-text">
      <header className="flex items-center gap-3">
        <BrandMark />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-ar-brand">
            AbfallRadar
          </p>
          {/* Programmatically focusable, never a stop in the tab order. */}
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="truncate text-lg font-semibold tracking-tight outline-none"
          >
            Sammelgebiet wählen
          </h1>
        </div>
      </header>

      <p className="mt-4 text-sm text-ar-text-muted">
        Wähle den Entsorgungsbetrieb und dein Sammelgebiet. Erst danach werden offizielle Termine
        geladen.
      </p>

      <section className="mt-4 rounded-3xl border border-ar-border bg-ar-surface p-4 shadow-ar-sm">
        <label className="flex items-center gap-2 text-sm font-semibold" htmlFor={providerLabelId}>
          <MapPin size={17} className="text-ar-brand" />
          Entsorgungsbetrieb
        </label>
        <select
          id={providerLabelId}
          className="mt-3 min-h-11 w-full rounded-2xl border border-ar-border bg-ar-surface-muted px-3.5 py-3 text-sm font-medium outline-none transition focus:border-ar-brand focus:ring-3 focus:ring-ar-brand-soft"
          value={selectedProviderId ?? ''}
          onChange={(event) => {
            // Changing the provider clears the area, so an identifier is never carried across providers.
            setChosenAreaId(null);
            setConfirmError(null);

            if (event.target.value !== '') {
              onRequestAreas(event.target.value);
            }
          }}
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

        {isCatalogueLoading && (
          <p className="mt-3 text-sm text-ar-text-muted">Daten werden geladen…</p>
        )}

        {errorMessage !== undefined && (
          <>
            <p className="mt-3 text-sm text-ar-danger" role="alert">
              {errorMessage}
            </p>
            {/*
              The catalogue is read once on mount, so without this the only way out of a failed read was to
              close and reopen the popup. It retries the catalogue itself rather than anything downstream:
              there is no confirmed provider yet, so there is nothing else to retry.
            */}
            <button
              type="button"
              className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-2xl border border-ar-border bg-ar-surface px-3.5 py-2 text-sm font-semibold transition hover:border-ar-text-muted focus-visible:outline-ar-focus"
              onClick={onRetryCatalogue}
            >
              <RotateCcw size={15} aria-hidden="true" />
              Entsorgungsbetriebe erneut laden
            </button>
          </>
        )}

        {/* Every area-request state, including the failure and its retry, in the words the shared panel owns. */}
        <AreaStatePanel state={areaState} providerId={selectedProviderId} onRetry={onRetryAreas} />
      </section>

      {areas.length > 0 && (
        <section className="mt-3 rounded-3xl border border-ar-border bg-ar-surface p-4 shadow-ar-sm">
          <p className="text-sm font-semibold" id={areaLabelId}>
            Sammelgebiet
          </p>
          <p className="sr-only" id={unavailableHintId}>
            Für dieses Gebiet veröffentlicht der Entsorgungsbetrieb keinen offiziellen Kalender.
          </p>

          <ul className="mt-2 space-y-2" aria-labelledby={areaLabelId}>
            {areas.map((area) => {
              const isUnavailable = area.collectionEvents.availability === 'unavailable';
              const isChosen = area.id === chosenAreaId;

              return (
                <li key={area.id}>
                  <button
                    type="button"
                    // A genuinely disabled control: not operable by pointer or keyboard, removed from the
                    // tab order, and announced as unavailable. Appearance is never the mechanism — a row
                    // that merely looks greyed while still activating on Enter is the failure mode being
                    // ruled out here.
                    disabled={isUnavailable}
                    aria-pressed={isChosen}
                    aria-describedby={isUnavailable ? unavailableHintId : undefined}
                    className={[
                      'flex min-h-11 w-full items-start gap-2 rounded-2xl border px-3.5 py-3 text-left transition focus-visible:outline-ar-focus',
                      isChosen
                        ? 'border-ar-brand bg-ar-brand-soft text-ar-brand-strong'
                        : 'border-ar-border bg-ar-surface',
                      isUnavailable ? 'cursor-not-allowed opacity-70' : '',
                    ].join(' ')}
                    onClick={() => {
                      setChosenAreaId(area.id);
                      setConfirmError(null);
                    }}
                  >
                    {isChosen && <Check size={15} className="mt-0.5 shrink-0" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">
                        {area.locality} · {area.name}
                      </span>
                      {isUnavailable && (
                        // Visible and explanatory rather than hidden: hiding it would imply the
                        // municipality does not serve the area, which is a different and unfounded claim.
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

          <button
            type="button"
            className="mt-4 min-h-11 w-full rounded-2xl bg-ar-brand px-4 py-3.5 text-sm font-semibold text-ar-on-brand shadow-ar-brand transition hover:bg-ar-brand-strong focus-visible:outline-ar-focus disabled:cursor-not-allowed disabled:opacity-60"
            disabled={chosenArea === undefined || isConfirming}
            onClick={() => void handleConfirm()}
          >
            {isConfirming ? 'Auswahl wird gespeichert…' : 'Auswahl bestätigen'}
          </button>

          {confirmError !== null && (
            // Announced as well as shown: a failure that only appeared visually would be silent for a
            // screen-reader user who had just pressed the one button on this surface that writes.
            <p className="mt-3 text-sm text-ar-danger" role="alert">
              {confirmError}
            </p>
          )}
        </section>
      )}
    </main>
  );
};
