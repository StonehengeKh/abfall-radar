# Web application

The responsive AbfallRadar web application: a person chooses an official provider and service area and
sees the municipality's published collection schedule with its provenance intact.

Architecture and rationale: [ADR 0005](../../docs/decisions/0005-responsive-web-schedule.md). The
implemented scope is [AR-005](../../docs/tasks/AR-005-responsive-web-schedule.md). This file describes
how to run and reason about the workspace; it does not restate either document.

## Commands

```bash
pnpm dev:api                     # the API this application reads, on http://127.0.0.1:3000
pnpm dev:web                     # the web application, on http://localhost:5173
pnpm --filter @abfall-radar/web test
pnpm --filter @abfall-radar/web typecheck
pnpm exec turbo run test:build-output --filter=@abfall-radar/web   # fresh build, then the emitted-artifact scan
```

Open <http://localhost:5173> with `pnpm dev:api` already running.

`pnpm --filter @abfall-radar/web test:build-output` is **not** authoritative: `pnpm --filter` does not
honour `turbo.json`, so it would inspect whatever `dist` happens to be on disk. Every authoritative
invocation goes through Turbo, which builds first.

## The data layer

`src/adapters/` is the only place an HTTP request exists.

- `browser-origin.ts` resolves the origin from the **serialized global origin** and the location
  origin. The global origin is authoritative: a sandboxed frame reports an ordinary HTTPS location
  beside a `"null"` global origin, and a request from it could not be attributed. A rejection ends in
  a rendered configuration state, never in a silent absence of requests.
- `api-client.ts` constructs one `@abfall-radar/api-client` with a browser `fetch` wrapper that sets
  `cache: 'no-store'` **last**, so a caller-supplied cache mode cannot override it. This stops the
  browser HTTP cache from answering or storing these requests; it does not bypass the API's own
  server-side source cache.
- `schedule-gateway.ts` exposes exactly the three reads the product needs and returns the client's
  results unchanged — no product retry, no persisted schedule, no second validation pass.

Application code reaches the client **through** that boundary; only an adapter imports the package,
and `src/boundaries.test.ts` enforces it.

## Same-origin requests and the development proxy

Production requests are same-origin. In development, `vite.config.ts` proxies the segment-aware
context `^/api(?:/|$)` to `http://127.0.0.1:3000`, so local development has the same shape as the
eventual deployment. That literal belongs to the dev server and never enters the production bundle.

Stopping `apps/api` while the dev server runs does **not** produce a network failure: the proxy still
answers, with a `text/plain` error, which the client reports as an unusable response.

## States

Nine top-level states, each with its own German copy and live-region announcement: the configuration
state, the selection flow, an empty official catalogue, an empty area list, schedule loading, a live
schedule (fresh or upstream-stale), a successful empty schedule, "no calendar for this period", and a
phase-aware failure. A successful empty response is **not** an error, and the declared coverage stays
visible beside it.

## What is remembered between visits

One key in `localStorage`, `abfall-radar.confirmed-selection`, holding a small versioned record of the
**confirmed** selection context:

```json
{ "version": 1, "cityId": "…", "providerId": "…", "serviceAreaId": "…" }
```

Identifiers and a version, and nothing else. Alongside it sit the two presentation preferences,
`abfall-radar.theme` and `abfall-radar.locale`.

**Not stored:** the schedule and any part of it — no collection events, dates, waste types, provenance
or retrieval instants — no API response, and nothing transient: no draft selection, no search text, no
loading or error state, no menu state, no scroll position and no focus. No cookie, no `IndexedDB`, no
service worker, no server-side persistence and no account.

The record is written only when a confirmed schedule has been **accepted**, so a draft, an abandoned
reopen and a failed confirmation all leave the previous record as it was.

On the next visit it is revalidated rather than trusted: the same reads a person's own flow makes —
cities, that city's providers, then that provider's districts in that city — and the schedule is
fetched again from the API. A record that no longer matches the catalogue is cleared, and the person
lands on the step that has to be decided again; a malformed or older record is discarded as it is read.
A read that fails leaves the record alone, because a catalogue that could not be read says nothing
about whether the district still exists. Clearing site data, or a browser that refuses storage, simply
returns the ordinary city-selection flow.

## What the tests prove, and what they cannot

Vitest runs in jsdom, which performs **no layout**: it has no viewport, no box sizes, and no Tailwind
cascade. No test here asserts responsive behaviour, element dimensions, overflow, or focus appearance.
Those are verified by a person in a browser and recorded in the task's handoff. The tests prove
behaviour, request gating, ordering, lifecycle ownership, and boundaries.
