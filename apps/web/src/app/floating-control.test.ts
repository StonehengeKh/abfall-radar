import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coversContent, rectsOverlap } from '@/src/app/floating-control';

/**
 * jsdom lays nothing out, so every box here is stated. The rendered behaviour — 0 covered glyphs and
 * focus rings at 320 and 390 px, normal and 200 % text — was measured in Chrome and recorded in the report.
 */

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const rect = ({ left, top, width, height }: Box): DOMRect =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
  }) as DOMRect;

const NONE: Box = { left: 0, top: 0, width: 0, height: 0 };
// Where the back-to-top control sits on a 320 × 900 viewport.
const CONTROL: Box = { left: 260, top: 840, width: 44, height: 44 };
const UNDER: Box = { left: 16, top: 830, width: 288, height: 40 };
const ABOVE: Box = { left: 16, top: 400, width: 288, height: 40 };

const place = (element: Element, box: Box): void => {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect(box));
};

/** Text boxes come from a Range over the node; the node's parent box stands in for its line boxes. */
const textBoxes = new Map<Node, Box>();

let control: HTMLButtonElement;

beforeEach(() => {
  textBoxes.clear();
  Range.prototype.getClientRects = function getClientRects(this: Range) {
    const box = textBoxes.get(this.startContainer);

    return (box === undefined ? [] : [rect(box)]) as unknown as DOMRectList;
  };
  vi.spyOn(Range.prototype, 'selectNodeContents').mockImplementation(function select(
    this: Range,
    node,
  ) {
    Object.defineProperty(this, 'startContainer', { value: node, configurable: true });
  });

  place(document.body, NONE);
  control = document.createElement('button');
  control.setAttribute('aria-label', 'Back to top');
  document.body.append(control);
  place(control, CONTROL);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  Reflect.deleteProperty(Range.prototype, 'getClientRects');
});

const paragraph = (box: Box, text = 'Restmüll'): HTMLParagraphElement => {
  const element = document.createElement('p');

  element.textContent = text;
  document.body.prepend(element);
  place(element, box);
  textBoxes.set(element.firstChild as Node, box);

  return element;
};

describe('rectsOverlap', () => {
  it('treats a shared edge as clear and any intrusion as overlap', () => {
    const a = { left: 0, right: 10, top: 0, bottom: 10 };

    expect(rectsOverlap(a, { left: 10, right: 20, top: 0, bottom: 10 })).toBe(false);
    expect(rectsOverlap(a, { left: 0, right: 10, top: 10, bottom: 20 })).toBe(false);
    expect(rectsOverlap(a, { left: 9.5, right: 20, top: 9.5, bottom: 20 })).toBe(true);
  });
});

describe('coversContent', () => {
  it('reports visible text under the control', () => {
    paragraph(UNDER);

    expect(coversContent(control)).toBe(true);
  });

  it('ignores text elsewhere on the page', () => {
    paragraph(ABOVE);

    expect(coversContent(control)).toBe(false);
  });

  it('ignores whitespace and text present only for assistive technology', () => {
    paragraph(UNDER, '   ');
    paragraph(UNDER).classList.add('sr-only');

    expect(coversContent(control)).toBe(false);
  });

  it('reports a graphic under the control', () => {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

    document.body.prepend(icon);
    place(icon, UNDER);

    expect(coversContent(control)).toBe(true);
  });

  it('reports a focused element whose focus ring alone reaches the control', () => {
    const card = document.createElement('button');

    // Ends 4 px above the control; a 3 px outline with a 2 px offset reaches 1 px into it.
    card.style.outlineStyle = 'solid';
    card.style.outlineWidth = '3px';
    card.style.outlineOffset = '2px';
    document.body.prepend(card);
    place(card, { left: 16, top: 780, width: 288, height: 56 });
    card.focus();

    expect(coversContent(control)).toBe(true);

    card.style.outlineWidth = '0px';
    card.style.outlineOffset = '0px';

    expect(coversContent(control)).toBe(false);
  });

  it('never hides the control while it holds focus', () => {
    paragraph(UNDER);
    control.focus();

    expect(coversContent(control)).toBe(false);
  });

  it('does not look inside a subtree whose box misses the control', () => {
    const section = document.createElement('section');
    const inner = document.createElement('p');

    inner.textContent = 'Biotonne';
    section.append(inner);
    document.body.prepend(section);
    place(section, ABOVE);
    const probe = vi.spyOn(inner, 'getBoundingClientRect').mockReturnValue(rect(UNDER));
    textBoxes.set(inner.firstChild as Node, UNDER);

    expect(coversContent(control)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});
