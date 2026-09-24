import type { ScheduleCopy } from './types';

/**
 * The mark a calculated collection carries, wherever it appears.
 *
 * One component rather than the same markup written out in the featured card and in every list row: the
 * badge is the only thing telling a reader that a date was *worked out* from the operator's rules and a
 * confirmed weekday rather than retrieved from its calendar, and two copies of that markup is two places
 * for it to drift — which is exactly how one of them kept an overflowing layout after the other was
 * fixed.
 *
 * **It has to survive the narrowest case the product supports.** At 320 px with the root font at 32 px,
 * the waste icon takes 80 px and the title column is barely 100 px, while the label is a single word in
 * every language — `Рассчитано` measures 173 px there. A single word has no break opportunity inside it,
 * so as a flex item its minimum size stays the whole word and the card pushes the page sideways.
 *
 * `wrap-anywhere` is what fixes that, and `break-words` is not: only `overflow-wrap: anywhere` lowers the
 * item's min-content contribution, which is what actually lets `min-w-0` shrink it. The label stays
 * complete and stays at its own size — it wraps onto a second line rather than being clipped, truncated
 * or hidden behind page-level `overflow`, and neither the waste title nor the icon changes.
 */
export const CalculatedBadge = ({ messages }: Pick<ScheduleCopy, 'messages'>) => (
  <span
    className="min-w-0 rounded-ar-sm border border-ar-border px-1.5 py-0.5 text-[0.65rem] font-semibold tracking-wide text-ar-text-muted uppercase wrap-anywhere"
    data-testid="calculated-badge"
    title={messages.household.calculatedHint}
  >
    {messages.household.calculated}
  </span>
);
