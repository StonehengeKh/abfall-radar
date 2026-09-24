import { useEffect, useId, useRef, useState } from 'react';
import { useCopy } from '@/src/i18n/copy';
import type { HouseholdSetup, ServiceAreaSelection } from '@/src/storage/settings';

/**
 * Switching the calculated household bins on, in Settings, for the district being edited.
 *
 * One question — the weekday — because that is the only part the operator does not publish. Everything
 * said around it exists so nobody mistakes a calculated date for a published one: the intro says where
 * the dates come from, and the hint says where the weekday itself comes from, which is a telephone call.
 *
 * **Enabling is not confirming.** Pressing Enable opens an *unconfirmed* draft whose weekday is
 * deliberately empty: there is no weekday that could be right by default, and a preselected Monday that
 * somebody saves without looking is the extension recording a guess as though the household had stated
 * it. So the select starts on a placeholder that cannot be saved, and only choosing a weekday and
 * pressing Confirm writes a setup into the draft.
 *
 * Edits the **draft**, like every other control on this surface. Nothing reaches storage until Save, and
 * the weekday is stored with the district it was confirmed for, so it can never be applied to another.
 */

const WEEKDAYS: readonly (1 | 2 | 3 | 4 | 5 | 6 | 7)[] = [1, 2, 3, 4, 5, 6, 7];

/** The select's empty value: a placeholder, never a weekday. */
const UNCHOSEN = '';

const FIELD =
  'mt-2 min-h-11 w-full rounded-ar-md border border-ar-border bg-ar-surface-muted px-3.5 py-3 text-sm font-medium text-ar-text outline-none transition focus:border-ar-brand focus:ring-3 focus:ring-ar-brand-soft motion-reduce:transition-none';

const BUTTON =
  'mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-ar-md border border-ar-border bg-ar-surface px-3.5 py-2 text-sm font-semibold text-ar-text transition hover:border-ar-text-muted focus-visible:outline-ar-focus motion-reduce:transition-none';

export const HouseholdSection = ({
  household,
  selection,
  onChange,
}: {
  readonly household: HouseholdSetup | null;
  /** The district being edited, which the weekday is stored against. */
  readonly selection: ServiceAreaSelection | null;
  readonly onChange: (household: HouseholdSetup | null) => void;
}) => {
  const { messages } = useCopy();
  const copy = messages.household;
  const fieldId = useId();
  const hintId = useId();
  /** A setup for another district is not this district's setting, so the section reads as off. */
  const active =
    household !== null &&
    selection !== null &&
    household.providerId === selection.providerId &&
    household.serviceAreaId === selection.serviceAreaId
      ? household
      : null;
  /**
   * Whether the chooser is open, and which weekday it is showing.
   *
   * `UNCHOSEN` until somebody picks one. It is a separate piece of state from the draft on purpose: a
   * weekday being *looked at* is not a weekday being confirmed, and only the latter may be persisted.
   */
  const [choosing, setChoosing] = useState(false);
  const [chosen, setChosen] = useState<string>(UNCHOSEN);
  const chooserRef = useRef<HTMLSelectElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const enableRef = useRef<HTMLButtonElement>(null);

  /**
   * Where focus belongs after a transition, or `none` when nothing transitioned.
   *
   * **Every** control here replaces itself. Enable unmounts to make room for the chooser, Confirm
   * unmounts to make room for the confirmed row, and Disable unmounts to make room for Enable again. Any
   * of those without a destination drops focus to `<body>`, and the keyboard journey restarts at the top
   * of the popup — someone who has just confirmed a weekday would have to tab all the way back to reach
   * Save.
   *
   * Set by the **act**, never derived from `choosing`. Deriving it would also fire on every unrelated
   * rerender of this section — a settings draft changing elsewhere, a catalogue answer — and take focus
   * away from whatever the person had moved to since. So a transition is recorded where it is caused and
   * consumed exactly once, the same way the popup's own screen transitions are handled.
   */
  const [pendingFocus, setPendingFocus] = useState<'none' | 'chooser' | 'confirmed' | 'enable'>(
    'none',
  );

  useEffect(() => {
    if (pendingFocus === 'none') {
      return;
    }

    // Consumed before the focus call, so a transition cannot survive the render it belongs to.
    setPendingFocus('none');

    if (pendingFocus === 'chooser') {
      chooserRef.current?.focus();

      return;
    }

    if (pendingFocus === 'enable') {
      enableRef.current?.focus();

      return;
    }

    /*
     * The confirmed row's own control, not the summary text. Change is what Confirm turned into: it acts
     * on the same weekday, it is a real tab stop, and continuing forward from it reaches Disable and then
     * Save in the order they are read.
     */
    changeRef.current?.focus();
  }, [pendingFocus]);

  const openChooser = (from: HouseholdSetup | null) => {
    setChosen(from === null ? UNCHOSEN : String(from.weekday));
    setChoosing(true);
    setPendingFocus('chooser');
  };

  const chooser =
    selection === null ? null : (
      <>
        <label className="mt-3 block text-sm font-semibold" htmlFor={fieldId}>
          {copy.weekdayLabel}
        </label>
        <select
          aria-describedby={hintId}
          className={FIELD}
          data-testid="household-weekday"
          id={fieldId}
          onChange={(event) => setChosen(event.target.value)}
          ref={chooserRef}
          value={chosen}
        >
          {/* Not selectable: there is no weekday that could be correct without being told. */}
          <option disabled value={UNCHOSEN}>
            {copy.chooseWeekday}
          </option>
          {WEEKDAYS.map((weekday) => (
            <option key={weekday} value={weekday}>
              {copy.weekdays[weekday]}
            </option>
          ))}
        </select>
        <p className="mt-2 text-xs text-ar-text-muted" id={hintId}>
          {copy.weekdayHint}
        </p>
        <button
          className={BUTTON}
          data-testid="household-confirm"
          // Nothing to confirm until a weekday has actually been chosen.
          disabled={chosen === UNCHOSEN}
          onClick={() => {
            if (chosen === UNCHOSEN) {
              return;
            }

            onChange({ ...selection, weekday: Number(chosen) as HouseholdSetup['weekday'] });
            setChoosing(false);
            // Confirm is about to unmount; Change is the control that takes its place.
            setPendingFocus('confirmed');
          }}
          type="button"
        >
          {copy.confirm}
        </button>
      </>
    );

  return (
    <section
      className="mt-3 rounded-ar-xl border border-ar-border bg-ar-surface p-4 shadow-ar-sm"
      data-testid="household-section"
    >
      <p className="text-sm font-semibold">{copy.heading}</p>
      <p className="mt-1 text-xs text-ar-text-muted">{copy.intro}</p>

      {selection === null ? null : choosing ? (
        chooser
      ) : active === null ? (
        <button
          className={BUTTON}
          data-testid="household-enable"
          onClick={() => openChooser(null)}
          ref={enableRef}
          type="button"
        >
          {copy.enable}
        </button>
      ) : (
        <>
          <p className="mt-3 text-sm" data-testid="household-confirmed">
            {copy.weekdayLabel}: <strong>{copy.weekdays[active.weekday]}</strong>
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className={BUTTON}
              data-testid="household-change"
              onClick={() => openChooser(active)}
              ref={changeRef}
              type="button"
            >
              {copy.change}
            </button>
            <button
              className={BUTTON}
              data-testid="household-disable"
              onClick={() => {
                onChange(null);
                setChoosing(false);
                // Disable unmounts itself too, and Enable is what appears in its place.
                setPendingFocus('enable');
              }}
              type="button"
            >
              {copy.disable}
            </button>
          </div>
        </>
      )}
    </section>
  );
};
