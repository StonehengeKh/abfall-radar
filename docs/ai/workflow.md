# Claude implementation and Codex review workflow

Use one task file and one Git branch per coherent outcome. Claude and Codex work sequentially in the
same checkout. They must not edit the same working tree concurrently.

## 1. Define the task

Create or select a task under `docs/tasks/`. It must include:

- goal and user outcome;
- relevant context;
- scope and non-goals;
- acceptance criteria;
- responsive and accessibility expectations for UI;
- verification and manual scenarios;
- known risks or open decisions.

The human approves material scope and architecture decisions.

## 2. Claude plans

Start Claude in plan mode:

```bash
claude --permission-mode plan
```

Prompt:

```text
Read CLAUDE.md, docs/ai/shared-rules.md, the relevant architecture and design documents,
and the active task. Inspect the repository and propose a scoped implementation plan.
Do not edit until the plan is approved.
```

## 3. Claude implements

Claude implements the approved plan, tests the behavior, and produces the required handoff. The
working tree remains uncommitted so the complete change is available to review.

## 4. Codex reviews

Run Codex after Claude has stopped editing:

```bash
codex review --uncommitted
```

`codex review --uncommitted` is non-interactive and cannot be combined with a custom review prompt.
Codex discovers `AGENTS.md` automatically. The applicable task, architecture, design, and shared
rules must therefore be committed and referenced by `AGENTS.md` before implementation begins.

For an interactive review, start `codex`, enter `/review`, select the uncommitted changes, and confirm
that the active task is in scope. Do not use the interactive surface and the non-interactive command
for the same review pass.

## 5. Claude resolves findings

Resume Claude:

```bash
claude --continue
```

Claude validates each finding, fixes confirmed defects, explains rejected findings with evidence,
and reruns affected checks.

## 6. Codex performs final review

The task is ready for human acceptance only when:

- Codex returns `APPROVE`;
- required automated checks pass;
- required manual scenarios are documented;
- the human accepts the final diff.

## 7. Commit and PR

After approval:

1. Create focused Conventional Commits in English.
2. Push the task branch.
3. Open a PR using `.github/pull_request_template.md`.
4. Link the task and architecture decision records.
5. Merge only after CI and human review pass.

## Parallel work

Use separate Git worktrees only for unrelated tasks with independent files and contracts. Do not
use parallel agents to implement and review the same change.
