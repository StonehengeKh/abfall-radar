import { describe, expect, it, vi } from 'vitest';
import {
  AVAILABLE_EVIDENCE,
  CATALOGUE_WITH_DEMO,
  MIXED_AREAS,
  mobileDropOffEvent,
  restoredSchedule,
  schedule,
} from '@/src/test/fixtures';
import { createMessagingClient, type SendMessage } from './client';
import type { GatewayRequest } from './contract';

const OFFICIAL_PROVIDER_ID = 'koblenz-servicebetrieb';

const OFFICIAL_AREA_ID = 'koblenz-stadtmitte';

const clientWith = (reply: unknown | ((request: GatewayRequest) => unknown)) => {
  const send = vi.fn<SendMessage>(async (request) =>
    typeof reply === 'function' ? (reply as (r: GatewayRequest) => unknown)(request) : reply,
  );

  return { client: createMessagingClient(send), send };
};

describe('the messaging client requests', () => {
  it('sends the documented request for the provider catalogue', async () => {
    const { client, send } = clientWith({ ok: true, data: CATALOGUE_WITH_DEMO });

    await client.listProviders();

    expect(send).toHaveBeenCalledWith({ kind: 'list_providers' });
  });

  it('sends the documented request for a provider’s areas', async () => {
    const { client, send } = clientWith({ ok: true, data: MIXED_AREAS });

    await client.listServiceAreas(OFFICIAL_PROVIDER_ID);

    expect(send).toHaveBeenCalledWith({
      kind: 'list_service_areas',
      providerId: OFFICIAL_PROVIDER_ID,
    });
  });

  it('sends the documented request for a bounded range', async () => {
    const { client, send } = clientWith({
      ok: true,
      data: { kind: 'live', schedule: schedule() },
    });

    await client.listCollectionEvents({
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
      from: '2026-03-01',
      to: '2026-05-30',
    });

    expect(send).toHaveBeenCalledWith({
      kind: 'list_collection_events',
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
      from: '2026-03-01',
      to: '2026-05-30',
    });
  });

  it('sends the local invalidation with no range at all', async () => {
    const { client, send } = clientWith({ ok: true, data: null });

    await client.invalidateCachedSchedule({
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
    });

    // The popup asks the worker to drop the entry rather than touching that storage item itself.
    expect(send).toHaveBeenCalledWith({
      kind: 'invalidate_cached_schedule',
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
    });
  });

  it('rejects a malformed reply to an invalidation', async () => {
    const { client } = clientWith({ ok: true, data: { unexpected: true } });

    expect(
      await client.invalidateCachedSchedule({
        providerId: OFFICIAL_PROVIDER_ID,
        serviceAreaId: OFFICIAL_AREA_ID,
      }),
    ).toEqual({ ok: false, failure: { kind: 'unsupported_message' } });
  });

  it('sends the local restore with no range at all', async () => {
    const { client, send } = clientWith({ ok: true, data: null });

    await client.restoreCachedSchedule({
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
    });

    // No `from` or `to`: the worker derives the window from the entry's own capability snapshot, so a
    // caller cannot ask for a range the cache was never evaluated against.
    expect(send).toHaveBeenCalledWith({
      kind: 'restore_cached_schedule',
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
    });
  });
});

describe('the messaging client replies', () => {
  it('returns validated data', async () => {
    const { client } = clientWith({ ok: true, data: CATALOGUE_WITH_DEMO });
    const result = await client.listProviders();

    expect(result).toEqual({ ok: true, data: CATALOGUE_WITH_DEMO });
  });

  it('returns a restored schedule with its coverage and display range', async () => {
    const restored = restoredSchedule({ rangeCoverage: 'partial' });
    const { client } = clientWith({ ok: true, data: restored });
    const result = await client.restoreCachedSchedule({
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
    });

    expect(result.ok && result.data?.coverage).toBe('partial');
  });

  it('returns a live collection-events reply under its own discriminant', async () => {
    const payload = schedule();
    const { client } = clientWith({ ok: true, data: { kind: 'live', schedule: payload } });
    const result = await client.listCollectionEvents({
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
      from: '2026-03-01',
      to: '2026-05-30',
    });

    expect(result).toEqual({ ok: true, data: { kind: 'live', schedule: payload } });
  });

  it('returns a newer stored entry as cached, so it can never be relabelled as live', async () => {
    // The worker answers with the stored entry when the response it retrieved was older. The discriminant is
    // what stops the popup putting a current-data label on it.
    const restored = restoredSchedule({ rangeCoverage: 'partial' });
    const { client } = clientWith({ ok: true, data: { kind: 'cached', restored } });
    const result = await client.listCollectionEvents({
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
      from: '2026-03-01',
      to: '2026-05-30',
    });

    expect(result.ok && result.data.kind).toBe('cached');
    expect(result.ok && result.data.kind === 'cached' && result.data.restored.coverage).toBe(
      'partial',
    );
  });

  it('refuses an undiscriminated schedule, so a bare payload cannot pass as an answer', async () => {
    // A reply that predates the discriminated payload is not a partially trusted schedule; it is a reply
    // that does not satisfy the contract.
    const { client } = clientWith({ ok: true, data: schedule() });
    const result = await client.listCollectionEvents({
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
      from: '2026-03-01',
      to: '2026-05-30',
    });

    expect(result).toEqual({ ok: false, failure: { kind: 'unsupported_message' } });
  });

  it('treats a null restore as nothing cached rather than as a failure', async () => {
    const { client } = clientWith({ ok: true, data: null });
    const result = await client.restoreCachedSchedule({
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
    });

    expect(result).toEqual({ ok: true, data: null });
  });

  it('passes a failure envelope through unchanged', async () => {
    const failure = { kind: 'network', operation: 'listProviders' };
    const { client } = clientWith({ ok: false, failure });

    expect(await client.listProviders()).toEqual({ ok: false, failure });
  });

  it.each([
    ['a reply that is not an object', 'ok'],
    ['an undefined reply', undefined],
    ['a reply with no envelope', { data: [] }],
    ['a success envelope carrying the wrong payload', { ok: true, data: { unexpected: true } }],
    ['a failure envelope with an unknown kind', { ok: false, failure: { kind: 'exploded' } }],
    [
      'a failure envelope carrying a request identifier it may not have',
      { ok: false, failure: { kind: 'network', operation: 'listProviders', requestId: 'req-1' } },
    ],
    ['an envelope with an extra member', { ok: true, data: [], extra: true }],
  ])('rejects %s as an unsupported message', async (_reason, reply) => {
    const { client } = clientWith(reply);

    expect(await client.listProviders()).toEqual({
      ok: false,
      failure: { kind: 'unsupported_message' },
    });
  });

  it('reports a rejected send as an unsupported message rather than throwing', async () => {
    // A worker that is not listening leaves nothing usable to report, and there is no operation or request
    // identifier to attribute it to.
    const send = vi.fn<SendMessage>().mockRejectedValue(new Error('no receiving end at /internal'));
    const client = createMessagingClient(send);
    const result = await client.listProviders();

    expect(result).toEqual({ ok: false, failure: { kind: 'unsupported_message' } });
    expect(JSON.stringify(result)).not.toContain('/internal');
  });

  it('carries a validated problem failure with its request identifier', async () => {
    const failure = {
      kind: 'problem',
      operation: 'listCollectionEvents',
      status: 422,
      code: 'SCHEDULE_RANGE_NOT_COVERED',
      requestId: 'req-9',
    };
    const { client } = clientWith({ ok: false, failure });
    const result = await client.listCollectionEvents({
      providerId: OFFICIAL_PROVIDER_ID,
      serviceAreaId: OFFICIAL_AREA_ID,
      from: '2025-01-01',
      to: '2025-12-31',
    });

    expect(result).toEqual({ ok: false, failure });
  });
});

/**
 * A settings command answers in its own failure family.
 *
 * A settings command performs no HTTP request, so nothing in the API failure union describes it truthfully — and
 * accepting one would let a fabricated `operation` and `status` reach a surface that has no honest use for either.
 */
describe('the settings commands', () => {
  const SELECTION = {
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: OFFICIAL_AREA_ID,
  } as const;

  const SETTINGS = {
    version: 2,
    selection: SELECTION,
    remindersEnabled: true,
    reminderDaysBefore: 1,
    reminderTime: '18:00',
    visibleWasteTypes: ['paper'],
  } as const;

  it('sends the draft premise with a save, so a stale draft can be refused', async () => {
    const { client, send } = clientWith({
      ok: true,
      data: { outcome: 'persisted', settings: SETTINGS },
    });

    await client.saveSettings({
      expectedSelection: SELECTION,
      selection: SELECTION,
      remindersEnabled: false,
      reminderDaysBefore: 2,
      reminderTime: '20:00',
      visibleWasteTypes: ['bio'],
    });

    expect(send).toHaveBeenCalledWith({
      kind: 'save_settings',
      expectedSelection: SELECTION,
      selection: SELECTION,
      remindersEnabled: false,
      reminderDaysBefore: 2,
      reminderTime: '20:00',
      visibleWasteTypes: ['bio'],
    });
  });

  it('accepts a conflict outcome and the settings it returns', async () => {
    const { client } = clientWith({
      ok: true,
      data: { outcome: 'conflict', settings: { ...SETTINGS, selection: null } },
    });

    const result = await client.saveSettings({
      expectedSelection: SELECTION,
      selection: SELECTION,
      remindersEnabled: true,
      reminderDaysBefore: 1,
      reminderTime: '18:00',
      visibleWasteTypes: ['paper'],
    });

    expect(result.ok && result.data.outcome).toBe('conflict');
    // The value to adopt, so the surface stops showing the stale selection.
    expect(result.ok && result.data.settings.selection).toBeNull();
  });

  it('accepts the local storage failure, carrying its kind alone', async () => {
    const { client } = clientWith({ ok: false, failure: { kind: 'settings_storage' } });
    const result = await client.readSettings();

    expect(result).toEqual({ ok: false, failure: { kind: 'settings_storage' } });
  });

  it.each([
    [
      'an HTTP problem failure',
      { kind: 'problem', operation: 'listProviders', status: 500, code: 'X', requestId: 'r' },
    ],
    ['a network failure', { kind: 'network', operation: 'listProviders' }],
    [
      'an invalid-response failure',
      { kind: 'invalid_response', operation: 'listProviders', status: 0 },
    ],
    ['a timeout failure', { kind: 'timeout', operation: 'listProviders', timeoutMs: 8000 }],
  ])('refuses %s, which cannot describe a settings command', async (_reason, failure) => {
    // Reported as an unsupported message rather than passed through: an API failure arriving here means the reply
    // did not satisfy the settings contract at all.
    const { client } = clientWith({ ok: false, failure });

    expect(await client.readSettings()).toEqual({
      ok: false,
      failure: { kind: 'unsupported_message' },
    });
  });

  it('refuses a settings failure carrying an operation it may not have', async () => {
    const { client } = clientWith({
      ok: false,
      failure: { kind: 'settings_storage', operation: 'listProviders' },
    });

    expect(await client.readSettings()).toEqual({
      ok: false,
      failure: { kind: 'unsupported_message' },
    });
  });

  it('reports a worker that is not listening as an unsupported message', async () => {
    const send = vi.fn<SendMessage>().mockRejectedValue(new Error('no receiving end at /internal'));
    const client = createMessagingClient(send);
    const result = await client.selectServiceArea({
      selection: SELECTION,
      evidence: AVAILABLE_EVIDENCE,
    });

    expect(result).toEqual({ ok: false, failure: { kind: 'unsupported_message' } });
    expect(JSON.stringify(result)).not.toContain('/internal');
  });
});

/**
 * A message is a boundary too, so a non-canonical place name is refused there as well.
 *
 * The worker produced it, but a reply crosses a process boundary and is validated on arrival like any other
 * untrusted input — and this schema also validates every persisted cache entry, so accepting an untrimmed name
 * here would file a place under a spelling the domain rejects.
 */
describe('a collection-events reply whose drop-off location is not canonical', () => {
  const COLLECTION_EVENTS_REQUEST = {
    providerId: OFFICIAL_PROVIDER_ID,
    serviceAreaId: OFFICIAL_AREA_ID,
    from: '2026-03-01',
    to: '2026-05-30',
  } as const;

  const replyWithLocationName = (name: string) => ({
    ok: true,
    data: {
      kind: 'live',
      schedule: schedule({
        events: [{ ...mobileDropOffEvent('2026-03-10'), location: { name } }],
      }),
    },
  });

  it.each([
    ['leading whitespace', ' Rizzastraße'],
    ['trailing whitespace', 'Rizzastraße '],
    ['whitespace at both ends', ' Rizzastraße '],
    ['nothing but whitespace', '   '],
    ['nothing at all', ''],
  ])('is refused as an unsupported message for %s', async (_reason, name) => {
    const { client } = clientWith(replyWithLocationName(name));

    expect(await client.listCollectionEvents(COLLECTION_EVENTS_REQUEST)).toEqual({
      ok: false,
      failure: { kind: 'unsupported_message' },
    });
  });

  it('reveals nothing of the refused value', async () => {
    const { client } = clientWith(replyWithLocationName(' Rizzastraße '));
    const result = await client.listCollectionEvents(COLLECTION_EVENTS_REQUEST);

    expect(JSON.stringify(result)).not.toContain('Rizzastraße');
  });

  it('still accepts a canonical name, so the rule is not refusing every drop-off', async () => {
    const { client } = clientWith(replyWithLocationName('Rizzastraße Ecke Südallee'));
    const result = await client.listCollectionEvents(COLLECTION_EVENTS_REQUEST);

    expect(result.ok).toBe(true);
  });
});
