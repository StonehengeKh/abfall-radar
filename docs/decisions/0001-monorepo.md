# ADR 0001: Use a pnpm and Turborepo monorepo

- Status: Accepted
- Date: 2026-07-24

## Context

AbfallRadar starts as a browser extension and is expected to add a responsive web application, a
Node.js API, and potentially an Expo mobile application. These products share domain models,
provider contracts, API contracts, and part of the DOM design system.

Separate repositories would duplicate contracts and make atomic cross-product changes harder.
Putting all code in one application would couple deployable products and runtime concerns.

## Decision

Use one repository with pnpm workspaces and Turborepo.

- Deployable products live under `apps/`.
- Reusable capabilities live under `packages/`.
- Workspace package names use the `@abfall-radar/*` namespace.
- Application dependencies are added when the relevant product stage starts.
- Shared abstractions require a stable boundary or a real second consumer.

## Consequences

Positive:

- one atomic change can update a contract and its consumers;
- one CI entry point validates the repository;
- domain and design-system code can be reused without publishing packages;
- task context is visible to human and AI reviewers.

Trade-offs:

- CI must use filtering and caching as the repository grows;
- workspace boundaries require discipline;
- mobile can share business contracts but not DOM components.

## Alternatives considered

### Separate repositories

Rejected for the current team size because contract duplication and coordination cost outweigh
independent release isolation.

### Single application tree

Rejected because browser, web, API, and mobile runtimes have different lifecycle and deployment
boundaries.
