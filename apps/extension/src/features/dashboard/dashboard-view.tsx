import { Bell, ChevronRight, MapPin, Settings2, Sparkles } from 'lucide-react';
import {
  type CollectionEvent,
  type District,
  getRelativeDateLabel,
  wasteDescriptions,
  wasteLabels,
} from '@abfall-radar/domain';
import { BrandMark, WasteIcon } from '@abfall-radar/ui';

interface DashboardViewProps {
  district: District;
  events: CollectionEvent[];
  onOpenSettings: () => void;
  referenceDate?: Date;
}

export const DashboardView = ({
  district,
  events,
  onOpenSettings,
  referenceDate = new Date(),
}: DashboardViewProps) => {
  const [nextEvent, ...laterEvents] = events;

  return (
    <main className="min-h-full px-4 pb-4 pt-5 text-ar-text">
      <header className="flex items-center gap-3">
        <BrandMark />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-ar-brand">
            AbfallRadar
          </p>
          <h1 className="truncate text-lg font-semibold tracking-tight">Alles im Blick</h1>
        </div>
        <button
          type="button"
          className="grid size-11 place-items-center rounded-2xl border border-ar-border bg-ar-surface text-ar-text-muted shadow-ar-sm transition hover:border-ar-text-muted hover:text-ar-text focus-visible:outline-ar-focus"
          aria-label="Einstellungen öffnen"
          onClick={onOpenSettings}
        >
          <Settings2 size={19} />
        </button>
      </header>

      <div className="mt-5 inline-flex max-w-full items-center gap-2 rounded-full border border-ar-border bg-ar-surface px-3 py-1.5 text-xs font-medium text-ar-text-muted shadow-ar-sm">
        <MapPin size={14} className="shrink-0 text-ar-brand" />
        <span className="truncate">
          {district.city} · {district.name}
        </span>
      </div>

      {nextEvent ? (
        <section className="ar-hero relative mt-4 overflow-hidden rounded-[28px] p-5 text-ar-on-brand">
          <div className="absolute -right-10 -top-12 size-36 rounded-full border-[24px] border-ar-on-brand/[0.06]" />
          <div className="absolute -bottom-16 left-10 size-28 rounded-full bg-ar-brand-soft/10 blur-xl" />

          <div className="relative flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-1.5 text-xs font-semibold text-ar-on-brand/85">
                <Sparkles size={14} />
                Nächste Abholung
              </div>
              <p className="mt-4 text-3xl font-semibold tracking-[-0.035em]">
                {getRelativeDateLabel(nextEvent.date, referenceDate)}
              </p>
              <p className="mt-1 text-sm text-ar-on-brand/80">{nextEvent.date}</p>
            </div>
            <WasteIcon type={nextEvent.type} inverted />
          </div>

          <div className="relative mt-7 flex items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{wasteLabels[nextEvent.type]}</h2>
              <p className="mt-0.5 text-sm text-ar-on-brand/75">
                {wasteDescriptions[nextEvent.type]}
              </p>
            </div>
            <div className="flex items-center gap-1 rounded-full bg-ar-on-brand/12 px-2.5 py-1 text-[11px] font-semibold text-ar-on-brand backdrop-blur">
              <Bell size={12} />
              18:00
            </div>
          </div>
        </section>
      ) : (
        <section className="mt-4 rounded-[28px] border border-dashed border-ar-border bg-ar-surface p-6 text-center">
          <p className="font-semibold">Keine Termine gefunden</p>
          <p className="mt-1 text-sm text-ar-text-muted">Prüfe den ausgewählten Bezirk.</p>
        </section>
      )}

      <section className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ar-text">Danach</h2>
          <span className="rounded-full bg-ar-demo-surface px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-ar-demo-text">
            Demo-Daten
          </span>
        </div>

        <div className="mt-2 overflow-hidden rounded-3xl border border-ar-border bg-ar-surface shadow-ar-sm">
          {laterEvents.slice(0, 4).map((event, index) => (
            <div
              key={event.id}
              className={[
                'flex items-center gap-3 px-3.5 py-3',
                index > 0 ? 'border-t border-ar-border' : '',
              ].join(' ')}
            >
              <WasteIcon type={event.type} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ar-text">
                  {wasteLabels[event.type]}
                </p>
                <p className="mt-0.5 text-xs text-ar-text-muted">
                  {getRelativeDateLabel(event.date, referenceDate)}
                </p>
              </div>
              <ChevronRight size={17} className="text-ar-text-muted/50" aria-hidden="true" />
            </div>
          ))}
        </div>
      </section>

      <footer className="mt-4 text-center text-[11px] leading-4 text-ar-text-muted">
        Lokale Demo · Offizielle Datenquelle folgt im nächsten Schritt
      </footer>
    </main>
  );
};
