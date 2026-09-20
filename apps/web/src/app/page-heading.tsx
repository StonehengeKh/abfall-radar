import { PAGE_HEADING } from '@/src/app/typography';

/**
 * A page heading with its secondary action beside it.
 *
 * One layout rule for both surfaces: the heading leads, the action sits on the trailing side of the same
 * row, and the row wraps — action underneath, still trailing — when a narrow screen or enlarged text
 * leaves no room for both. Keeping it in one component is what stops the schedule's "change selection"
 * and the chooser's "back" from drifting into two different treatments.
 */
export const PageHeadingRow = ({
  id,
  heading,
  action,
}: {
  readonly id: string;
  readonly heading: string;
  readonly action?: React.ReactNode;
}) => (
  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
    <h2 className={PAGE_HEADING} id={id} tabIndex={-1}>
      {heading}
    </h2>
    {action === undefined ? null : <div className="ms-auto shrink-0">{action}</div>}
  </div>
);
