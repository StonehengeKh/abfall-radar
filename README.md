# AbfallRadar

AbfallRadar is a city-neutral waste collection reminder designed to scale from one municipal data
provider to cities, states, and countries without coupling the product to a specific location.

The repository is a pnpm and Turborepo monorepo. Deployable applications live in `apps/`; reusable
business, provider, client, and design-system code lives in `packages/`.

## Product sequence

1. Browser extension.
2. Shared documented Node.js API.
3. Responsive web application.
4. Optional Expo mobile application.

The shared API comes before official provider ingestion and before any additional client, so every
client consumes one validated contract instead of parsing municipal formats itself.

Only the active product stage is implemented. Future application folders reserve architectural
boundaries; their framework dependencies are added when their first vertical slice is approved.

## Requirements

- Node.js 24
- pnpm 11

## Commands

```bash
pnpm install
pnpm dev:extension
pnpm dev:api
pnpm check
```

Application-specific scripts are exposed from the root when the application becomes active.

## Current milestone

The shared API foundation is runnable and documented:

- a strict TypeScript Fastify application with an application factory separated from the process
  entrypoint;
- validated startup configuration, structured logging, request identifiers, and graceful shutdown;
- an OpenAPI contract generated from the route schemas, with Swagger UI and a machine-readable
  document;
- one centralized RFC 9457 Problem Details error boundary;
- a provider catalogue and service-area slice over the existing demo provider;
- integration tests driven through Fastify injection.

The API exposes demo provider metadata only. No official municipal source is ingested yet and no
client consumes the API.

The browser extension MVP includes:

- a responsive React popup;
- upcoming collection and settings views;
- local preference storage;
- Manifest V3 alarms and notifications;
- a typed provider boundary and clearly labelled demo data;
- unit and component tests.

The extension runs on demo schedules until an official municipal provider is implemented.

### Browser extension development

```bash
pnpm dev:extension
```

For a production build:

```bash
pnpm --filter @abfall-radar/extension build
```

Load `apps/extension/.output/chrome-mv3` from `chrome://extensions` with Developer mode enabled.

### API development

```bash
pnpm dev:api
```

Then open <http://localhost:3000/docs> for the interactive contract reference and
<http://localhost:3000/openapi.json> for the generated OpenAPI document. For a production build:

```bash
pnpm --filter @abfall-radar/api build
pnpm --filter @abfall-radar/api start
```

See [the API README](apps/api/README.md) for configuration, routes, the error contract, and request
correlation.

## Repository map

```text
apps/
  extension/       Browser extension
  web/             Responsive web and PWA
  api/             Node.js API
  mobile/          Expo mobile application
packages/
  domain/          Framework-independent models and business rules
  ui/              Web design tokens and reusable React primitives
  api-client/      Typed client for the AbfallRadar API
  data-providers/  Municipal provider contracts and adapters
  config/          Shared tool configuration
  test-utils/      Shared test builders and helpers
docs/
  ai/              Agent workflow and shared rules
  architecture/    System boundaries and dependency direction
  decisions/       Architecture decision records
  design/          Design-system standards
  tasks/           Scoped task specifications
```

See [Repository architecture](docs/architecture/repository-structure.md) and
[Agent workflow](docs/ai/workflow.md) before making a change.
