import { storage } from 'wxt/utils/storage';
import { notifySettingsChanged } from '@/src/background/settings-broadcast';
import { describesArea, type ServiceAreaCapabilityEvidence } from '@/src/schedule/capability';
import { type AppSettings, AppSettingsSchema, type ServiceAreaSelection } from './settings';
import { migrateSettings, shouldPersistMigration } from './settings-migration';

/**
 * The **only** reader and writer of the persisted settings item.
 *
 * Both the popup and the background reminder path go through here. Neither reads the raw stored object,
 * because a second raw reader is exactly how a half-migrated value reaches a product surface — and
 * because the rule that an unavailable area can never be persisted has to hold whatever the UI does.
 */

const SETTINGS_KEY = 'local:settings' as const;

/**
 * Serializes every read-modify-write of the settings item.
 *
 * Each operation below reads the stored value, decides something from it, and writes the result back. Two of
 * them running concurrently would both read the same base and both write their own version, so the second
 * write silently discards the first — and one of those operations *clears the selection*. A capability refresh
 * deciding an area is withdrawn while the user is choosing a new one would read the old selection, then write
 * `null` over the choice they had just made.
 *
 * A promise chain needs no dependency. The tail is deliberately kept **non-rejecting**, so one failed mutation
 * cannot poison the queue and block every later operation; the failure still reaches its own caller through the
 * returned promise.
 *
 * A module-local queue only serializes callers that share the module instance, which is why this module is loaded
 * in **one** context. The popup and the Manifest V3 worker are separate instances, so a queue like this held on
 * both sides would serialize each against itself and neither against the other — and two contexts
 * read-modify-writing one storage key that way lose whichever write landed first. The service worker owns this
 * module outright: the popup reaches every operation here by message, and `src/boundaries.test.ts` proves it
 * cannot import this file, name the storage key, or reach the storage API at all. That boundary is what makes
 * this queue sufficient rather than a local illusion of one.
 *
 * Every mutation that **changes** what is stored ends by announcing it, from here rather than from each caller.
 * The worker can change the settings with nobody watching — an alarm clearing a withdrawn selection is the case
 * that matters — and an announcement made at the call sites instead would be one a future call site could omit.
 * `superseded` announces nothing, because nothing changed. A migration write announces nothing either: it
 * normalizes the representation without changing what the settings say.
 */
let mutationTail: Promise<void> = Promise.resolve();

const serializeMutation = <Result>(mutate: () => Promise<Result>): Promise<Result> => {
  const result = mutationTail.then(mutate);

  mutationTail = result.then(
    () => undefined,
    () => undefined,
  );

  return result;
};

/**
 * Typed as `unknown` on purpose: what is on disk may have been written by an older or a newer build, so
 * it is untrusted input until the migration has looked at it.
 */
const settingsItem = storage.defineItem<unknown>(SETTINGS_KEY, { fallback: null });

/**
 * Reads the stored settings, migrating whatever is on disk onto the current shape.
 *
 * The migration itself is pure and happens **in memory**; persisting the result is a separate, best-effort
 * step. That separation is the point:
 *
 * - a migrated value is already valid and complete before anything is written, so a storage failure has no
 *   bearing on whether this read can answer — and it used to reject instead, which left the popup on its
 *   preparation screen indefinitely with no error and no way forward;
 * - nothing is written unless the migration succeeded, so a failed or defaulted read can never be mistaken
 *   for a completed one next time;
 * - when the write fails, the legacy value is left exactly as it was, so the next read migrates again and
 *   attempts the write again. Recording the migration as done while the v2 value was not on disk would lose
 *   the legacy settings permanently.
 *
 * A failure to read the raw value is different in kind and is **not** swallowed: defaults returned in its
 * place would present a fresh installation to someone whose settings are simply unreadable at this moment,
 * and the selection they had chosen would look like a choice they had never made. It propagates, and the
 * surfaces above turn it into an explicit state.
 */
const readSettingsUnqueued = async (): Promise<AppSettings> => {
  const migration = migrateSettings(await settingsItem.getValue());

  if (shouldPersistMigration(migration)) {
    try {
      // Validated again on the way out by `writeSettings`.
      await writeSettings(migration.settings);
    } catch {
      /**
       * Best-effort, deliberately. The migrated settings are valid in memory and are what this read answers
       * with, so a person's carried-over settings work for this session even though storage refused the
       * write. Nothing about the error is surfaced from here: the caller has valid settings and there is
       * nothing for it to do differently.
       *
       * The legacy value stays untouched, which is what makes the next read retry rather than start over
       * from defaults.
       */
    }
  }

  return migration.settings;
};

/**
 * The raw write, and the **only** thing here that does not enter the queue.
 *
 * It is the primitive every queued body ends with, so it cannot queue itself without deadlocking the operation it
 * is inside. That makes it the one place from which the serialization guarantee can be bypassed: a production
 * caller outside a queued body would read and write against a value another mutation is mid-way through changing.
 * Every production call is inside one — the three mutations and the two migration persists — and outside this
 * module only tests reach it, to arrange a starting state before anything is running.
 */
export const writeSettings = async (settings: AppSettings): Promise<void> => {
  await settingsItem.setValue(AppSettingsSchema.parse(settings));
};

/**
 * Raised when the stored value was written by a **newer** build of this extension.
 *
 * An error rather than an outcome on each mutation's own result union, because it is not a decision any of them
 * made: every mutation is refused for the same reason, before it looks at its own input at all. Widening three
 * unions with a member none of them can act on would push every caller into handling it three times.
 *
 * It carries no detail: the stored object is the newer build's, and nothing about its contents is this build's to
 * describe.
 */
export class UnsupportedSettingsVersionError extends Error {
  constructor() {
    super('The stored settings were written by a newer version of the extension.');
    this.name = 'UnsupportedSettingsVersionError';
  }
}

/**
 * Refuses to proceed when the stored value belongs to a newer build.
 *
 * Called **inside** every serialized mutation, immediately before it reads or writes anything. Checking only at
 * hydration would be a check against a value that may since have changed: another window running a newer build
 * can write between this popup opening and its first save, and the queue is the only place where "what is stored"
 * and "what is about to be written" are the same moment.
 *
 * A newer value is preserved by doing nothing at all — the safest possible action, and the only one that keeps
 * settings this build cannot represent. Overwriting it with v2 defaults would silently discard whatever the newer
 * build had stored, including members this build has no name for.
 */
const assertMutable = async (): Promise<void> => {
  if (migrateSettings(await settingsItem.getValue()).outcome === 'unsupported_version') {
    throw new UnsupportedSettingsVersionError();
  }
};

/**
 * How far a settings read got, including the one outcome that is neither settings nor a failure to read.
 *
 * `unsupported_version` has to be distinguishable from `ready`, because the migration answers a newer value with
 * *defaults* — correct for keeping the stored object intact, and completely wrong to present as a person's
 * settings. A surface handed those defaults would show a fresh installation to someone whose real settings are on
 * disk, and every edit it offered would be refused.
 */
export type SettingsReadResult =
  | { readonly status: 'ready'; readonly settings: AppSettings }
  | { readonly status: 'unsupported_version' };

/**
 * The read every surface and the reminder go through when they need to know *whether* settings are usable.
 *
 * `readSettings` below still answers with the migrated value, which is what the mutations use once `assertMutable`
 * has confirmed the stored value is this build's to change.
 */
const readSettingsStateUnqueued = async (): Promise<SettingsReadResult> => {
  const migration = migrateSettings(await settingsItem.getValue());

  if (migration.outcome === 'unsupported_version') {
    // Nothing is written, and the raw value is left exactly as the newer build left it.
    return { status: 'unsupported_version' };
  }

  if (shouldPersistMigration(migration)) {
    try {
      await writeSettings(migration.settings);
    } catch {
      // Best-effort, for the reason `readSettings` documents: the migrated value is valid in memory either way.
    }
  }

  return { status: 'ready', settings: migration.settings };
};

/**
 * Both reads, on the **same** queue as every mutation.
 *
 * A read here is not read-only: when the stored value is a legacy one it migrates it and *writes* the result, so it
 * is a read-modify-write like any other and belongs behind the same tail. Outside it, the sequence was
 * read-legacy → (a mutation reads, computes and writes) → write-migrated, and the migration's write — built from a
 * snapshot taken before the mutation existed — silently discarded it. A withdrawn area could reappear that way, or
 * a save could vanish.
 *
 * The queued wrappers are separate functions from the bodies for a reason the finding names: a mutation already
 * holds the queue, so calling a *queued* read from inside one would await a tail that cannot advance until the
 * mutation it is inside has finished. The bodies are therefore the unqueued primitives, and only these two
 * entry points enter the queue.
 */
export const readSettings = (): Promise<AppSettings> => serializeMutation(readSettingsUnqueued);

export const readSettingsState = (): Promise<SettingsReadResult> =>
  serializeMutation(readSettingsStateUnqueued);

export type SelectionWriteResult =
  | { readonly outcome: 'persisted'; readonly settings: AppSettings }
  /** The area exists, but this provider publishes no calendar for it, so it cannot be chosen. */
  | { readonly outcome: 'rejected_unavailable' }
  /**
   * A selection was supplied with no capability to check it against. Refused rather than trusted: the whole
   * point of the check is that nobody may persist an area whose capability went unverified.
   */
  | { readonly outcome: 'rejected_unknown_capability' };

/**
 * What a write decided, without the value it may carry.
 *
 * Every surface that writes reports through this one type, so the settings surface and the onboarding surface
 * cannot drift into two vocabularies for the same three answers.
 */
export type SelectionWriteOutcome = SelectionWriteResult['outcome'];

/**
 * What saving a Settings **draft** decided.
 *
 * Wider than a selection write by exactly one member, and only this operation can produce it: a draft is built
 * from a value observed when the session opened, so it alone can be stale. Keeping the two apart means
 * `persistSelection` — which carries no draft — cannot be handed an outcome no path of it produces.
 */
export type SettingsWriteResult =
  | SelectionWriteResult
  /**
   * The selection changed after the draft was created, so the draft is stale and nothing was written.
   *
   * Carries what is stored **now**, so the surface can adopt it rather than re-reading and racing again. Not a
   * failure: nothing went wrong, and the newer value is the correct one.
   */
  | { readonly outcome: 'conflict'; readonly currentSettings: AppSettings };

export interface PersistSettingsInput {
  readonly settings: AppSettings;
  /**
   * Required whenever the selection is **new or changed**, and read from a validated response.
   *
   * Carries the identity it was read for, so it is evidence about a named area rather than a loose availability
   * flag that happens to travel beside a selection.
   */
  readonly evidence?: ServiceAreaCapabilityEvidence | undefined;
  /**
   * The selection that was stored when the draft was created.
   *
   * Not optional, and not defaulted: a caller that could omit it would silently opt out of the concurrency check,
   * which is the whole protection. Every Settings session captures this when it opens.
   */
  readonly expectedSelection: ServiceAreaSelection | null;
}

/**
 * Judges evidence against the area it is being offered for, or `null` when it may be persisted.
 *
 * Identity is checked **first**, and that order is the correction. Evidence about a different area says nothing
 * about this candidate — not that it is unavailable, and not that it is available — so reading its availability
 * at all would attribute a statement about somewhere else to the area being chosen. Mismatched evidence is
 * therefore reported as *no* evidence for this area, which is exactly what it is.
 *
 * Stated once and shared by every entry point that writes a selection, so no surface can be the one that skips
 * it. A rejection ends the whole mutation, including the preferences travelling with it: a draft is one
 * transactional value, and persisting half of it would store a combination nobody chose.
 */
const judgeEvidence = (
  evidence: ServiceAreaCapabilityEvidence,
  candidate: ServiceAreaSelection,
): { readonly outcome: 'rejected_unavailable' | 'rejected_unknown_capability' } | null => {
  if (!describesArea(evidence, candidate)) {
    return { outcome: 'rejected_unknown_capability' };
  }

  if (evidence.collectionEvents.availability === 'unavailable') {
    return { outcome: 'rejected_unavailable' };
  }

  return null;
};

const sameSelection = (
  left: ServiceAreaSelection | null,
  right: ServiceAreaSelection | null,
): boolean => {
  if (left === null || right === null) {
    return left === right;
  }

  return left.providerId === right.providerId && left.serviceAreaId === right.serviceAreaId;
};

/**
 * Persists a complete settings value as **one** logical operation.
 *
 * This is what the settings surface saves through. It exists so a save is never a sequence of partial
 * writes: persisting the selection first and the rest afterwards would leave storage in a state the user
 * never asked for if the second write failed, and it would make a cancelled edit unrecoverable because part
 * of it had already landed.
 *
 * The capability check lives here rather than in the UI, so an area that publishes no calendar is refused
 * whatever the surface does — the same invariant `persistSelection` enforces for the onboarding path.
 */
export const persistSettings = async ({
  settings,
  evidence,
  expectedSelection,
}: PersistSettingsInput): Promise<SettingsWriteResult> =>
  // Serialized with every other read-modify-write, so both checks below read the same stored value this
  // operation then writes against.
  serializeMutation(async () => {
    // Refused before anything is read or written: a newer build's value is not this build's to change.
    await assertMutable();

    const current = await readSettingsUnqueued();

    /**
     * Optimistic concurrency: the draft is refused if the selection changed under it.
     *
     * A Settings session is a draft built from what was stored when it opened, and it can stay open for as long as
     * a person is editing. Two things can change the selection in the meantime — a reminder discovering the area
     * was withdrawn and clearing it, or another popup window choosing a different one — and both are *newer* and
     * more authoritative than the draft. Writing the draft anyway would resurrect an area that had just been
     * invalidated, or overwrite somebody's new choice with the old one.
     *
     * Compared structurally rather than by identity, because the two values come from different reads.
     *
     * Nothing is written on a conflict, **including the preferences**: the draft is one transactional value, and
     * applying half of it would persist a combination the person never saw.
     */
    if (!sameSelection(current.selection, expectedSelection)) {
      return { outcome: 'conflict', currentSettings: current };
    }

    if (settings.selection !== null) {
      /**
       * Evidence is required only for a selection that is **new or changed**.
       *
       * Requiring it unconditionally meant a person could not change their reminder time or waste types while
       * the API was unreachable, because no capability was available to supply — settings that have nothing to
       * do with the selection became hostage to the network. Keeping an already-verified selection exactly as it
       * is asserts nothing new about it, so there is nothing to re-verify. Choosing a different area still
       * demands checked, available evidence for *that* area.
       */
      if (evidence === undefined) {
        if (!sameSelection(settings.selection, current.selection)) {
          return { outcome: 'rejected_unknown_capability' };
        }
      } else {
        const decision = judgeEvidence(evidence, settings.selection);

        if (decision !== null) {
          return decision;
        }
      }
    }

    await writeSettings(settings);
    notifySettingsChanged();

    return { outcome: 'persisted', settings };
  });

export interface PersistSelectionInput {
  readonly selection: ServiceAreaSelection;
  /** Taken from a validated service-areas response, never assumed, and naming the area it was read for. */
  readonly evidence: ServiceAreaCapabilityEvidence;
}

/**
 * Persists a selection, refusing an area whose capability says no calendar is published.
 *
 * The refusal lives here rather than only in the UI: a selection nobody can serve would produce a
 * permanently empty dashboard that reads as "no collections scheduled here", and that guarantee must not
 * depend on which surface happened to ask. A result is returned rather than thrown so a surface can
 * explain the refusal instead of crashing.
 */
export const persistSelection = async ({
  selection,
  evidence,
}: PersistSelectionInput): Promise<SelectionWriteResult> =>
  serializeMutation(async () => {
    await assertMutable();

    const decision = judgeEvidence(evidence, selection);

    if (decision !== null) {
      return decision;
    }

    const settings = { ...(await readSettingsUnqueued()), selection };

    await writeSettings(settings);
    notifySettingsChanged();

    return { outcome: 'persisted', settings };
  });

/**
 * What a compare-and-clear decided.
 *
 * `superseded` is not a failure. It means the stored selection is no longer the one the caller was told about,
 * so there was nothing of theirs left to clear — and the newer choice is returned untouched.
 */
export type SelectionInvalidation =
  | { readonly outcome: 'invalidated'; readonly settings: AppSettings }
  | { readonly outcome: 'superseded'; readonly settings: AppSettings };

/**
 * Clears the stored selection **only if it is still the one the caller saw**.
 *
 * The one case where the extension throws away a choice the user made: a successful capability response
 * reporting the stored area `unavailable`. Continuing to honour it would mean presenting a withdrawn calendar
 * as current official data.
 *
 * Compare-and-clear rather than clear, because the decision is always about a selection observed *earlier*.
 * A capability response is the end of a chain of requests, and a reminder's chain can run for seconds while the
 * popup is open — long enough for someone to pick a different area. An unconditional clear would then discard
 * the choice they had just made, on the authority of an answer about somewhere else entirely.
 *
 * The reread happens **inside** the serialized operation, so the value compared is the value written against:
 * reading first and clearing afterwards would leave exactly the window this exists to close. Every unrelated
 * preference — reminders, lead time, waste types — is preserved, because only the selection was withdrawn.
 */
export const invalidateSelectionIfMatches = async (
  expectedSelection: ServiceAreaSelection,
): Promise<SelectionInvalidation> =>
  serializeMutation(async () => {
    await assertMutable();

    const current = await readSettingsUnqueued();

    if (!sameSelection(current.selection, expectedSelection)) {
      // Somebody chose differently in the meantime. Their choice stands, and it is re-evaluated on its own
      // merits by whichever surface is showing it.
      return { outcome: 'superseded', settings: current };
    }

    const settings = { ...current, selection: null };

    await writeSettings(settings);
    notifySettingsChanged();

    return { outcome: 'invalidated', settings };
  });

/**
 * Watches the stored item and reports migrated settings.
 *
 * The raw value never escapes: a watcher receives what the migration produced, exactly like a reader.
 */
export const watchSettings = (onChange: (settings: AppSettings) => void): (() => void) =>
  settingsItem.watch((raw) => {
    onChange(migrateSettings(raw).settings);
  });
