/**
 * The page-heading scale, shared by every top-level surface.
 *
 * Three deliberate levels: a page heading that is larger and tighter than body text, an intro paragraph
 * that stays at reading size with open line height, and the small upper-case section labels the schedule
 * already uses. Size, weight and line height do the work — the semantics are unchanged, and every surface
 * still has exactly one `h2` under the site `h1`.
 */
export const PAGE_HEADING =
  'text-xl leading-tight font-semibold tracking-tight text-balance text-ar-text sm:text-2xl';

export const PAGE_INTRO = 'max-w-prose leading-relaxed text-ar-text-muted';
