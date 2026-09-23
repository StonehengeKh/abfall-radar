import { AppearanceMenu, BrandMark, BrandName, LanguageMenu } from '@abfall-radar/ui';
import type { ReactNode } from 'react';
import { usePresentation } from '@/src/i18n/copy';

/**
 * The popup's header: the mark and the name, where the person is, and the language and appearance controls.
 *
 * The same brand, the same two menus and the same wording as the website's header, laid out for a fixed
 * 392 px popup: one row that wraps, with the controls dropping below the brand before anything is squeezed
 * or truncated. `leading` and `trailing` are the screen's own controls — Back on Settings, the Settings
 * button on the schedule — kept outside so this component knows nothing about navigation.
 *
 * The place is shown as text, whole and wrapping. A district's name is often told apart from another only at
 * its end, so an ellipsis would hide exactly the part that identifies it.
 */
export const PopupHeader = ({
  place = null,
  leading = null,
  trailing = null,
}: {
  readonly place?: string | null;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
}) => {
  const { messages, locale, appearance, chooseLocale, chooseAppearance } = usePresentation();

  return (
    <header className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
      {leading}
      <div className="flex min-w-0 flex-[1_1_9rem] items-center gap-2">
        <BrandMark />
        <div className="flex min-w-0 flex-col">
          <p className="py-0.5 text-[0.95rem] font-semibold leading-snug tracking-tight text-ar-text">
            <BrandName />
          </p>
          {place === null ? null : (
            <p className="break-words text-xs text-ar-text-muted" data-testid="header-place">
              {place}
            </p>
          )}
        </div>
      </div>
      <div className="ms-auto flex shrink-0 items-center gap-2">
        <LanguageMenu label={messages.language.label} onSelect={chooseLocale} value={locale} />
        <AppearanceMenu
          labels={messages.appearance}
          onSelect={chooseAppearance}
          value={appearance}
        />
        {trailing}
      </div>
    </header>
  );
};
