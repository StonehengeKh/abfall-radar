import { type Ref, useState } from 'react';
import { AreaPicker } from '@/src/features/selection/area-picker';
import { PopupHeader } from '@/src/features/shell/popup-header';
import type {
  AreaCatalogueState,
  CityCatalogueState,
  ProviderCatalogueState,
} from '@/src/hooks/use-catalogue';
import { useCopy } from '@/src/i18n/copy';
import type { SelectionWriteOutcomeKind, ServiceAreaSummary } from '@/src/messaging/contract';

/**
 * The needs-selection surface.
 *
 * Its own small surface rather than a mode flag on the settings view: nothing is preselected, persisted,
 * or fetched on the user's behalf, so choosing a district is a distinct thing a person does once. The city
 * comes first, then the operator only where the city has more than one, then the district — the questions
 * the shared picker asks.
 *
 * A provider whose `sourceKind` is `demo` is filtered out **at the catalogue**, so none of its districts is
 * ever listed, reachable, or rendered here, and no city is ever chosen on a person's behalf.
 *
 * Confirming is the one act on this surface that writes, and it is treated as one: awaited, reported, and
 * recoverable. A storage write can be refused or can fail, and a surface that navigated away regardless would
 * have accepted a choice it never stored.
 */

export interface NeedsSelectionViewProps {
  readonly cities: CityCatalogueState;
  readonly catalogue: ProviderCatalogueState;
  /** The district list of whichever operator the picker is asking about. */
  readonly areaStateFor: (providerId: string | null) => AreaCatalogueState;
  readonly onRetryCities: () => void;
  /** Reads the provider catalogue again. */
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

export const NeedsSelectionView = ({
  cities,
  catalogue,
  areaStateFor,
  onRetryCities,
  onRetryCatalogue,
  onRequestAreas,
  onRetryAreas,
  onConfirm,
  headingRef,
}: NeedsSelectionViewProps) => {
  const { messages } = useCopy();
  const [chosenArea, setChosenArea] = useState<ServiceAreaSummary | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  /**
   * Awaits the write, then reports.
   *
   * Guarded against a second submission rather than relying on the disabled attribute alone: a double
   * activation would otherwise start two writes for one choice. The attempted area stays chosen on a failure,
   * so retrying is one press rather than a re-selection.
   */
  const handleConfirm = async () => {
    if (chosenArea === null || isConfirming) {
      return;
    }

    setIsConfirming(true);
    setConfirmError(null);

    try {
      const outcome = await onConfirm(chosenArea);

      if (outcome !== 'persisted') {
        setConfirmError(
          outcome === 'rejected_unavailable'
            ? messages.selectionErrors.rejectedUnavailable
            : messages.selectionErrors.rejectedUnknownCapability,
        );
      }
    } catch {
      // Nothing about the error is surfaced: it could name an internal storage path.
      setConfirmError(messages.selectionErrors.storage);
    } finally {
      setIsConfirming(false);
    }
  };

  return (
    <main className="min-h-full px-4 pb-4 pt-4 text-ar-text">
      <PopupHeader />

      {/* Programmatically focusable, never a stop in the tab order. */}
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="mt-4 text-lg font-semibold tracking-tight break-words outline-none"
      >
        {messages.onboarding.heading}
      </h1>
      <p className="mt-1 text-sm text-ar-text-muted">{messages.onboarding.intro}</p>

      <AreaPicker
        cities={cities}
        catalogue={catalogue}
        areaStateFor={areaStateFor}
        initialCityId={null}
        initialProviderId={null}
        chosenAreaId={chosenArea?.id ?? null}
        onChooseArea={(area) => {
          setChosenArea(area);
          setConfirmError(null);
        }}
        onResetArea={() => {
          // Changing the city or the operator clears the district, so an identifier is never carried across.
          setChosenArea(null);
          setConfirmError(null);
        }}
        onRetryCities={onRetryCities}
        onRetryCatalogue={onRetryCatalogue}
        onRequestAreas={onRequestAreas}
        onRetryAreas={onRetryAreas}
      >
        {/*
          The confirmation, where the choice can be acted on rather than at the end of thirty-four districts.

          The website's confirmation bar, adapted to the popup: `position: sticky`, so it keeps its own place
          after the list — the last district is never covered once the popup is scrolled to the bottom — while
          riding the lower edge on the way there. It names what is chosen, because a person who picked a
          district near the top and scrolled on would otherwise have to scroll back to see what the button
          would confirm.
        */}
        <div
          className="sticky bottom-0 z-10 -mx-4 mt-4 border-t border-ar-border bg-ar-surface/95 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] backdrop-blur"
          data-testid="confirm-bar"
        >
          <p className="text-sm" data-testid="confirm-summary">
            {chosenArea === null ? (
              <span className="text-ar-text-muted">{messages.onboarding.noneSelected}</span>
            ) : (
              <>
                <span className="text-ar-text-muted">{messages.onboarding.selected}: </span>
                <span className="font-medium break-words text-ar-text">{chosenArea.name}</span>
              </>
            )}
          </p>
          <button
            type="button"
            className="mt-2 min-h-11 w-full rounded-ar-md bg-ar-brand px-4 py-3.5 text-sm font-semibold text-ar-on-brand shadow-ar-brand transition hover:bg-ar-brand-strong focus-visible:outline-ar-focus disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
            disabled={chosenArea === null || isConfirming}
            onClick={() => void handleConfirm()}
          >
            {isConfirming ? messages.onboarding.confirming : messages.onboarding.confirm}
          </button>

          {confirmError !== null && (
            // Announced as well as shown: a failure that only appeared visually would be silent for a
            // screen-reader user who had just pressed the one button on this surface that writes.
            <p className="mt-3 text-sm text-ar-danger" role="alert">
              {confirmError}
            </p>
          )}
        </div>
      </AreaPicker>
    </main>
  );
};
