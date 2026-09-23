import type { CollectionEvent, WasteType } from '@abfall-radar/domain';
import type { IsoDate, Locale, ScheduleMessages } from '@abfall-radar/schedule-format';

/**
 * What a schedule surface needs to know about where its data came from.
 *
 * Structural and minimal on purpose. The website holds an API-client response and the extension holds
 * its own validated message payload; each maps into this, so neither application's transport types reach
 * a shared component. The landing page URL is validated by whichever boundary produced it before it gets
 * here — this type does not re-validate a link it only renders.
 */
export interface ScheduleSourceDetails {
  readonly name: string;
  readonly attribution: string;
  readonly landingPageUrl: string;
  /** The last successful retrieval, as an ISO instant. */
  readonly retrievedAt: string;
  /**
   * What the source said about its own data, or `null` when this schedule is not the source's current answer —
   * a restored copy, whose surface states that itself and must not borrow either of the source's claims.
   */
  readonly freshness: 'fresh' | 'stale' | null;
  readonly publishedWasteTypes: readonly WasteType[];
}

/** An accepted schedule, as the shared presentation reads it. */
export interface ScheduleView {
  /** Domain events, already in the total event order. */
  readonly events: readonly CollectionEvent[];
  /** Today in the source's own zone — the day every label is relative to. */
  readonly sourceToday: IsoDate;
  /** The source zone a date-only collection's day begins in. */
  readonly timeZone: string;
  readonly range: { readonly from: IsoDate; readonly to: IsoDate };
  readonly source: ScheduleSourceDetails;
}

/** The language a surface is rendered in, and the copy for it. */
export interface ScheduleCopy {
  readonly locale: Locale;
  readonly messages: ScheduleMessages;
}
