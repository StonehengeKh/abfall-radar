# Shared engineering rules

These rules apply to every human and coding agent working on AbfallRadar.

## Communication language

- Source code, code comments, documentation, diagrams, ADRs, tasks, commits, and PR text are
  written in English.
- User-facing copy is localized through the product localization layer when that layer is added.
- Comments explain a non-obvious reason or constraint. They do not narrate self-evident code.

## Product direction

AbfallRadar is location-neutral. A city, district, state, or country integration is implemented
through a provider adapter. Product UI and domain code must not depend on Koblenz-specific names,
URLs, calendar formats, or administrative hierarchy.

Development sequence:

1. Browser extension.
2. Responsive web application.
3. Node.js API.
4. Optional Expo mobile application.

Finish and validate the active stage before implementing the next stage.

## Architecture and dependency direction

- Applications are deployable composition roots under `apps/`.
- Shared packages expose one focused capability and never import an application.
- `domain` is framework-independent and has no browser, UI, network, or provider dependencies.
- `data-providers` translates external sources into validated domain models.
- `ui` contains DOM-based primitives and semantic visual tokens for extension and web.
- `api-client` owns generated or handwritten API transport contracts, not application state.
- Mobile shares domain and API contracts, not DOM components.
- Cross-workspace imports use `@abfall-radar/*` package exports. Do not reach into another
  workspace with relative paths.
- Add a dependency only in the workspace that imports it.
- Create a new shared abstraction after a real second consumer exists or when a stable domain
  boundary already requires it.

## TypeScript and React

- Keep TypeScript strict.
- Do not use `any`, non-null assertions, unchecked casts, or suppressed diagnostics without a
  documented boundary reason.
- Parse external, persisted, generated, and cross-process data at runtime.
- Prefer named exports except where a framework entrypoint requires a default export.
- Keep components focused and derive state instead of synchronizing duplicates.
- Keep server state, local UI state, persisted state, and domain state conceptually separate.
- Do not introduce global state until multiple independent features need coordinated state.
- Prefer composition over prop flags that create multiple unrelated component modes.

## Responsive product UI

- Start at 320 px and enhance for available space.
- Shared components never assume popup, phone, tablet, or desktop dimensions.
- Use content-driven layout changes; do not maintain separate mobile and desktop component trees.
- Prevent horizontal page scrolling at supported widths.
- Use a minimum 44 by 44 CSS pixel target for primary touch interactions.
- Handle text zoom, long translated text, dynamic data, safe areas, and virtual keyboards.
- A browser popup may constrain its shell width; reusable features must remain fluid.

## Accessibility

- Meet WCAG 2.2 AA for contrast and interaction.
- Use semantic HTML before ARIA.
- Every control has an accessible name and visible keyboard focus.
- Do not communicate waste type, status, or severity through color alone.
- Preserve logical focus order and return focus after dialogs or temporary surfaces.
- Respect reduced-motion preferences.

## Data, privacy, and security

- Prefer official municipal sources for collection schedules.
- Preserve source, retrieval time, validity, and freshness metadata.
- Clearly label demo, cached, stale, estimated, and community-sourced data.
- Store user settings locally until a cross-device feature requires backend persistence.
- Request the smallest browser permission set required by implemented behavior.
- Never collect an exact address or position without an implemented feature and explicit action.
- Attribute OpenStreetMap and other licensed sources where their data is displayed.
- Do not commit secrets, credentials, personal data, production exports, or private URLs.

## Testing and completion

For changed behavior:

- test pure domain rules with unit tests;
- test important user interactions with component tests;
- test package boundaries through public exports;
- add browser-level tests when real extension APIs or lifecycle behavior are involved;
- verify loading, empty, error, stale, offline, and permission-denied states when relevant;
- run formatting, lint, TypeScript, tests, and production builds.

Standard verification:

```bash
pnpm check
```

Skipped checks must be reported with the reason and remaining risk.

## Git and repository safety

- Use one branch and one task file per coherent outcome.
- Keep commits independently understandable and buildable when practical.
- Use Conventional Commit subjects in English.
- Never mix formatting-only cleanup or unrelated refactors into a feature commit.
- Preserve unrelated working-tree changes.
- Do not edit generated output under `.output`, `.wxt`, `dist`, or `coverage`.
- Do not commit generated builds, secrets, local environment files, or agent scratch files.
