/**
 * An unimported file inside the protected fixture tree, carrying a unique valid Tailwind utility.
 *
 * Nothing imports it, so only Tailwind's content discovery could reach it. With `source(none)` and the
 * `@source not "../test"` exclusion, `tracking-[0.1337em]` must be absent from generated production CSS;
 * `build-output.verify.ts` asserts that. Test data by location and name — never wired into a product.
 */
export const TailwindDiscoveryCandidate = () => (
  <span className="tracking-[0.1337em]">protected</span>
);
