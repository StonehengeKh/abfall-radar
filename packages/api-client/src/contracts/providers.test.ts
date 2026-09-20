import { describe, expect, it } from 'vitest';
import { mutableCopy, PROVIDER_LIST_BODY } from '../test/response-fixtures';
import { CityListResponseSchema, ProviderListResponseSchema, ProviderSchema } from './providers';

describe('ProviderListResponseSchema', () => {
  it('parses the provider catalogue the API returns', () => {
    expect(ProviderListResponseSchema.parse(PROVIDER_LIST_BODY)).toEqual(PROVIDER_LIST_BODY);
  });

  it('accepts an unknown property and strips it, so an additive server field cannot break an installed build', () => {
    const body = { ...mutableCopy(PROVIDER_LIST_BODY), addedLater: 'ignored' };
    const parsed = ProviderListResponseSchema.parse(body);

    expect(Object.keys(parsed)).toEqual(['data']);
  });

  it('strips an unknown property from a nested provider too, so it cannot reach a cache or a UI', () => {
    const parsed = ProviderListResponseSchema.parse({
      data: [{ id: 'demo', name: 'Demo provider', sourceKind: 'demo', region: 'added later' }],
    });

    expect(parsed.data[0]).toEqual({ id: 'demo', name: 'Demo provider', sourceKind: 'demo' });
  });

  it('rejects a missing required member', () => {
    expect(ProviderListResponseSchema.safeParse({}).success).toBe(false);
    expect(ProviderSchema.safeParse({ id: 'demo', name: 'Demo provider' }).success).toBe(false);
  });

  it.each([
    ['a wrong-typed data member', { data: 'demo' }],
    ['a wrong-typed identifier', { data: [{ id: 7, name: 'Demo provider', sourceKind: 'demo' }] }],
    ['an empty identifier', { data: [{ id: '', name: 'Demo provider', sourceKind: 'demo' }] }],
    [
      'an unrecognized source kind',
      { data: [{ id: 'demo', name: 'Demo provider', sourceKind: 'community' }] },
    ],
  ])('rejects %s', (_reason, body) => {
    expect(ProviderListResponseSchema.safeParse(body).success).toBe(false);
  });

  it('keeps the demo source kind readable, because filtering it out is a caller decision', () => {
    const parsed = ProviderListResponseSchema.parse(PROVIDER_LIST_BODY);

    expect(parsed.data.map((provider) => provider.sourceKind)).toEqual(['demo', 'official_ics']);
  });
});

describe('CityListResponseSchema', () => {
  const koblenz = {
    id: 'koblenz',
    name: 'Koblenz',
    providers: [
      {
        id: 'koblenz-servicebetrieb',
        name: 'Kommunaler Servicebetrieb',
        sourceKind: 'official_ics',
      },
    ],
  };

  it('parses a city with the official providers behind it', () => {
    expect(CityListResponseSchema.parse({ data: [koblenz] })).toEqual({ data: [koblenz] });
  });

  it('strips an unknown member rather than failing an additive change', () => {
    const parsed = CityListResponseSchema.parse({
      data: [{ ...koblenz, population: 114_000 }],
    });

    expect(Object.keys(parsed.data[0] ?? {}).toSorted()).toEqual(['id', 'name', 'providers']);
  });

  it.each([
    ['no providers at all', { ...koblenz, providers: [] }],
    ['a missing name', { id: 'koblenz', providers: koblenz.providers }],
    ['an empty identifier', { ...koblenz, id: '' }],
    ['a provider missing its source kind', { ...koblenz, providers: [{ id: 'p', name: 'P' }] }],
  ])('rejects a city with %s', (_reason, city) => {
    // A city with nothing behind it describes something no surface can act on, so it is refused at the
    // boundary rather than guarded again in every consumer.
    expect(CityListResponseSchema.safeParse({ data: [city] }).success).toBe(false);
  });
});
