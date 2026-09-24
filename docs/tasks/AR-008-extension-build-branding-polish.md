# AR-008: Local rebuild workflow, one app mark, and the extension's missing radius scale

- Status: Implemented; independent review **APPROVE** (2026-09-24). Committed on the branch below —
  **not merged, not deployed, extension not published.** The local unpacked extension was updated from
  this implementation for development use only, and the person running it confirmed it works after
  reloading it in `chrome://extensions`.
- Owner: Claude Code (implementer), Codex (reviewer)
- Branch: `feat/extension-build-branding-polish`, from `main` at `6b05036` (contains AR-007)

## Goal

Three separate frictions in the installed extension, fixed together because they are all about the same
thing: what the person actually sees after `pnpm build`. Changing the extension should not mean copying
directories by hand; the toolbar should show the product's mark rather than a second, unrelated drawing;
and a shared component should look the same in the popup as it does on the website.

## Context

- [AR-006](AR-006-extension-web-alignment.md) moved the schedule presentation into `@abfall-radar/ui` so
  the popup and the website state a collection the same way. This task closes the gap that left: the
  shared components were there, but one of the token scales they use never reached the extension.
- [ADR 0005 addendum 3](../decisions/0005-addendum-3-audited-favicon.md) established the website's favicon and
  the boundary tests that assert its specifier and emitted path.
- The extension is built by WXT 0.20.27, whose `build` command has **no** `--watch` flag, and whose `dev`
  command drives its own browser profile rather than updating an already installed unpacked extension.

## Scope

### 1. A documented local rebuild and install workflow

`apps/extension/scripts/install-local.ts`, exposed as `install:local` and `install:local:watch`.
Performs an initial build, then watches this workspace and the shared workspaces the build reads,
debounces, serialises builds, queues one rebuild if changes arrive mid-build, validates the finished
output, backs the destination up once per run, and installs — leaving the previous installation
completely untouched when compilation fails.

The destination comes from `--dest` or `ABFALL_RADAR_EXTENSION_INSTALL_DIR` (environment or
`apps/extension/.env.local`, now git-ignored). **No absolute path is committed.**

### 2. One app mark

`packages/ui/src/brand/favicon.svg` is now the single drawing. `scripts/sync-brand-icons.mjs` copies it
to the website's audited `src/assets/favicon.svg` and to `apps/extension/assets/icon.svg`, and its check
mode runs in `pnpm check`. `@wxt-dev/auto-icons` rasterises 16, 32, 48 and 128 px from the extension's
copy, and the manifest now states `action.default_icon` as well as `icons`.

### 3. The extension's missing radius scale

`packages/ui/src/styles.css` now registers `--radius-ar-*` in its `@theme inline` block, beside the
colour and shadow namespaces it already published. The website's local copy of that mapping is removed.

## Non-goals

- **Mini mode is out of scope.** A small floating counter at the right edge inside Chrome cannot be built
  from an extension without injecting an overlay into pages, which needs host permissions this product
  deliberately does not request. No side panel, page overlay or new permission was substituted for it.
- No change to the schedule, household calculation, source verification, storage or reminder paths.
- No change to the website's appearance, asset specifiers or emitted output.

## Acceptance criteria

- [x] One command builds and installs; another also watches. Both documented in the extension README.
- [x] Watchers start before the first build, so an edit during it queues a rebuild; the watch list
      includes shared package metadata and root workspace configuration, and every WXT env filename for
      the production Chrome build is observed through the extension directory, so creation and deletion
      count as changes.
- [x] Editing the canonical app mark updates both consumer copies and the generated PNGs through the
      ordinary build, without an endless rebuild loop.
- [x] A failed compilation leaves the installed build exactly as it was; the next success updates it.
- [x] The destination is configurable and no absolute path appears in repository code.
- [x] The destination's contents are validated **recursively against an inventory this tool writes**,
      whose schema, paths and SHA-256 values are parsed strictly and whose digests are compared against
      the files present; a modified owned file is refused. Anything unrecorded — including a file nested
      inside an expected directory — is refused. Ownership is re-established after the build and the
      destination re-examined immediately before the swap.
- [x] `--adopt` derives ownership from the existing directory's **own validated extension graph**, so an
      older content-hashed build can be adopted and upgraded, and unreferenced content is refused.
- [x] An interrupted swap is recoverable: a destination-bound transaction record is read at startup, the
      committed side is established from what is on disk, and an ambiguous state is refused with manual
      recovery instructions.
- [x] That record is **evidence, not authority**: it is parsed strictly from `unknown`, the only scratch
      paths it can act on are derived from the validated destination and its identifier and verified on
      disk as real sibling directories, and a malformed, foreign or mismatched record leaves itself and
      every path it names untouched.
- [x] The destination itself may not be a symlink and no symlink inside it is followed; the repository,
      the build output, the home directory and the filesystem root are refused in either direction.
- [x] A directory with contents but no inventory is refused until adopted explicitly with `--adopt`.
- [x] The previous installation is backed up before the first replacement of a run; the obligation
      stays pending until a backup is actually taken, and a backup is never treated as permission to
      overwrite unowned data.
- [x] Every mandatory manifest field is validated independently — MV3, service worker, popup, all four
      icon sizes under both icon maps, host permissions — with types, referenced files, no symlink
      anywhere in the output tree **including its root**, and no reference canonically escaping the
      output root; a failed copy restores the previous build.
- [x] A one-shot run exits nonzero when the build, validation or install failed; watch mode exits with
      the status of its last build.
- [x] Shutdown on SIGINT or SIGTERM closes watchers and timers, signals the build's whole process group,
      awaits it, and refuses to begin an install once shutdown has started — from the first build on.
- [x] The installed directory path and browser storage are preserved.
- [x] Extension icons are generated from the website's artwork at 16, 32, 48 and 128 px, and the manifest
      names them for both the toolbar and extension management.
- [x] `rounded-ar-*` emits in the extension's stylesheet, from the shared scale, with the website
      unchanged.

## Responsive and accessibility requirements

- [x] 320 px layout is usable without horizontal page scrolling.
- [x] Tablet and relevant desktop layouts are verified.
- [x] Keyboard, focus, semantics, and accessible names are verified.

## Verification

```bash
pnpm check
pnpm --filter @abfall-radar/extension install:local -- --adopt
```

Three independent review rounds raised fourteen findings against the installer; all are closed, with the
closure review recorded on 2026-09-24. After it, one further defect was found by running the documented
command against a real destination: the home directory was protected as "nothing inside", which refused
every ordinary install path. That is fixed, with regressions, and is the only implementation change made
after the approval.

Local smoke check by the person running it: the extension was adopted, backed up, installed and reloaded
in Chrome, and works.

Automated: the manifest icon contract, the shared-token contract (which fails if a radius token is
defined without a Tailwind mapping), and the app-mark drift check in `pnpm check`.

Manual, in temporary directories: destination refusals, an intentional compile failure preserving the
previous installation, recovery on the next success, and watch rebuilds triggered from both the
extension and two shared packages.

Browser: the popup and the website compared side by side in both appearances, at 320 px and wider, with
long translated labels, keyboard focus and simulated 200 % text.

## Risks and decisions

- The watcher uses `node:fs.watch` with `recursive: true` rather than adding a file-watching dependency.
  That is reliable on macOS and Windows and, since Node 20, on Linux; the repository requires Node 24.
- The app mark is **copied** into two consumer locations rather than imported, because both are
  load-bearing: the website's specifier is asserted by its boundary and build-output tests, and
  `@wxt-dev/auto-icons` needs a path inside the extension. The check mode is what keeps the copies
  honest.
- A doubled hyphen inside the canonical SVG's comment breaks every icon build, because XML forbids it in
  a comment. The file records this where an editor will see it.
