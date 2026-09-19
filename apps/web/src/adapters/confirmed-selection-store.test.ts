import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIRMED_SELECTION_STORAGE_KEY,
  CONFIRMED_SELECTION_VERSION,
  createConfirmedSelectionStore,
  noConfirmedSelectionStore,
  parseConfirmedSelection,
} from '@/src/adapters/confirmed-selection-store';

/**
 * What survives between visits, and what a bad record may never do.
 *
 * Everything read here is untrusted input: an older build of this application wrote it, or a person
 * edited it by hand. The rule under test is that a record either parses completely — city, provider and
 * district of the expected version — or is discarded, and that no access can throw into the caller.
 */

const record = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: CONFIRMED_SELECTION_VERSION,
    cityId: 'koblenz',
    providerId: 'koblenz-servicebetrieb',
    serviceAreaId: 'koblenz-neuendorf',
    ...overrides,
  });

/** A `Storage` that behaves, so the store's own guards are what the failing cases exercise. */
const memory = (initial: string | null = null): Storage => {
  const values = new Map<string, string>();

  if (initial !== null) {
    values.set(CONFIRMED_SELECTION_STORAGE_KEY, initial);
  }

  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } satisfies Storage;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseConfirmedSelection', () => {
  it('accepts a complete record of the current version', () => {
    expect(parseConfirmedSelection(record())).toEqual({
      version: CONFIRMED_SELECTION_VERSION,
      cityId: 'koblenz',
      providerId: 'koblenz-servicebetrieb',
      serviceAreaId: 'koblenz-neuendorf',
    });
  });

  it.each([
    ['nothing stored', null],
    ['not JSON', '{'],
    ['a JSON array', '["koblenz"]'],
    ['a JSON string', '"koblenz"'],
    ['null', 'null'],
  ])('rejects %s', (_case, raw) => {
    expect(parseConfirmedSelection(raw)).toBeNull();
  });

  it('rejects another version, rather than reading its fields', () => {
    expect(
      parseConfirmedSelection(record({ version: CONFIRMED_SELECTION_VERSION - 1 })),
    ).toBeNull();
    expect(
      parseConfirmedSelection(record({ version: CONFIRMED_SELECTION_VERSION + 1 })),
    ).toBeNull();
    expect(parseConfirmedSelection(record({ version: '1' }))).toBeNull();
  });

  it.each(['cityId', 'providerId', 'serviceAreaId'])(
    'never returns a district without %s',
    (field) => {
      expect(parseConfirmedSelection(record({ [field]: undefined }))).toBeNull();
      expect(parseConfirmedSelection(record({ [field]: '' }))).toBeNull();
      expect(parseConfirmedSelection(record({ [field]: '   ' }))).toBeNull();
      expect(parseConfirmedSelection(record({ [field]: 42 }))).toBeNull();
      expect(parseConfirmedSelection(record({ [field]: null }))).toBeNull();
    },
  );

  it('keeps only the four known members, so nothing else can ride along', () => {
    const parsed = parseConfirmedSelection(record({ schedule: [{ date: '2026-09-22' }] }));

    expect(parsed === null ? [] : Object.keys(parsed).sort()).toEqual([
      'cityId',
      'providerId',
      'serviceAreaId',
      'version',
    ]);
  });
});

describe('the store over a Storage', () => {
  it('writes the version itself and reads the record back', () => {
    const storage = memory();
    const store = createConfirmedSelectionStore(storage);

    store.write({
      cityId: 'koblenz',
      providerId: 'koblenz-servicebetrieb',
      serviceAreaId: 'koblenz-neuendorf',
    });

    expect(JSON.parse(storage.getItem(CONFIRMED_SELECTION_STORAGE_KEY) ?? 'null')).toEqual({
      version: CONFIRMED_SELECTION_VERSION,
      cityId: 'koblenz',
      providerId: 'koblenz-servicebetrieb',
      serviceAreaId: 'koblenz-neuendorf',
    });
    expect(store.read()?.serviceAreaId).toBe('koblenz-neuendorf');

    store.clear();

    expect(store.read()).toBeNull();
    expect(storage.getItem(CONFIRMED_SELECTION_STORAGE_KEY)).toBeNull();
  });

  it('removes a record it cannot parse, instead of reading it again on every visit', () => {
    const storage = memory('{ not json');
    const store = createConfirmedSelectionStore(storage);

    expect(store.read()).toBeNull();
    expect(storage.getItem(CONFIRMED_SELECTION_STORAGE_KEY)).toBeNull();
  });

  it('degrades to remembering nothing when storage throws on every access', () => {
    const hostile = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      removeItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      clear: () => undefined,
      key: () => null,
      length: 0,
    } as unknown as Storage;
    const store = createConfirmedSelectionStore(hostile);

    expect(() => store.write({ cityId: 'a', providerId: 'b', serviceAreaId: 'c' })).not.toThrow();
    expect(store.read()).toBeNull();
    expect(() => store.clear()).not.toThrow();
  });

  it('is inert without a storage at all', () => {
    const store = createConfirmedSelectionStore(undefined);

    store.write({ cityId: 'a', providerId: 'b', serviceAreaId: 'c' });

    expect(store.read()).toBeNull();
  });

  it('remembers nothing through the no-op store', () => {
    const store = noConfirmedSelectionStore();

    store.write({ cityId: 'a', providerId: 'b', serviceAreaId: 'c' });

    expect(store.read()).toBeNull();
  });
});
