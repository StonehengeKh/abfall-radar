# AR-002: Documented API foundation

- Status: Ready
- Owner: Claude Code

## Goal

Create a runnable, production-shaped HTTP API foundation that gives developers and coding agents an
interactive OpenAPI reference, standardized error behavior, and a small provider catalogue vertical
slice. This task establishes the shared contract boundary that the browser extension, responsive web
application, and optional mobile application will consume in later tasks.

## Context

- [ADR 0002: Shared documented HTTP API](../decisions/0002-shared-http-api.md)
- [Repository architecture](../architecture/repository-structure.md)
- [Shared engineering rules](../ai/shared-rules.md)
- [Agent workflow](../ai/workflow.md)

The extension currently consumes a demo provider directly. This task exposes provider discovery
through the API but does not migrate the extension or ingest an official municipal source.

## Scope

- Activate `apps/api` as a strict TypeScript and Fastify 5 application.
- Add only dependencies owned by the API workspace and pin shared versions through the pnpm catalog.
- The approved runtime dependencies are `fastify`, `zod`, `@fastify/type-provider-zod`,
  `@fastify/swagger`, and `@fastify/swagger-ui`. The approved development dependencies are
  `@types/node`, `tsx`, `typescript`, and `vitest`. Adding another dependency requires human
  approval.
- Separate an application factory from the process entrypoint.
- Validate `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL`, and `API_DOCS_ENABLED` configuration at startup.
- Add structured logging, request identifiers, and graceful shutdown.
- Generate an OpenAPI contract from route schemas.
- Serve Swagger UI at `/docs` and JSON at `/openapi.json` in development.
- Implement `GET /health`.
- Implement `GET /api/v1/providers`.
- Implement `GET /api/v1/providers/{providerId}/service-areas` by adapting the existing provider
  boundary. The API term `service area` must not require renaming the extension's existing district
  model in this task.
- Expose the existing demo provider only and label all demo data explicitly.
- Implement one centralized error boundary that returns RFC 9457 Problem Details.
- Handle request validation, unknown provider, unknown route, and unexpected server failures.
- Add deterministic integration tests with Fastify injection.
- Document local development, routes, generated documentation, and verification commands.
- Update repository architecture and product-sequence documentation to place the shared API before
  official provider and additional client work.

## Non-goals

- Official municipal source ingestion or ICS parsing.
- Collection schedule endpoints.
- Migration of the browser extension to `@abfall-radar/api-client`.
- Generated API client code.
- Database, migration tool, Redis, or another persistent cache.
- Authentication, user accounts, or cross-device synchronization.
- Rate limiting, telemetry backend, or production monitoring integration.
- Docker, cloud deployment, DNS, TLS, or CI deployment workflows.
- Recycling-point map endpoints.
- Product UI or design-system changes.

## HTTP contract

### `GET /health`

Return a small operational response with a stable schema:

```json
{
  "status": "ok",
  "service": "abfall-radar-api",
  "timestamp": "2026-07-28T12:00:00.000Z"
}
```

The timestamp is generated at request time. Tests must validate its shape rather than depend on the
wall clock.

### `GET /api/v1/providers`

Return provider metadata without provider-specific implementation fields:

```json
{
  "data": [
    {
      "id": "demo",
      "name": "Demo provider",
      "sourceKind": "demo"
    }
  ]
}
```

### `GET /api/v1/providers/{providerId}/service-areas`

Return normalized service areas for the selected provider:

```json
{
  "data": [
    {
      "id": "demo-mitte",
      "providerId": "demo",
      "locality": "Demo City",
      "name": "Mitte"
    }
  ]
}
```

The `providerId` parameter accepts lowercase ASCII letters, digits, and internal hyphens, starts with
an alphanumeric character, and has a maximum length of 64 characters. A value that violates this
transport constraint returns `400`; a valid but unknown identifier returns `404`.

Unknown providers return `404` with `code: "PROVIDER_NOT_FOUND"`.

## Error contract

Expected failures use the `application/problem+json` content type and this base shape:

```json
{
  "type": "urn:abfall-radar:problem:provider-not-found",
  "title": "Provider not found",
  "status": 404,
  "detail": "No schedule provider exists for the supplied identifier.",
  "instance": "/api/v1/providers/unknown/service-areas",
  "code": "PROVIDER_NOT_FOUND",
  "requestId": "req-1"
}
```

The OpenAPI operation must document each error it can intentionally return. Use a reusable base
Problem Details schema and specific examples. Do not claim an error status that the implementation
cannot produce.

Validation details may add an `errors` array with stable field paths and machine-readable codes.
Human-readable `detail` text is diagnostic API copy, not localized product UI copy.

## Acceptance criteria

- [ ] `pnpm dev:api` starts the API from the repository root.
- [ ] `pnpm --filter @abfall-radar/api build` produces a runnable production artifact.
- [ ] The application factory can be imported by tests without binding a network port or registering
      signal handlers.
- [ ] Startup fails early with an actionable message when API environment configuration is invalid.
- [ ] `GET /health` returns the documented `200` response and schema.
- [ ] `GET /api/v1/providers` returns the explicitly labelled demo provider.
- [ ] `GET /api/v1/providers/demo/service-areas` returns normalized demo service areas.
- [ ] An unknown provider returns a documented `404` Problem Details response.
- [ ] Invalid request input returns a documented `400` Problem Details response.
- [ ] An unknown route returns a Problem Details response without leaking internals.
- [ ] Unexpected errors are logged with their request identifier and return a sanitized `500`
      Problem Details response.
- [ ] Every response schema prevents undocumented fields from being serialized.
- [ ] Swagger UI is available at `/docs` in development.
- [ ] The OpenAPI JSON document is available at `/openapi.json` in development.
- [ ] OpenAPI contains summaries, operation identifiers, tags, schemas, response descriptions, and
      realistic success and error examples for every implemented endpoint.
- [ ] Documentation endpoints can be disabled explicitly for a production environment without
      changing route code.
- [ ] Tests cover the application factory, health route, provider catalogue, service-area mapping,
      validation error, not-found error, and sanitized unexpected error.
- [ ] No database, authentication, unrestricted CORS wildcard, municipal host permission, or
      production secret is added.
- [ ] Root and API documentation explain how to run the API and inspect its contract.
- [ ] `pnpm check` passes.

## Verification

Automated:

```bash
pnpm --filter @abfall-radar/api test
pnpm --filter @abfall-radar/api typecheck
pnpm --filter @abfall-radar/api build
pnpm check
```

Manual:

```bash
pnpm dev:api
curl --fail-with-body http://localhost:3000/health
curl --fail-with-body http://localhost:3000/api/v1/providers
curl --fail-with-body http://localhost:3000/api/v1/providers/demo/service-areas
curl --include http://localhost:3000/api/v1/providers/unknown/service-areas
```

- Open `http://localhost:3000/docs`.
- Confirm all implemented operations, schemas, examples, and expected errors are visible.
- Execute each operation through Swagger UI.
- Open `http://localhost:3000/openapi.json` and confirm it matches the interactive reference.
- Stop the process and confirm it closes without an unhandled rejection.

## Risks and decisions

- OpenAPI route schemas are the contract source of truth. Do not maintain a parallel handwritten
  specification.
- The foundation exposes demo provider metadata only. Consumers must never present it as official
  municipal data.
- The API uses `service area` as a location-neutral transport term. Migrating the existing domain
  `District` type requires a separate contract-change task.
- Documentation is enabled for local development. Production exposure remains an explicit deployment
  decision.
- Persistence and caching depend on the official provider refresh model and are deferred to the
  provider-ingestion task.
- A generated client is intentionally deferred until this HTTP contract is reviewed and accepted.
