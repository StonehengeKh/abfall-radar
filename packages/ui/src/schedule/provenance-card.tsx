import { formatCalendarDate, formatInstant } from '@abfall-radar/schedule-format';
import type { ScheduleCopy, ScheduleView } from './types';

/** Where the schedule came from, how fresh it is, and which waste types the source publishes. */
export const ProvenanceCard = ({
  view,
  locale,
  messages,
  className = '',
}: {
  readonly view: ScheduleView;
  readonly className?: string;
} & ScheduleCopy) => {
  const { source } = view;

  /*
   * An ordinary section, not a disclosure. Where a schedule came from, how fresh it is, and which waste
   * types the source actually publishes are qualifications on the schedule above — somebody who has to
   * open something to find them can act on the data without ever seeing them.
   */
  return (
    <section
      aria-labelledby="provenance-heading"
      className={`flex flex-col gap-1 rounded-ar-xl border border-ar-border bg-ar-surface p-4 text-sm shadow-ar-sm ${className}`}
      data-testid="provenance"
    >
      <h3
        className="text-xs font-semibold uppercase tracking-wide text-ar-text-muted"
        id="provenance-heading"
      >
        {messages.provenance.details}
      </h3>
      <p className="font-medium text-ar-text">{source.name}</p>
      <p className="text-ar-text-muted">{source.attribution}</p>
      <p>
        <a
          className="text-ar-brand underline"
          href={source.landingPageUrl}
          rel="noreferrer noopener"
          target="_blank"
        >
          {messages.provenance.openSource}
        </a>
      </p>
      <p className="text-ar-text-muted">
        {messages.provenance.retrieved}: {formatInstant(locale, source.retrievedAt)} UTC
        {source.freshness === null
          ? null
          : ` · ${source.freshness === 'stale' ? messages.provenance.stale : messages.provenance.fresh}`}
      </p>
      <p className="text-ar-text-muted">
        {messages.provenance.shownPeriod}: {formatCalendarDate(locale, view.range.from)} –{' '}
        {formatCalendarDate(locale, view.range.to)}
      </p>
      <p className="text-ar-text-muted">
        {messages.provenance.publishedWasteTypes}:{' '}
        {source.publishedWasteTypes.map((type) => messages.waste[type]).join(', ')}
      </p>
    </section>
  );
};
