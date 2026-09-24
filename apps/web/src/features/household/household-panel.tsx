import { formatCalendarDate, formatInstant } from '@abfall-radar/schedule-format';
import { useId, useState } from 'react';
import type { StoredWeekday } from '@/src/adapters/household-setup-store';
import type { HouseholdState } from '@/src/hooks/use-household-schedule';
import { useLocale } from '@/src/i18n/context';

/**
 * Turning the household bins on, and saying what they are.
 *
 * The operator publishes no calendar for the brown and grey bins, and no per-address weekday — that is
 * only available by telephone. So this panel asks for one thing, the weekday, and is explicit about what
 * it does with it: the dates below are **calculated** from the operator's published rules, not retrieved
 * from a calendar.
 *
 * It is opt-in and reversible. Nothing is calculated until somebody confirms a weekday, and switching it
 * off forgets it. The qualifications that matter — where the published rules stop, and whether the
 * published table still matches the transcription — are shown here rather than buried, because they are
 * the difference between a date worth acting on and one worth checking.
 */

const WEEKDAYS: readonly StoredWeekday[] = [1, 2, 3, 4, 5, 6, 7];

const CONTROL =
  'min-h-11 rounded-ar-md border border-ar-border bg-ar-surface px-3.5 py-2 text-sm font-medium text-ar-text transition hover:border-ar-text-muted focus-visible:outline-ar-focus motion-reduce:transition-none';

export const HouseholdPanel = ({
  state,
  onEnable,
  onDisable,
  onRetry,
}: {
  readonly state: HouseholdState;
  readonly onEnable: (weekday: StoredWeekday) => void;
  readonly onDisable: () => void;
  readonly onRetry: () => void;
}) => {
  const { locale, messages } = useLocale();
  const copy = messages.household;
  const fieldId = useId();
  const hintId = useId();
  /** The weekday being chosen, before it is confirmed. Nothing is calculated from a draft. */
  const [draft, setDraft] = useState<StoredWeekday>(state.status === 'off' ? 1 : state.weekday);
  const [editing, setEditing] = useState(false);

  const chooser = (
    <div className="mt-3 flex flex-wrap items-end gap-3">
      <div className="min-w-0">
        <label className="block text-sm font-medium text-ar-text" htmlFor={fieldId}>
          {copy.weekdayLabel}
        </label>
        <select
          aria-describedby={hintId}
          className={`${CONTROL} mt-1 w-full`}
          id={fieldId}
          onChange={(event) => setDraft(Number(event.target.value) as StoredWeekday)}
          value={draft}
        >
          {WEEKDAYS.map((weekday) => (
            <option key={weekday} value={weekday}>
              {copy.weekdays[weekday]}
            </option>
          ))}
        </select>
      </div>
      <button
        className={`${CONTROL} bg-ar-brand text-ar-on-brand hover:bg-ar-brand-strong`}
        onClick={() => {
          onEnable(draft);
          setEditing(false);
        }}
        type="button"
      >
        {copy.confirm}
      </button>
    </div>
  );

  return (
    <section
      aria-labelledby={`${fieldId}-heading`}
      className="rounded-ar-xl border border-ar-border bg-ar-surface p-4 text-sm shadow-ar-sm"
      data-testid="household-panel"
    >
      <h3 className="font-semibold text-ar-text" id={`${fieldId}-heading`}>
        {copy.heading}
      </h3>
      <p className="mt-1 text-ar-text-muted">{copy.intro}</p>
      <p className="mt-1 text-xs text-ar-text-muted" id={hintId}>
        {copy.weekdayHint}
      </p>

      {state.status === 'off' ? (
        editing ? (
          chooser
        ) : (
          <button
            className={`${CONTROL} mt-3`}
            data-testid="household-enable"
            onClick={() => setEditing(true)}
            type="button"
          >
            {copy.enable}
          </button>
        )
      ) : (
        <>
          <p className="mt-3 text-ar-text" data-testid="household-weekday">
            {copy.weekdayLabel}: <strong>{copy.weekdays[state.weekday]}</strong>
          </p>

          {editing ? (
            chooser
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              <button className={CONTROL} onClick={() => setEditing(true)} type="button">
                {copy.change}
              </button>
              <button
                className={CONTROL}
                data-testid="household-disable"
                onClick={() => {
                  onDisable();
                  setEditing(false);
                }}
                type="button"
              >
                {copy.disable}
              </button>
            </div>
          )}

          {state.status === 'loading' && (
            <p className="mt-3 text-ar-text-muted" role="status">
              {copy.loading}
            </p>
          )}

          {state.status === 'unavailable' && (
            <div className="mt-3">
              {/*
                The setup survives the outage: an unreachable source is not a reason to forget a weekday
                somebody confirmed, and the bins reappear by themselves once the rules can be read.
              */}
              <p className="text-ar-danger" role="alert">
                {state.retryable ? copy.unavailable : copy.notOffered}
              </p>
              {state.retryable && (
                <button className={`${CONTROL} mt-2`} onClick={onRetry} type="button">
                  {messages.actions.retry}
                </button>
              )}
            </div>
          )}

          {state.status === 'ready' && (
            <div className="mt-3 flex flex-col gap-1 text-xs text-ar-text-muted">
              {/*
                Where the published rules stop. Saying this is what keeps the empty space past the
                coverage window from reading as "no collections".
              */}
              {state.schedule.limitedCoverage && (
                <p data-testid="household-coverage">
                  {copy.limitedCoverage(formatCalendarDate(locale, state.rules.coverage.to))}
                </p>
              )}
              {state.rules.verification === 'unverified' && <p>{copy.unverified}</p>}
              {state.rules.verification === 'changed' && (
                <p className="text-ar-danger" role="alert">
                  {copy.changed}
                </p>
              )}
              {/*
                The automatic check and the manual reading, in the shared wording both applications use.
                Shown in every ready state, including the one where everything succeeded: a calculated
                date is only as good as these two facts, and the reading where somebody is most likely to
                act on it must not be the one reading that never states them.
              */}
              <p data-testid="household-checked">
                {copy.sourceChecked[state.rules.verification](
                  `${formatInstant(locale, state.rules.checkedAt)} UTC`,
                )}
              </p>
              {/*
                The part nothing automatic covers. A notice published after this date could amend a row,
                and saying so is the difference between "checked" and "checked as far as a machine can".
              */}
              <p data-testid="household-announcements">
                {copy.announcementsReviewed(
                  formatCalendarDate(locale, state.rules.announcementsReviewedThrough),
                )}
              </p>
              <p>
                <a
                  className="text-ar-brand underline"
                  href={state.rules.source.replacementsSourceUrl}
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  {copy.sourceLink}
                </a>
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
};
