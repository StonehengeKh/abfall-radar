import { describe, expect, it } from 'vitest';
import { mutableCopy, PROVIDER_LIST_BODY } from '../test/response-fixtures';
import { ProviderListResponseSchema, ProviderSchema } from './providers';

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
