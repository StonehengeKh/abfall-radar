import { Recycle } from 'lucide-react';

export const BrandMark = () => (
  <div
    className="grid size-10 shrink-0 place-items-center rounded-2xl bg-ar-brand text-ar-on-brand shadow-ar-brand"
    aria-hidden="true"
  >
    <Recycle size={21} strokeWidth={2.2} />
  </div>
);

/**
 * The product name, with its second half in the brand colour.
 *
 * Only the letters: which element carries them — a page's `h1`, a popup's label — and whether that element is
 * a focus target is each application's own structure.
 */
export const BrandName = () => (
  <>
    Abfall<span className="text-ar-brand">Radar</span>
  </>
);
