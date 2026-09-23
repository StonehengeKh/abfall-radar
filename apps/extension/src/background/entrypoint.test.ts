import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import background from '@/entrypoints/background';
import { API_ORIGIN } from '@/src/config/api';
import { defaultSettings } from '@/src/storage/settings';
import { writeSettings } from '@/src/storage/settings-repository';
import { REMINDER_ALARM } from './reminder';

/**
 * Drives the real background entrypoint, not a stand-in.
 *
 * The message handler is where the "no rejection escapes" rule is actually kept: a dropped reply leaves
 * the popup waiting on something that never arrives, and that cannot be proved by testing the gateway
 * alone. `defineBackground` returns its callback, so the entrypoint's wiring can be invoked directly.
 */

type MessageListener = (message: unknown, sender: unknown, sendResponse: unknown) => unknown;

/**
 * Runs the entrypoint and captures the listener it registered.
 *
 * The listener is then called the way Chrome calls it — `(message, sender, sendResponse)` — so its own
 * return value is observed rather than whatever the test double does with it.
 */
const runEntrypoint = (): { readonly listener: MessageListener } => {
  let captured: MessageListener | undefined;

  vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener').mockImplementation((listener: unknown) => {
    captured = listener as MessageListener;
  });

  background.main?.();

  if (captured === undefined) {
    throw new Error('The background entrypoint is expected to register a message listener.');
  }

  return { listener: captured };
};

const dispatch = async (
  listener: MessageListener,
  message: unknown,
): Promise<{ readonly returned: unknown; readonly replies: unknown[] }> => {
  const replies: unknown[] = [];
  const returned = listener(message, { id: 'test' }, (reply: unknown) => {
    replies.push(reply);
  });

  // The handler is asynchronous, so the reply arrives on a later microtask.
  await vi.waitFor(() => {
    expect(replies).toHaveLength(1);
  });

  return { returned, replies };
};

describe('the background entrypoint', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the message channel open by returning true', async () => {
    const { listener } = runEntrypoint();

    const { returned } = await dispatch(listener, { kind: 'list_providers' });

    // `sendResponse` plus `return true` is the selected compatibility baseline for the supported Chrome
    // versions. Returning anything falsy would close the channel before the reply arrived.
    expect(returned).toBe(true);
  });

  it('answers an unrecognized message with a kind-only failure rather than dropping the reply', async () => {
    const { listener } = runEntrypoint();

    const { replies } = await dispatch(listener, {
      kind: 'exfiltrate',
      secret: 'do-not-echo-this',
    });

    expect(replies[0]).toEqual({ ok: false, failure: { kind: 'unsupported_message' } });
    expect(JSON.stringify(replies[0])).not.toContain('do-not-echo-this');
  });

  it.each([
    ['a message that is not an object', 'list_providers'],
    ['a message with no kind', { providerId: 'koblenz-servicebetrieb' }],
    ['a malformed payload', { kind: 'list_service_areas' }],
    ['null', null],
  ])('always replies exactly once for %s', async (_reason, message) => {
    const { listener } = runEntrypoint();

    const { replies } = await dispatch(listener, message);

    // Exactly once: a second reply would throw in a real worker, and none would hang the popup.
    expect(replies).toHaveLength(1);
    expect(replies[0]).toEqual({ ok: false, failure: { kind: 'unsupported_message' } });
  });

  it('answers a local cache restore without reaching the network', async () => {
    const { listener } = runEntrypoint();

    const { replies } = await dispatch(listener, {
      kind: 'restore_cached_schedule',
      providerId: 'koblenz-servicebetrieb',
      serviceAreaId: 'koblenz-stadtmitte',
    });

    // Nothing is cached in a fresh profile, and that is not a failure.
    expect(replies[0]).toEqual({ ok: true, data: null });
  });

  it('creates no reminder alarm on a fresh install, because nothing is selected', async () => {
    /**
     * A fresh profile has no selection, so no reminder is possible — and an alarm that cannot produce one would
     * wake the service worker on a schedule to discover that, for as long as the extension stayed installed.
     */
    const cleared = vi.spyOn(fakeBrowser.alarms, 'clear');

    runEntrypoint();

    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'install', temporary: false });

    await vi.waitFor(() => {
      expect(cleared).toHaveBeenCalledWith(REMINDER_ALARM);
    });

    // Cleared and not recreated: the synchronization ran and decided against an alarm.
    expect(await fakeBrowser.alarms.get(REMINDER_ALARM)).toBeUndefined();
  });

  it('schedules the reminder alarm under its existing name once an area is selected', async () => {
    // The name and the schedule are unchanged; what changed is that eligibility is now required.
    await writeSettings({
      ...defaultSettings,
      selection: { providerId: 'koblenz-servicebetrieb', serviceAreaId: 'koblenz-stadtmitte' },
      visibleWasteTypes: ['paper'],
    });

    runEntrypoint();

    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'install', temporary: false });

    await vi.waitFor(async () => {
      expect(await fakeBrowser.alarms.get(REMINDER_ALARM)).toBeDefined();
    });
  });
});

/**
 * The production composition root builds its gateway on the configured API client.
 *
 * Every other gateway test injects a client, which proves the gateway and nothing about what the shipped worker
 * wires in. This drives the real entrypoint and observes the one thing that cannot be faked from inside: the
 * request that leaves the worker — its origin is the configured one, its path is the versioned contract, and its
 * validated answer is what the popup receives. Only `fetch` is replaced, because that is the network itself.
 */
describe('the background composition root', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('sends the popup’s reads through the configured API origin', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      return url.endsWith('/api/v1/cities')
        ? json({
            data: [
              {
                id: 'koblenz',
                name: 'Koblenz',
                providers: [
                  {
                    id: 'koblenz-servicebetrieb',
                    name: 'Kommunaler Servicebetrieb',
                    sourceKind: 'official_ics',
                  },
                ],
              },
            ],
          })
        : json({
            data: [
              {
                id: 'koblenz-servicebetrieb',
                name: 'Kommunaler Servicebetrieb',
                sourceKind: 'official_ics',
              },
            ],
          });
    });
    const { listener } = runEntrypoint();

    const providers = await dispatch(listener, { kind: 'list_providers' });
    const cities = await dispatch(listener, { kind: 'list_cities' });

    // Development builds default to the local API; whatever it is, it is the one validated configuration value.
    expect(API_ORIGIN).toBe(new URL(API_ORIGIN).origin);
    expect(fetched.mock.calls.map(([input]) => String(input))).toEqual([
      `${API_ORIGIN}/api/v1/providers`,
      `${API_ORIGIN}/api/v1/cities`,
    ]);
    expect(providers.replies[0]).toEqual({
      ok: true,
      data: [
        {
          id: 'koblenz-servicebetrieb',
          name: 'Kommunaler Servicebetrieb',
          sourceKind: 'official_ics',
        },
      ],
    });
    expect(cities.replies[0]).toMatchObject({
      ok: true,
      data: [{ id: 'koblenz', name: 'Koblenz' }],
    });
  });

  it('reports an unreachable API as a failure rather than substituting data', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    const { listener } = runEntrypoint();
    const { replies } = await dispatch(listener, { kind: 'list_providers' });

    // No fixture, no demo catalogue: the failure is what the popup is told.
    expect(replies[0]).toEqual({
      ok: false,
      failure: { kind: 'network', operation: 'listProviders' },
    });
  });
});
