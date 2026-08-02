import { Loader2, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AreaCatalogueState } from '@/src/hooks/use-catalogue';

/**
 * What each area-request state says, and the one control that can start another attempt.
 *
 * Shared by the onboarding and settings surfaces because both ask the same question of the same state, and
 * a second copy of this wording is how one surface ends up calling a failure "loading" — the state that
 * looks like progress forever and offers no way out.
 *
 * Every member is answered, including `not_offered` and a `loaded` list that came back empty. Neither is an
 * error and neither is progress: they are answers, and saying nothing about them leaves an empty panel that
 * reads as a request still running.
 */

export interface AreaStatePanelProps {
  readonly state: AreaCatalogueState;
  /** The provider the surface is currently asking about, or `null` when none is chosen. */
  readonly providerId: string | null;
  /** Starts one more attempt. Only reachable from a failed state. */
  readonly onRetry: (providerId: string) => void;
}

const LOAD_FAILED = 'Die Sammelgebiete konnten nicht geladen werden.' as const;

const NOTHING_PUBLISHED =
  'Für diesen Entsorgungsbetrieb sind derzeit keine Sammelgebiete abrufbar.' as const;

const NOT_OFFERED =
  'Dieser Entsorgungsbetrieb steht derzeit nicht zur Verfügung. Bitte wähle einen anderen.' as const;

/**
 * The one statement each state makes, and it is both the visible text and the announced text.
 *
 * Deliberately not a visible message plus a separate screen-reader message saying the same thing: that
 * duplication makes a screen reader read every change twice, once from the live region and once from the
 * paragraph itself. One node inside the live region is heard once and seen once.
 *
 * The switch is exhaustive with a declared return type, so a new `AreaCatalogueState` member cannot be
 * added without deciding what it says here — the alternative being a silently empty panel.
 */
const statusFor = (state: AreaCatalogueState): ReactNode => {
  switch (state.kind) {
    case 'idle':
      // Nothing has been asked, so there is nothing to report. Not a state a person needs told about.
      return null;
    case 'loading':
      return (
        <p className="mt-3 flex items-center gap-2 text-sm text-ar-text-muted">
          <Loader2
            size={15}
            className="animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          Sammelgebiete werden geladen…
        </p>
      );
    case 'loaded':
      // A non-empty answer is the area list itself, which the surrounding surface renders.
      return state.areas.length === 0 ? (
        <p className="mt-3 text-sm text-ar-text-muted">{NOTHING_PUBLISHED}</p>
      ) : null;
    case 'not_offered':
      return <p className="mt-3 text-sm text-ar-text-muted">{NOT_OFFERED}</p>;
    case 'failed':
      return <p className="mt-3 text-sm text-ar-danger">{LOAD_FAILED}</p>;
  }
};

/**
 * Whether the state describes the provider being asked about.
 *
 * A state always names its provider, so a reply for a previous selection is recognizable as stale rather
 * than being read as this provider's answer — which is how one provider's error message would otherwise end
 * up sitting under another provider's name.
 */
const isAbout = (state: AreaCatalogueState, providerId: string | null): boolean =>
  providerId !== null && state.kind !== 'idle' && state.providerId === providerId;

export const AreaStatePanel = ({ state, providerId, onRetry }: AreaStatePanelProps) => {
  const relevant = isAbout(state, providerId);

  return (
    <>
      {/*
        Always rendered, so it is a live region before its content changes — a region added to the page at
        the same moment as its text is not reliably announced. Polite rather than assertive: none of these
        interrupts anything a person is doing, and a failure that was only visible would be silent for a
        screen-reader user who had just chosen a provider.

        Spacing lives on the statements themselves, as it does on every sibling in these panels, so an empty
        region occupies nothing at all.
      */}
      <div role="status" aria-live="polite">
        {relevant ? statusFor(state) : null}
      </div>

      {relevant && state.kind === 'failed' && (
        // Outside the live region: the button's own label is not news, and re-announcing it on every state
        // change would talk over the statement that actually changed.
        <button
          type="button"
          className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-2xl border border-ar-border bg-ar-surface px-3.5 py-2 text-sm font-semibold transition hover:border-ar-text-muted focus-visible:outline-ar-focus"
          onClick={() => onRetry(state.providerId)}
        >
          <RotateCcw size={15} aria-hidden="true" />
          Sammelgebiete erneut laden
        </button>
      )}
    </>
  );
};
