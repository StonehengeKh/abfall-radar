import { type RefObject, useLayoutEffect } from 'react';

/**
 * Keeps a fixed, floating control from sitting on top of what a person is reading or operating.
 *
 * A fixed control overlays whatever scrolls beneath it, and no inset or scroll padding can prevent that
 * mid-scroll. Measured in Chrome, the back-to-top control covered schedule text at normal text size and
 * up to 26 glyphs at 200 %, and the corner and focus ring of focused district cards. So the control is
 * made invisible — not moved, not restyled, not unmounted — for exactly as long as its own footprint
 * overlaps visible text, a visible graphic, or the focused element together with its focus ring.
 *
 * `visibility: hidden` rather than removal: the element keeps its box, so the footprint being tested is
 * always the control's real, final position (safe-area and confirmation-bar offsets included), and a
 * hidden control is neither focusable, clickable, nor exposed to assistive technology.
 */

interface RectLike {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** Strict overlap: rectangles that only share an edge do not collide. */
export const rectsOverlap = (a: RectLike, b: RectLike): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

const hasSize = (rect: RectLike): boolean => rect.right > rect.left || rect.bottom > rect.top;

/** Content that is present for assistive technology only is not something the control can cover. */
const isVisuallyHidden = (element: Element): boolean =>
  element.classList.contains('sr-only') || element.getAttribute('hidden') !== null;

/** The focused element's box grown by its focus indicator — outline width plus a positive offset. */
const focusFootprint = (element: Element): RectLike => {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const ring =
    (Number.parseFloat(style.outlineWidth) || 0) +
    Math.max(0, Number.parseFloat(style.outlineOffset) || 0);

  return {
    left: rect.left - ring,
    right: rect.right + ring,
    top: rect.top - ring,
    bottom: rect.bottom + ring,
  };
};

/**
 * Whether `control`, where it currently sits, overlaps anything that must stay visible.
 *
 * The document is walked from `body`, and a subtree is skipped as soon as its element's box misses the
 * footprint — so the cost is the few elements actually under the control, not the page. Elements with
 * no box of their own (`display: contents`) are always descended into.
 */
export const coversContent = (control: HTMLElement, root: Element = document.body): boolean => {
  const footprint = control.getBoundingClientRect();

  if (!hasSize(footprint)) {
    return false;
  }

  const active = document.activeElement;

  // A control that has focus is never hidden: that would drop the focus it holds.
  if (active !== null && control.contains(active)) {
    return false;
  }

  if (
    active !== null &&
    active !== document.body &&
    active !== document.documentElement &&
    rectsOverlap(focusFootprint(active), footprint)
  ) {
    return true;
  }

  const range = document.createRange();
  const textOverlaps = (node: Text): boolean => {
    if (node.textContent === null || node.textContent.trim() === '') {
      return false;
    }

    range.selectNodeContents(node);

    return typeof range.getClientRects === 'function'
      ? Array.from(range.getClientRects()).some((rect) => rectsOverlap(rect, footprint))
      : false;
  };

  const visit = (element: Element): boolean => {
    if (element === control || isVisuallyHidden(element)) {
      return false;
    }

    const rect = element.getBoundingClientRect();

    if (hasSize(rect) && !rectsOverlap(rect, footprint)) {
      return false;
    }

    const tag = element.tagName.toLowerCase();

    if (tag === 'svg' || tag === 'img') {
      return hasSize(rect);
    }

    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE ? textOverlaps(child as Text) : false) {
        return true;
      }

      if (child instanceof Element && visit(child)) {
        return true;
      }
    }

    return false;
  };

  return visit(root);
};

/**
 * Hides `control` while it would cover content, and shows it again as soon as it would not.
 *
 * Toggled imperatively inside the scroll, resize and focus handlers rather than through React state: a
 * browser dispatches those events before it paints the frame, so the change lands in the same frame and
 * the control is never painted over text first. `data-covering` records the decision for tests and
 * diagnostics. Nothing is animated, so reduced motion needs no special case.
 */
export const useFloatingControlClearance = (
  control: RefObject<HTMLElement | null>,
  active: boolean,
): void => {
  useLayoutEffect(() => {
    const element = control.current;

    if (!active || element === null) {
      return;
    }

    const apply = (): void => {
      const covering = coversContent(element);

      element.style.visibility = covering ? 'hidden' : '';
      element.dataset.covering = String(covering);
    };

    apply();
    window.addEventListener('scroll', apply, { passive: true });
    window.addEventListener('resize', apply);
    document.addEventListener('focusin', apply);
    document.addEventListener('focusout', apply);

    // Content can move under a still control — filtering the district grid does exactly that.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);

    observer?.observe(document.body);

    return () => {
      window.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
      document.removeEventListener('focusin', apply);
      document.removeEventListener('focusout', apply);
      observer?.disconnect();
      element.style.visibility = '';
      delete element.dataset.covering;
    };
  }, [active, control]);
};
