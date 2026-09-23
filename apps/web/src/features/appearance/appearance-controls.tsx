import { AppearanceMenu, AppearancePopover, LanguageMenu } from '@abfall-radar/ui';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTheme } from '@/src/app/theme';
import { useMediaQuery, WIDE_HEADER_QUERY } from '@/src/hooks/use-media-query';
import { useLocale } from '@/src/i18n/context';

/**
 * The two presentation controls in the web page's header.
 *
 * The menus themselves — the trigger, the popup, roving keyboard operation, `Escape` and focus return —
 * are shared with the extension and live in `@abfall-radar/ui`. What stays here is the web's own: reading
 * and storing its preferences, and choosing between the icon row and the name list by the width the
 * header has.
 */

/**
 * One appearance control with two presentations, and one preference behind both.
 *
 * Only the presentation the available width can carry is mounted — a row of icons where there is room,
 * a list of names where there is not — so there is never a second, hidden copy for a screen reader or a
 * `Tab` sequence to find, and an open popover cannot survive the switch as an orphan: it is unmounted
 * with the control that owns it, taking its document listeners with it. Focus is handed over
 * explicitly, because the element that had it is gone and a browser would otherwise drop it to `<body>`.
 *
 * None of this is device detection. It asks what CSS asks — how much room is there — and the preference
 * itself lives in the theme provider, untouched by the switch.
 */
export const AppearanceControl = () => {
  const { messages } = useLocale();
  const { preference, setPreference } = useTheme();
  const wide = useMediaQuery(WIDE_HEADER_QUERY);
  const containerRef = useRef<HTMLDivElement>(null);
  const held = useRef(false);
  const previous = useRef(wide);

  /*
   * Focus ownership is tracked from `focusin` on the document, not from this element's own `blur`.
   *
   * Removing the focused element is precisely the case that has to work, and it is the one a `blur`
   * handler cannot see: the browser moves focus to `<body>` with no related target, and by the time
   * anything runs the element is already gone. `focusin` elsewhere, or a pointer press elsewhere, is
   * what actually means "focus left this control", so those are what clear the flag.
   */
  useEffect(() => {
    const inside = (node: EventTarget | null): boolean =>
      node instanceof Node && (containerRef.current?.contains(node) ?? false);

    const onFocusIn = (event: FocusEvent): void => {
      held.current = inside(event.target);
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (!inside(event.target)) {
        held.current = false;
      }
    };

    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('pointerdown', onPointerDown);

    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, []);

  useLayoutEffect(() => {
    if (previous.current === wide) {
      return;
    }

    previous.current = wide;

    // Only when the switch is what lost the focus: never steal it from wherever it legitimately is.
    if (
      held.current &&
      (document.activeElement === null || document.activeElement === document.body)
    ) {
      containerRef.current?.querySelector('button')?.focus();
    }
  }, [wide]);

  return (
    <div className="flex items-center" data-testid="appearance-control" ref={containerRef}>
      {wide ? (
        <AppearancePopover
          labels={messages.appearance}
          onSelect={setPreference}
          value={preference}
        />
      ) : (
        <AppearanceMenu labels={messages.appearance} onSelect={setPreference} value={preference} />
      )}
    </div>
  );
};

export const LanguageControl = () => {
  const { locale, messages, setLocale } = useLocale();

  return <LanguageMenu label={messages.language.label} onSelect={setLocale} value={locale} />;
};
