import { Check, ChevronDown, Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { type ThemePreference, THEME_PREFERENCES, useTheme } from '@/src/app/theme';
import { useMediaQuery, WIDE_HEADER_QUERY } from '@/src/hooks/use-media-query';
import { useLocale } from '@/src/i18n/context';
import { SUPPORTED_LOCALES } from '@/src/i18n/locale';
import { MESSAGES } from '@/src/i18n/messages';

/**
 * The two presentation controls in the header.
 *
 * Both are built from native buttons rather than a `<select>`, because both need to show state the
 * platform picker cannot: the theme control shows all three choices at once where there is room, and
 * both menus mark the current value with a check. Everything a `<select>` gave for free is therefore
 * reimplemented deliberately — an accessible name, roving keyboard operation, `Escape`, and focus
 * returning to the trigger — once, in `RadioMenu`, which the language control and the compact
 * appearance control share.
 *
 * Language is never identified by a flag. A flag names a country, and none of these languages belongs
 * to one country; each is written in its own name instead.
 */

const THEME_ICONS: Record<ThemePreference, typeof Sun> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

/**
 * The shared trigger surface: 36 × 36 px visible, with a 44 × 44 px target.
 *
 * The target is a `::after` overlay, and an absolutely positioned box is inset from its containing
 * block's **padding** box — 34 px here, inside the 1 px border — not from the border box. A 4 px inset
 * therefore produced 42 px, which browser hit testing confirmed. 5 px from the padding box is 4 px
 * beyond the border on every side: exactly 44 px. The two triggers sit 8 px apart, so their targets meet
 * at the middle of that gap without overlapping.
 */
const TRIGGER =
  "relative flex h-9 min-w-9 items-center justify-center rounded-full border border-ar-border bg-ar-surface px-2 text-xs text-ar-text transition-colors after:absolute after:-inset-[5px] after:content-[''] hover:bg-ar-surface-muted motion-reduce:transition-none";

interface RadioOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  /** Present for an icon popover, where the label becomes the option's accessible name. */
  readonly icon?: typeof Sun;
}

/**
 * A menu of mutually exclusive options: one trigger, one popup, one checked item.
 *
 * `menuitemradio` + `aria-checked` rather than `option`, because choosing acts immediately instead of
 * filling in a field. The popup is removed from the DOM when closed, so nothing invisible is focusable
 * and no overlay can outlive it — including when a layout change unmounts the whole control.
 */
const RadioMenu = <Value extends string>({
  label,
  triggerLabel,
  triggerContent,
  testId,
  options,
  value,
  onSelect,
  chevron = true,
  orientation = 'vertical',
}: {
  readonly label: string;
  readonly triggerLabel: string;
  readonly triggerContent: React.ReactNode;
  readonly testId: string;
  readonly options: readonly RadioOption<Value>[];
  readonly value: Value;
  readonly onSelect: (value: Value) => void;
  /** An icon-only trigger drops it: `aria-haspopup` already says a menu opens, and the header is tight. */
  readonly chevron?: boolean;
  /** A horizontal popover reads as a row of icons; a vertical one as a list of names. */
  readonly orientation?: 'vertical' | 'horizontal';
}) => {
  const [open, setOpen] = useState(false);
  const [entered, setEntered] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /**
   * A pointer press on the trigger that is about to toggle the menu itself. Pressing it moves focus out
   * of the open menu first, and closing on that focus change would let the click that follows open the
   * menu again. The flag is consumed by that focus change, and cleared by the click.
   */
  const pressingTrigger = useRef(false);
  const menuId = useId();

  const close = (returnFocus: boolean): void => {
    setOpen(false);

    if (returnFocus) {
      triggerRef.current?.focus();
    }
  };

  // A menu that stays open after the pointer has moved on is a trap, so a click outside closes it.
  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;

      if (
        target instanceof Node &&
        !(menuRef.current?.contains(target) ?? false) &&
        !(triggerRef.current?.contains(target) ?? false)
      ) {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', onPointerDown);

    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Focus moves into the menu when it opens, so the next arrow key lands somewhere meaningful.
  useEffect(() => {
    if (open) {
      pressingTrigger.current = false;
      menuRef.current?.querySelector('button')?.focus();
    }
  }, [open]);

  /*
   * The menu's focus model: its items are reached with the arrow keys and are not in the Tab sequence
   * (`tabIndex={-1}`), so Tab and Shift+Tab leave the menu for the next or previous control on the page,
   * exactly as they would from the trigger. When focus leaves the menu by any route, the menu closes and
   * focus stays where the person sent it — returning it to the trigger would undo their Tab.
   */
  const onMenuBlur = (event: React.FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget;

    if (next instanceof Node && (menuRef.current?.contains(next) ?? false)) {
      return;
    }

    if (pressingTrigger.current) {
      pressingTrigger.current = false;
      return;
    }

    setOpen(false);
  };

  /*
   * A short entrance: the popover mounts transparent and slightly small, then settles on the next frame.
   * `motion-reduce:transition-none` on the element removes the movement for anyone who asked for that —
   * the popover still appears, it just appears at once.
   */
  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }

    const frame = requestAnimationFrame(() => setEntered(true));

    return () => cancelAnimationFrame(frame);
  }, [open]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }

    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const backward = event.key === 'ArrowUp' || event.key === 'ArrowLeft';

    if (!forward && !backward) {
      return;
    }

    event.preventDefault();

    const items = Array.from(menuRef.current?.querySelectorAll('button') ?? []);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = forward
      ? (current + 1) % items.length
      : (current - 1 + items.length) % items.length;

    items[next]?.focus();
  };

  return (
    <div className="relative">
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={triggerLabel}
        className={TRIGGER}
        data-testid={testId}
        onClick={() => {
          pressingTrigger.current = false;
          setOpen((current) => !current);
        }}
        onPointerDown={() => {
          pressingTrigger.current = open;
        }}
        ref={triggerRef}
        type="button"
      >
        {triggerContent}
        {chevron ? <ChevronDown aria-hidden="true" className="ms-1" size={14} /> : null}
      </button>

      {open ? (
        <div
          aria-label={label}
          aria-orientation={orientation}
          /*
           * Anchored to the trigger's trailing edge and taken out of flow, so it opens into the space
           * beside it without moving the language button or the brand. Never wider than the screen.
           */
          className={`absolute end-0 z-30 mt-1 rounded-ar-md border border-ar-border bg-ar-surface p-1 shadow-ar-md transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none ${
            orientation === 'horizontal'
              ? 'flex w-max max-w-[calc(100vw-2rem)] items-center'
              : 'flex min-w-44 max-w-[calc(100vw-2rem)] flex-col'
          } ${entered ? 'scale-100 opacity-100' : 'scale-95 opacity-0'}`}
          id={menuId}
          onBlur={onMenuBlur}
          onKeyDown={onMenuKeyDown}
          ref={menuRef}
          role="menu"
        >
          {options.map((option) => {
            const current = option.value === value;
            const Icon = option.icon;

            if (Icon !== undefined) {
              return (
                /*
                 * Icon options are named, not labelled: the accessible name carries the wording, and the
                 * current one is marked by an outline and brand-coloured icon rather than a filled
                 * background, which is what the collapsed trigger deliberately no longer has.
                 *
                 * The button *is* the 44 × 44 px target and the visible 36 px circle is drawn inside it.
                 * Every circle carries a border — transparent unless current — so the selected option's
                 * outline can no longer shrink a pseudo-element target to 42 px, and adjacent options
                 * abut without overlapping.
                 */
                <button
                  aria-checked={current}
                  aria-label={option.label}
                  className="group flex h-11 w-11 items-center justify-center rounded-full"
                  key={option.value}
                  onClick={() => {
                    onSelect(option.value);
                    close(true);
                  }}
                  role="menuitemradio"
                  tabIndex={-1}
                  title={option.label}
                  type="button"
                >
                  <span
                    className={`flex h-9 w-9 items-center justify-center rounded-full border transition-colors motion-reduce:transition-none ${
                      current
                        ? 'border-ar-brand text-ar-brand'
                        : 'border-transparent text-ar-text-muted group-hover:bg-ar-surface-muted group-hover:text-ar-text'
                    }`}
                  >
                    <Icon aria-hidden="true" size={17} />
                  </span>
                </button>
              );
            }

            return (
              <button
                aria-checked={current}
                className="flex min-h-11 items-center justify-between gap-3 rounded-ar-sm px-3 text-start text-sm text-ar-text transition-colors hover:bg-ar-surface-muted motion-reduce:transition-none"
                key={option.value}
                onClick={() => {
                  onSelect(option.value);
                  close(true);
                }}
                role="menuitemradio"
                tabIndex={-1}
                type="button"
              >
                <span>{option.label}</span>
                {current ? (
                  <Check aria-hidden="true" className="shrink-0 text-ar-brand" size={16} />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};

/**
 * The appearance control, collapsed.
 *
 * Closed, it shows only the current preference's icon on the same neutral surface as the language
 * control beside it — no filled brand background, so the header reads as two quiet controls rather than
 * one highlighted switch. Open, it is the familiar row of three icons, anchored to the trigger.
 */
const ThemePopover = () => {
  const { messages } = useLocale();
  const { preference, setPreference } = useTheme();
  const Icon = THEME_ICONS[preference];

  return (
    <RadioMenu
      chevron={false}
      label={messages.appearance.label}
      onSelect={setPreference}
      options={THEME_PREFERENCES.map((option) => ({
        value: option,
        label: messages.appearance[option],
        icon: THEME_ICONS[option],
      }))}
      orientation="horizontal"
      testId="theme-control"
      triggerContent={<Icon aria-hidden="true" size={17} />}
      // The current preference is named as well as drawn, because an icon alone is not a state.
      triggerLabel={`${messages.appearance.label}: ${messages.appearance[preference]}`}
      value={preference}
    />
  );
};

/** The same three choices as a compact list of names, for the narrow header. */
const ThemeMenu = () => {
  const { messages } = useLocale();
  const { preference, setPreference } = useTheme();
  const Icon = THEME_ICONS[preference];

  return (
    <RadioMenu
      chevron={false}
      label={messages.appearance.label}
      onSelect={setPreference}
      options={THEME_PREFERENCES.map((option) => ({
        value: option,
        label: messages.appearance[option],
      }))}
      testId="theme-menu"
      triggerContent={<Icon aria-hidden="true" size={17} />}
      // The current preference is named as well as drawn, because an icon alone is not a state.
      triggerLabel={`${messages.appearance.label}: ${messages.appearance[preference]}`}
      value={preference}
    />
  );
};

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
      {wide ? <ThemePopover /> : <ThemeMenu />}
    </div>
  );
};

export const LanguageControl = () => {
  const { locale, messages, setLocale } = useLocale();

  return (
    <RadioMenu
      chevron={false}
      label={messages.language.label}
      onSelect={setLocale}
      options={SUPPORTED_LOCALES.map((supported) => ({
        value: supported,
        // Each language is named in itself, which is what someone looking for their own reads.
        label: MESSAGES[supported].languageName,
      }))}
      testId="language-control"
      triggerContent={
        <span className="text-xs font-semibold uppercase tracking-wide tabular-nums">{locale}</span>
      }
      triggerLabel={`${messages.language.label}: ${MESSAGES[locale].languageName}`}
      value={locale}
    />
  );
};
