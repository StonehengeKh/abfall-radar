/**
 * The Node-only provider boundary, reachable exclusively through
 * `@abfall-radar/data-providers/node`.
 *
 * Everything here may use Node built-ins and the calendar parser. The package root export must never
 * re-export any of it, because the browser extension resolves that entry and nothing in official
 * ingestion belongs in a browser bundle. `src/browser-boundary.test.ts` enforces that.
 */
export * from './calendar';
export * from './dependencies';
export * from './event-identity';
export * from './koblenz/manifest';
export * from './koblenz/provider';
export * from './koblenz/summary-mapping';
export * from './normalize';
export * from './retrieval';
export * from './source-cache';
