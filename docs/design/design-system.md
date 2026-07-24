# AbfallRadar design system

## Product character

AbfallRadar should feel calm, clear, trustworthy, and useful. Visual polish supports comprehension;
it must not hide data provenance, errors, or essential actions.

## Foundations

Semantic tokens in `@abfall-radar/ui/styles.css` are the source of truth for product color,
typography, radii, shadows, motion, and focus treatment.

- Use OKLCH tokens for predictable perceptual relationships.
- Name tokens by purpose, not by a literal color.
- Use one restrained brand family and neutral surfaces.
- Use elevation only to explain hierarchy.
- Keep motion short, interruptible, and optional.
- Do not add an arbitrary visual value when an existing token expresses the intent.

## Responsive behavior

Design mobile-first from 320 px.

| Range | Expected behavior |
| --- | --- |
| 320–599 px | Single-column compact composition with no horizontal page scroll |
| 600–1023 px | Tablet composition with wider content, optional two-column regions |
| 1024 px and wider | Constrained reading width and deliberate use of additional columns |

Breakpoints are content decisions, not device detection. A component must respond to its available
space and must not assume which application hosts it.

The extension popup shell can constrain width. Shared components remain fluid so the same feature
can later render in web layouts.

## Spacing and shape

- Use a 4 px base spacing rhythm.
- Prefer consistent internal spacing over ad hoc margins between child components.
- Use rounded shapes consistently; reserve the largest radius for primary containers.
- Keep primary touch targets at least 44 by 44 CSS pixels.
- Preserve usable layouts under 200% text zoom and long localized labels.

## Typography

- Use the system UI stack until a licensed product font has a measured benefit.
- Keep body text at 16 px in full web forms; compact extension metadata may be smaller when contrast
  and hierarchy remain clear.
- Use sentence case for product copy.
- Use tabular numerals for dates, counts, and times when alignment matters.

## Color and status

- Use semantic surface, text, border, brand, focus, warning, success, and danger roles.
- Waste categories may have recognizable colors, but always include an icon and text label.
- Demo, stale, cached, estimated, and official data need explicit textual provenance.
- Validate all text and interactive states against WCAG 2.2 AA contrast.

## Components

Build primitives in `packages/ui` only when extension and web can share their DOM behavior.
Application-specific feature composition stays in the application.

Every component includes:

- clear semantic structure;
- keyboard behavior;
- visible focus;
- disabled, loading, error, and long-content behavior when relevant;
- responsive behavior without host-specific fixed widths;
- tests for meaningful interaction.

Use accessible headless primitives when a component has complex focus or keyboard behavior. Do not
add a component library merely for simple styled HTML.

## Required UI review

For every UI task, verify:

1. 320 px width.
2. 768 px width.
3. A desktop width relevant to the host application.
4. Keyboard-only operation.
5. Visible focus and accessible names.
6. Long text and empty/error states.
7. Reduced-motion preference when animation exists.
8. No information encoded by color alone.
