/**
 * A decorative outline of a monument on a headland where two rivers meet.
 *
 * Original artwork, drawn here as plain paths: no municipal coat of arms, no operator logo, no city
 * wordmark, and nothing that could be mistaken for an official emblem. It is scene-setting for the
 * district chooser, so it is `aria-hidden` and adds no accessible name — the city is named in text
 * beside it, and the text is what carries the meaning.
 *
 * Local and inline. No network request, no image file, no icon dependency: an inline SVG scales with the
 * layout, follows `currentColor` into both appearances, and cannot fail to load. React puts an `<svg>`
 * in the SVG namespace itself, so there is no `xmlns` literal here either.
 *
 * The drawing is generic on purpose. The product is location-neutral, so this component knows nothing
 * about which city it sits beside; it is a confluence, a spit of land and a monument, and the catalogue
 * supplies the name.
 */
export const CityIllustration = ({ className }: { readonly className?: string }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    focusable="false"
    preserveAspectRatio="xMidYMid meet"
    role="presentation"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    viewBox="0 0 200 100"
  >
    {/* The far bank, then the two rivers that meet, then their ripples. */}
    <g opacity="0.4" strokeWidth="2">
      <path d="M6 70h52" />
      <path d="M142 70h52" />
      <path d="M8 88c34 2 62-2 84-14" />
      <path d="M192 88c-34 2-62-2-84-14" />
      <path d="M24 98h26" />
      <path d="M176 98h-26" />
    </g>

    {/* The spit of land between them, rising to the monument at its point. */}
    <g strokeWidth="2.4">
      <path d="M34 98c26-4 48-12 62-24h8c14 12 36 20 62 24" />
    </g>

    {/* The monument: a plinth, a tapered column and a finial — an outline, not an emblem. */}
    <g strokeWidth="2.4">
      <path d="M85 74h30a3 3 0 0 0 3-3v-8a3 3 0 0 0-3-3H85a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3z" />
      <path d="M93 60 96.5 34h7L107 60" />
      <path d="M95 46h10" />
      <circle cx="100" cy="30" r="2.5" />
    </g>
  </svg>
);
