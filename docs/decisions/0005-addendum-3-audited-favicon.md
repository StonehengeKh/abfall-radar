# ADR 0005 addendum 3: One audited favicon in the shell

- Status: Accepted
- Date: 2026-09-19
- Amends: [ADR 0005](0005-responsive-web-schedule.md)

## Context

[ADR 0005](0005-responsive-web-schedule.md) closed the HTML source shell, and
[AR-005](../tasks/AR-005-responsive-web-schedule.md#the-html-entry-has-a-closed-source-shell) made that
concrete: `apps/web/index.html` is compared with a fixed template, and an added icon link was named as a
rejected deviation. `publicDir: false` states the other half of the same rule — nothing is copied
verbatim into the build, so every shipped file is an audited module output.

Both rules exist for one reason: a file that reaches `dist` without passing the dependency graph and the
emitted-artifact scan is a file nobody checked. Neither rule was about favicons; a browser tab with no
icon was simply the state the first slice shipped in.

The gap is that a favicon must be declared in the initial HTML to be used at all. A runtime injection
after React mounts would leave the tab blank while the application loads and would move a static asset
decision into runtime behaviour.

## Decision

### The shell carries exactly one resource link: the favicon

```html
<link rel="icon" type="image/svg+xml" href="/src/assets/favicon.svg">
```

The shell stays closed. The template gains this one line and nothing else, a second icon or any other
resource link remains a rejected deviation, and the shell is still compared against a constant
transcribed by hand rather than generated from the file.

### The asset comes from the module graph, never from a public directory

`href` points **inside `src/`**, so Vite resolves it, hashes it and emits
`/assets/favicon-<hash>.svg`, exactly as it treats a stylesheet or a script. **`publicDir: false`
remains in force** and `apps/web/public/` does not exist. Nothing is copied verbatim, and the audited
output guarantee is unchanged.

### The emitted asset is audited with the outputs it ships beside

- The source is inside the audited tree, is not a protected test file, and is reachable only through the
  shell reference.
- The emitted HTML must declare exactly one icon link, and it must point at a hashed asset rather than
  the source path.
- The emitted file must exist, be non-empty, and be the only image in the build, so an unreferenced or
  unhashed copy would be reported.
- Its content is held to an **exact allow-list**: the SVG namespace name and no other absolute URL, and
  no script, style, `@import`, nested image, `xlink:href` or `url()`.

The four-category scan over emitted HTML, JavaScript and CSS is untouched. A standalone SVG has to
declare its namespace to render, so it is audited by the stricter allow-list above instead of being
exempted from the general scan. The R4 protected-asset guard is unchanged, and a public-directory or
copied-asset bypass is still rejected.

### The mark is derived from the brand, and is original artwork

`packages/ui/src/brand-mark.tsx` is a brand-green rounded square holding a dark recycling glyph. The
favicon keeps that language — same square, same radius proportion, same palette — and redraws the glyph
as three bold arrows, because the product mark's thin strokes close up at 16 px. It carries no wordmark
and no small text. The colours are written literally, since a favicon is loaded outside the document and
inherits no custom property; the dark appearance's pairing is used in both themes, as light green on
near black reads on a light and a dark tab strip alike.

## Consequences

- The tab shows the product mark from the first paint, with no dependency on React mounting.
- One more emitted artifact, audited by the same gate as the rest; the guarantee that nothing reaches
  `dist` unexamined is preserved rather than excepted.
- No PNG or `.ico` pipeline, no icon-generation tooling and no new dependency. An SVG favicon is enough
  for current browsers, and a fallback can be added later as its own decision.
- AR-005's shell section keeps its original template as the record of the first slice, with the amended
  template beside it.

[AR-005](../tasks/AR-005-responsive-web-schedule.md) remains the accepted task record; its
[implementation handoff](../tasks/AR-005-implementation-handoff.md) records this change and its
verification.
