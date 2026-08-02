import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createMessagingClient, type MessagingClient } from '@/src/messaging/client';
import type { SettingsResult } from '@/src/messaging/client';
import {
  type SelectionInvalidationPayload,
  type SelectionWritePayload,
  SettingsChangedNotificationSchema,
  type SettingsWriteOutcomeKind,
  type SettingsWritePayload,
} from '@/src/messaging/contract';
import type { ServiceAreaCapabilityEvidence } from '@/src/schedule/capability';
import {
  type AppSettings,
  defaultSettings,
  type ServiceAreaSelection,
} from '@/src/storage/settings';

/**
 * Settings for the popup, read and written **through the service worker**.
 *
 * The popup never touches the settings storage item. That is not layering for its own sake: the popup and the
 * Manifest V3 worker are separate module instances, so a mutation queue held in a module variable serializes
 * each context against itself and neither against the other — and two contexts read-modify-writing one key that
 * way lose whichever write landed first. Exactly one context can own the queue, and the worker is the one that
 * outlives the popup, so every read and every write is a message to it.
 *
 * Reads go through the worker too, so the write a migration performs happens in the owning context rather than
 * inside the popup, where it would be a second unserialized writer. A read may wake the worker, which is the
 * accepted cost of having one owner.
 *
 * `defaultSettings` is the pre-hydration value only. It carries `selection: null`, so the popup shows the
 * needs-selection state rather than a municipality nobody chose while the read is in flight.
 */

/**
 * How far the initial settings read has got.
 *
 * Three states rather than a boolean, because "not ready" was covering two completely different situations:
 * a read still in flight, and a read that will never answer. The popup rendered its preparation screen for
 * both, so an unreadable storage item showed a person a spinner forever — no error, no explanation, and
 * nothing to act on.
 */
export type SettingsStatus =
  /** The read is in flight. Nothing has gone wrong. */
  | 'preparing'
  | 'ready'
  /**
   * The stored value could not be read at all. Terminal for this session, and deliberately **not** silently
   * replaced with defaults: defaults would present a fresh installation to someone whose settings exist and
   * are merely unreadable, and the area they chose would look like a choice they never made.
   */
  | 'unreadable'
  /**
   * The stored value was written by a newer build of this extension.
   *
   * Terminal, and deliberately **not** an editable fresh installation: the settings are intact on disk and this
   * build cannot represent them, so offering to edit them would mean either discarding what the newer build stored
   * or refusing every edit a person made.
   */
  | 'unsupported_version';

/** The three refusals a write can report, without the two compare-and-clear outcomes. */
export type SettingsWriteRefusal = Exclude<
  SettingsWriteOutcomeKind,
  'persisted' | 'invalidated' | 'superseded'
>;

export interface UseSettingsInput {
  /** Injected in tests. Production always talks to the worker through the default client. */
  readonly client?: MessagingClient;
}

/**
 * A write that could not be delivered at all.
 *
 * Distinct from a refusal: the worker never decided anything, so the caller has to be able to tell "storage said
 * no" from "the message did not get through". Both are safe to show; only one is worth retrying the same way.
 */
export class SettingsWriteFailedError extends Error {
  constructor() {
    // Carries no detail on purpose: the failure it stands for could name an internal storage path.
    super('The settings write could not be completed.');
    this.name = 'SettingsWriteFailedError';
  }
}

export const useSettings = ({ client }: UseSettingsInput = {}) => {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [status, setStatus] = useState<SettingsStatus>('preparing');

  /**
   * Held in a ref rather than in a dependency list, so an inline client from a caller cannot make the initial
   * read run again on every render.
   */
  const messagingRef = useRef(client);

  messagingRef.current = client;

  const messaging = useMemo(() => client ?? createMessagingClient(), [client]);

  /**
   * The newest read wins.
   *
   * Two reads can be in flight at once — the initial hydration and one a notification triggered — and they can
   * answer in either order. Without this the slow one overwrites the fast one, so a popup told the selection had
   * been cleared could go back to showing the selection a moment later. Every read captures the counter as it
   * starts and applies nothing once a later one exists; the cleanup bumps it, which is also what stops an
   * unmounted hook from setting state.
   */
  const latestRead = useRef(0);

  const hydrate = useCallback((): void => {
    latestRead.current += 1;

    const thisRead = latestRead.current;
    const transport = messagingRef.current ?? createMessagingClient();

    void transport.readSettings().then((result) => {
      if (thisRead !== latestRead.current) {
        return;
      }

      if (!result.ok) {
        /**
         * The worker could not answer, and the two reasons need different words.
         *
         * `unsupported_version` means the settings are intact and belong to a newer build. Everything else means
         * the stored value cannot be read — a migration whose *write* failed does not reach here, because the
         * repository answers with the valid migrated settings in that case.
         *
         * Nothing about the failure travels with it: it could name an internal storage path, and there is only one
         * thing a person can do about either.
         */
        setStatus(
          result.failure.kind === 'unsupported_version' ? 'unsupported_version' : 'unreadable',
        );

        return;
      }

      setSettings(result.data);
      setStatus('ready');
    });
  }, []);

  /**
   * Subscribes to the worker's settings announcements, then hydrates.
   *
   * The listener is installed **before** the first read is started, and that order is the point: the worker can
   * change the settings at any moment, and an announcement arriving between the read being issued and the listener
   * being registered would simply be lost — leaving the popup holding a value it had already been told was stale.
   * Registering first costs nothing, because an announcement that arrives during hydration just triggers another
   * read, and the newest-read-wins counter decides which answer survives.
   *
   * The popup gets no storage access from this. The notification says only that what it holds is out of date; the
   * value itself still comes back through the ordinary request/response boundary, validated as it always is.
   */
  useEffect(() => {
    const onSettingsChanged = (message: unknown): void => {
      // Ignored unless it is exactly the notification. A pushed message is not a reply to anything this popup
      // asked for, so it is the least trustworthy input the popup receives and is parsed strictly.
      if (!SettingsChangedNotificationSchema.safeParse(message).success) {
        return;
      }

      hydrate();
    };

    browser.runtime.onMessage.addListener(onSettingsChanged);
    hydrate();

    return () => {
      browser.runtime.onMessage.removeListener(onSettingsChanged);
      // Supersedes any read still in flight, so nothing sets state after unmount.
      latestRead.current += 1;
    };
  }, [hydrate]);

  /**
   * Turns a write reply into the settings it produced, or throws.
   *
   * The throw is what lets every caller keep its existing recoverable error state: a refusal is a value, a
   * transport failure is not something a surface can render meaningfully, so it is raised and caught where the
   * surface already has copy for it.
   */
  const applyWrite = useCallback(
    <Payload extends { readonly settings: AppSettings }>(
      result: SettingsResult<Payload>,
    ): Payload => {
      if (!result.ok) {
        if (result.failure.kind === 'unsupported_version') {
          /**
           * Every edit is refused for as long as the stored value belongs to a newer build, so the whole surface
           * moves to the explanatory state rather than reporting a per-edit error a person could keep retrying.
           */
          setStatus('unsupported_version');
        }

        throw new SettingsWriteFailedError();
      }

      // Whatever is now stored, including a newer selection a compare-and-clear deliberately left alone.
      setSettings(result.data.settings);

      return result.data;
    },
    [],
  );

  /**
   * Saves the settings surface's draft as one transactional change.
   *
   * The **intent** is sent rather than a settings snapshot: the worker rereads inside its serialized operation
   * and applies only these fields, so a value this popup observed earlier can never be written back over
   * somebody else's concurrent change.
   */
  const saveSettings = useCallback(
    async (input: {
      readonly settings: AppSettings;
      readonly evidence?: ServiceAreaCapabilityEvidence | undefined;
      /** The selection stored when the draft was created, so a stale draft is refused rather than applied. */
      readonly expectedSelection: ServiceAreaSelection | null;
    }): Promise<SettingsWritePayload> =>
      applyWrite(
        await messaging.saveSettings({
          expectedSelection: input.expectedSelection,
          selection: input.settings.selection,
          remindersEnabled: input.settings.remindersEnabled,
          reminderDaysBefore: input.settings.reminderDaysBefore,
          reminderTime: input.settings.reminderTime,
          visibleWasteTypes: input.settings.visibleWasteTypes,
          ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
        }),
      ),
    [applyWrite, messaging],
  );

  /**
   * Confirms a chosen area, which the repository refuses if it publishes no calendar.
   *
   * The evidence is taken from a validated response and travels with the intent, carrying the identity it was
   * read for, so the refusal is decided by the owner rather than by whichever surface asked — and it cannot be
   * decided on another area's availability.
   */
  const saveSelection = useCallback(
    async (input: {
      readonly selection: ServiceAreaSelection;
      readonly evidence: ServiceAreaCapabilityEvidence;
    }): Promise<SelectionWritePayload> => applyWrite(await messaging.selectServiceArea(input)),
    [applyWrite, messaging],
  );

  /**
   * Clears the stored selection only if it is still the one the caller saw.
   *
   * The expected selection travels with the request because the decision was made about a selection observed
   * earlier — a capability response is the end of a chain of requests, and someone can choose a different area
   * while that chain is still running. An unconditional clear would discard their new choice on the authority
   * of an answer about somewhere else.
   */
  const clearSelectionIfUnchanged = useCallback(
    async (expected: ServiceAreaSelection): Promise<SelectionInvalidationPayload> =>
      applyWrite(await messaging.invalidateSelectionIfMatches(expected)),
    [applyWrite, messaging],
  );

  return {
    clearSelectionIfUnchanged,
    /** Kept for the surfaces that only need "may I render the application yet". */
    isHydrated: status === 'ready',
    saveSelection,
    saveSettings,
    settings,
    status,
  };
};
