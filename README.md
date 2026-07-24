# AbfallRadar

AbfallRadar is a city-neutral waste collection reminder designed to scale from one municipal data
provider to cities, states, and countries without coupling the product to a specific location.

The repository is a pnpm and Turborepo monorepo. Deployable applications live in `apps/`; reusable
business, provider, client, and design-system code lives in `packages/`.

## Product sequence

1. Browser extension.
2. Responsive web application.
3. Node.js API.
4. Optional Expo mobile application.

Only the active product stage is implemented. Future application folders reserve architectural
boundaries; their framework dependencies are added when their first vertical slice is approved.

## Requirements

- Node.js 24
- pnpm 11

## Commands

```bash
pnpm install
pnpm dev:extension
pnpm check
```

Application-specific scripts are exposed from the root when the application becomes active.

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
