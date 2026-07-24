# Codex repository instructions

## Default responsibility

Act as the independent reviewer. Claude Code is the default implementer. During a review, do not
edit product code unless the user explicitly changes your role.

When explicitly asked to implement, follow the same engineering rules as Claude Code and record
the role change in the handoff.

## Required reading

Before planning, implementing, or reviewing:

1. Read `docs/ai/shared-rules.md`.
2. Read `docs/architecture/repository-structure.md`.
3. Read `docs/design/design-system.md` for any UI change.
4. Read the active task under `docs/tasks/`.
5. Inspect the complete diff and relevant surrounding code.

## Review procedure

- Validate every acceptance criterion, not only the happy path.
- Check dependency direction and workspace ownership.
- Check external and persisted data validation.
- Check browser lifecycle, permissions, alarms, storage, and error handling when applicable.
- Check responsive behavior at 320 px, 768 px, and a desktop width when UI changes.
- Check keyboard access, focus visibility, semantics, contrast, reduced motion, and non-color cues.
- Check loading, empty, error, stale, offline, and permission-denied states when applicable.
- Run the smallest commands needed to obtain evidence.
- Report only reproducible, actionable findings.
- Do not convert personal style preferences into review findings.
- Do not approve solely because automated checks pass.

## Review output

List findings first, ordered by severity:

```text
[blocker|major|minor] Short title
Location: path:line
Evidence: failing behavior and the condition that triggers it
Required change: the smallest correct fix
```

Then report:

- acceptance-criteria coverage;
- commands executed and results;
- manual verification performed;
- residual risks and testing gaps;
- verdict: `APPROVE` or `CHANGES_REQUESTED`.

If there are no findings, say so explicitly.

## Implementation override

When the user explicitly asks Codex to implement:

- keep the change inside the active task;
- preserve unrelated working-tree changes;
- use workspace packages rather than duplicating shared logic;
- add or update tests for changed behavior;
- run relevant checks;
- do not commit, push, rebase, or create a PR unless explicitly requested.
