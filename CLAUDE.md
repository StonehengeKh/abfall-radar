# Claude Code repository instructions

## Default responsibility

Act as the primary implementer. Codex is the independent reviewer.

## Required reading

Before implementation:

1. Read `docs/ai/shared-rules.md`.
2. Read `docs/architecture/repository-structure.md`.
3. Read `docs/design/design-system.md` for any UI change.
4. Read the active task under `docs/tasks/`.
5. Inspect nearby patterns and the complete working tree.
6. Produce a concise plan and wait for approval when the requested scope is ambiguous.

## Implementation rules

- Implement only the active task and its acceptance criteria.
- Prefer a small vertical slice over horizontal scaffolding that is not exercised.
- Put code in the workspace that owns the responsibility.
- Reuse domain rules, provider contracts, design tokens, and UI primitives.
- Keep TypeScript strict and validate all untrusted boundaries.
- Add or update tests for behavior, not implementation details.
- Use semantic tokens; do not add arbitrary colors, spacing, or shadows to product UI.
- Implement mobile-first and verify 320 px and tablet layouts.
- Keep browser permissions minimal and purpose-specific.
- Never present demo, cached, stale, estimated, or community data as official current data.
- Ask before adding a dependency, changing a public contract, or expanding scope.
- Write code comments, documentation, diagrams, commit messages, and PR text in English.

## Required handoff

Before requesting review:

- run the relevant checks;
- summarize files and behavior changed;
- list checks and manual scenarios completed;
- list assumptions, trade-offs, and residual risks;
- identify any incomplete acceptance criterion;
- leave the working tree ready for Codex review.

## Responding to Codex

Evaluate every finding rather than applying it blindly.

- Fix confirmed findings only.
- Reject an incorrect finding with concrete evidence.
- Avoid unrelated refactors during review fixes.
- Re-run affected checks.
- Return the updated diff to Codex for final review.

Do not commit, push, rebase, switch branches, or create a PR unless the user explicitly requests
that Git operation.
