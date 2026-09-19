import type { Messages } from '@/src/i18n/messages';
import type {
  AppViewState,
  RenderableApiFailure,
  SourceDateUnavailable,
} from '@/src/schedule/view-state';

/**
 * How a state or a failure is put into words, given one locale's messages.
 *
 * The strings themselves live in `src/i18n/messages.ts`; what lives here is the *choice* of which one a
 * view calls for, which is product logic and identical in every language. Nothing here renders a server
 * diagnostic: `detail`, `instance`, and validator text never reach a surface.
 */

export type RenderableFailureKind = RenderableApiFailure['kind'] | SourceDateUnavailable['kind'];

export const failureMessage = (
  messages: Messages,
  failure: RenderableApiFailure | SourceDateUnavailable,
): string => {
  if (failure.kind !== 'problem') {
    return messages.failures[failure.kind];
  }

  /*
   * `code` is an open string from the wire, so this is a `Map` lookup, not a property read: an object
   * lookup also finds inherited members, and `__proto__`, `constructor`, or `toString` would then return
   * a prototype value instead of missing. Every unsanctioned code falls back to the generic message.
   */
  const known = new Map<string, string>(Object.entries(messages.problemCodes));

  return known.get(failure.code) ?? messages.failures.problem;
};

/**
 * What the polite live region says about the current view.
 *
 * Derived, never stored: a transient notice is replaced the moment the view it belongs to is gone. A
 * failure is named rather than summarised away, so a recovery attempt that failed under
 * `range_not_covered` and an unavailable source date are both announced instead of being silent.
 */
export const announcementMessage = (messages: Messages, view: AppViewState): string => {
  if (view.kind === 'needs_selection' && view.notice !== null) {
    return messages.notices[view.notice];
  }

  if (view.kind === 'error') {
    return `${messages.states.error.announcement} ${failureMessage(messages, view.context.failure)}`;
  }

  if (view.kind === 'range_not_covered' && view.lastRecoveryFailure !== undefined) {
    return `${messages.states.range_not_covered.announcement} ${failureMessage(
      messages,
      view.lastRecoveryFailure.failure,
    )}`;
  }

  return messages.states[view.kind].announcement;
};

/** Only a validated Problem Details response carries an identifier worth showing. */
export const supportIdentifier = (
  failure: RenderableApiFailure | SourceDateUnavailable,
): string | null => (failure.kind === 'problem' ? failure.requestId : null);
