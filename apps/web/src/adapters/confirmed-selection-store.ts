/**
 * The one thing about a schedule worth remembering between visits: which selection was confirmed.
 *
 * Only identity is stored — the city, the provider and the district — so a reload can ask the API the
 * same question again. No schedule, no provenance, no dates: published data is re-read every time and
 * never served from a previous visit, because a collection date from last week is exactly the kind of
 * stale answer this product must not give. Nothing about a draft, a search, a spinner or a failure is
 * stored either; an unconfirmed intention is not a selection.
 *
 * The record is versioned and parsed on every read. What comes back from `localStorage` is untrusted
 * input: another version of this application wrote it, or a person edited it, or the browser handed
 * back something else entirely, and a record that does not parse is discarded rather than repaired.
 */

/** Bumped whenever the shape changes; an older or newer record is discarded, never migrated in place. */
export const CONFIRMED_SELECTION_VERSION = 1;

export const CONFIRMED_SELECTION_STORAGE_KEY = 'abfall-radar.confirmed-selection';

export interface StoredConfirmedSelection {
  readonly version: number;
  readonly cityId: string;
  readonly providerId: string;
  readonly serviceAreaId: string;
}

/**
 * The controller's view of persistence: three operations, none of which may throw.
 *
 * An interface rather than the functions themselves, so a test can hand the controller a record without
 * a DOM, and so a browsing context with no usable storage is an ordinary implementation instead of a
 * special case inside the controller.
 */
export interface ConfirmedSelectionStore {
  read(): StoredConfirmedSelection | null;
  write(selection: Omit<StoredConfirmedSelection, 'version'>): void;
  clear(): void;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/**
 * Parses one stored record.
 *
 * A district is only ever returned with its city and its provider: all three identifiers are required
 * together, because a district restored under the wrong city — or under no city at all — would be a
 * different place with the same name. Anything else, including a record of another version, is `null`.
 */
export const parseConfirmedSelection = (raw: string | null): StoredConfirmedSelection | null => {
  if (raw === null) {
    return null;
  }

  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (record.version !== CONFIRMED_SELECTION_VERSION) {
    return null;
  }

  const { cityId, providerId, serviceAreaId } = record;

  if (
    !isNonEmptyString(cityId) ||
    !isNonEmptyString(providerId) ||
    !isNonEmptyString(serviceAreaId)
  ) {
    return null;
  }

  return { version: CONFIRMED_SELECTION_VERSION, cityId, providerId, serviceAreaId };
};

/**
 * A store over a `Storage`, or over nothing at all.
 *
 * Every access is guarded exactly as the language and appearance preferences are: a private window,
 * blocked site data or a full quota makes `localStorage` throw on access rather than return nothing.
 * A failure means the selection is not remembered — never that the application stops working.
 *
 * A record that cannot be parsed is removed as it is read. It cannot become valid later, and leaving it
 * behind would mean parsing the same unusable string on every visit.
 */
export const createConfirmedSelectionStore = (
  storage: Storage | undefined,
): ConfirmedSelectionStore => ({
  read: () => {
    let raw: string | null;

    try {
      raw = storage?.getItem(CONFIRMED_SELECTION_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }

    if (raw === null) {
      return null;
    }

    const parsed = parseConfirmedSelection(raw);

    if (parsed === null) {
      try {
        storage?.removeItem(CONFIRMED_SELECTION_STORAGE_KEY);
      } catch {
        // Nothing to do: the record is ignored either way.
      }
    }

    return parsed;
  },
  write: (selection) => {
    try {
      storage?.setItem(
        CONFIRMED_SELECTION_STORAGE_KEY,
        JSON.stringify({ version: CONFIRMED_SELECTION_VERSION, ...selection }),
      );
    } catch {
      // The selection is simply not remembered.
    }
  },
  clear: () => {
    try {
      storage?.removeItem(CONFIRMED_SELECTION_STORAGE_KEY);
    } catch {
      // Already unreachable; there is nothing further to clear.
    }
  },
});

/** Remembers nothing: the default when no store is supplied, and every visit starts at the city step. */
export const noConfirmedSelectionStore = (): ConfirmedSelectionStore => ({
  read: () => null,
  write: () => undefined,
  clear: () => undefined,
});

export const browserConfirmedSelectionStore = (): ConfirmedSelectionStore =>
  createConfirmedSelectionStore(
    typeof window === 'undefined' ? undefined : (window.localStorage ?? undefined),
  );
