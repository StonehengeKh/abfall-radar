import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DashboardView } from '@/src/features/dashboard/dashboard-view';
import { NeedsSelectionView } from '@/src/features/onboarding/needs-selection-view';
import { SettingsView } from '@/src/features/settings/settings-view';
import { useCatalogue, verifyProvider } from '@/src/hooks/use-catalogue';
import { useWithdrawal } from '@/src/hooks/use-withdrawal';
import { useSchedule } from '@/src/hooks/use-schedule';
import { useSettings } from '@/src/hooks/use-settings';
import type { ServiceAreaSummary } from '@/src/messaging/contract';

/**
 * Popup composition.
 *
 * It reads no provider and constructs no request: every piece of data arrives through the worker gateway,
 * and an import-graph test proves `@abfall-radar/api-client` is unreachable from this entry.
 *
 * One rule governs every provider-specific request on every surface here: **nothing is asked about a provider
 * until a successful catalogue has confirmed it exists and is not demo data.** A stored selection is
 * schema-valid but its provider is only an identifier, so hydrating it, opening settings, or refreshing the
 * schedule must all wait for that confirmation. The local cache restore is the one thing that does not wait,
 * because it touches no network and the offline case is what it exists for.
 */
function App() {
  const [screen, setScreen] = useState<'dashboard' | 'settings'>('dashboard');
  const { clearSelectionIfUnchanged, saveSelection, saveSettings, settings, status } =
    useSettings();
  const { areaState, catalogue, providers, requestAreas, retryProviders, retryAreas, forgetAreas } =
    useCatalogue();

  /**
   * Discarding everything held for an area a successful response has withdrawn.
   *
   * The whole ordered sequence lives in the hook: the cache is invalidated and *acknowledged* before the persisted
   * selection is compare-and-cleared, because a selection cleared while the entry was still on disk left a stored
   * schedule with nothing left to re-validate it against. Its two steps fail differently and retry differently,
   * which is why they are one state machine there rather than a boolean here.
   */
  const withdrawal = useWithdrawal({
    /**
     * So a withdrawal can tell when it has been superseded.
     *
     * Its screen takes precedence over every selection-based one, so a failed withdrawal of area A used to hold the
     * popup on an error about A after another window selected area B — indefinitely, with no way out but retrying
     * an operation for an area nobody was looking at.
     */
    selection: settings.selection,
    clearSelectionIfUnchanged,
    /**
     * Onboarding replaces whatever was on screen, including the retry control a person may have just pressed, so
     * focus is placed rather than left on `<body>`.
     *
     * Only once the selection really was cleared. A `superseded` answer means somebody chose a different area, and
     * that choice is re-evaluated on its own merits — no transition of this person's happened.
     */
    onCleared: () => {
      setPendingFocus('onboarding');
    },
  });

  const dashboardMainRef = useRef<HTMLElement>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsHeadingRef = useRef<HTMLHeadingElement>(null);
  const onboardingHeadingRef = useRef<HTMLHeadingElement>(null);

  /**
   * Where focus belongs after a view transition, or `none` when no transition happened.
   *
   * Every screen change here replaces the whole surface, so whatever a person was focused on is removed from
   * the document and focus falls back to `<body>`: the next Tab restarts from the top and nothing announces
   * that the screen changed. Each member below names the one meaningful place to continue from.
   *
   * Set by the **act**, never derived from state. Deriving "we are on Settings now, so focus it" would also
   * fire on every ordinary rerender of Settings, on a catalogue answer, and on every schedule or cache update —
   * taking focus away from whatever the person had moved to in the meantime. That is the failure this whole
   * mechanism must not become, so a transition is recorded when it is caused and consumed exactly once.
   */
  const [pendingFocus, setPendingFocus] = useState<
    'none' | 'settings' | 'settings_trigger' | 'dashboard_main' | 'onboarding'
  >('none');

  useEffect(() => {
    if (pendingFocus === 'none') {
      return;
    }

    // Consumed unconditionally and before the focus call, so a transition cannot survive the render it belongs
    // to and fire again later.
    setPendingFocus('none');

    if (pendingFocus === 'settings') {
      settingsHeadingRef.current?.focus();

      return;
    }

    if (pendingFocus === 'onboarding') {
      onboardingHeadingRef.current?.focus();

      return;
    }

    if (pendingFocus === 'settings_trigger') {
      /**
       * Back to the control that opened Settings, which is where the person was.
       *
       * It can legitimately be absent: leaving Settings after the stored area was withdrawn lands on onboarding,
       * which has no such button. The main region is the fallback rather than nothing, because falling through to
       * `<body>` is the outcome being prevented.
       */
      const trigger = settingsTriggerRef.current;

      if (trigger !== null) {
        trigger.focus();

        return;
      }

      dashboardMainRef.current?.focus();

      return;
    }

    dashboardMainRef.current?.focus();
  }, [pendingFocus]);

  /**
   * Settles the local screen state after the selection is cleared from underneath Settings.
   *
   * The branch order above already stops `SettingsView` rendering, so this is not what removes it — it is what
   * stops `screen` sitting on a value that no longer describes anything. Left alone, choosing an area on onboarding
   * would land straight back in Settings, because the popup still believed that was where it was.
   *
   * Focus moves with it. This is the one focus transition not caused by something the person did, and it has to be
   * announced for the same reason the others are: the surface they were interacting with has been replaced, and
   * without this focus falls back to `<body>` with nothing saying why. It fires exactly once, because the condition
   * stops holding as soon as `screen` is normalized — and by the time the focus effect runs, the onboarding heading
   * is mounted, so nothing tries to focus an element that is not there.
   */
  useEffect(() => {
    if (status !== 'ready' || settings.selection !== null || screen !== 'settings') {
      return;
    }

    setScreen('dashboard');
    setPendingFocus('onboarding');
  }, [screen, settings.selection, status]);

  const storedProviderId = settings.selection?.providerId ?? null;
  /**
   * Memoized on the two things it is actually derived from.
   *
   * Both are state rather than derived values, so the verdict keeps its identity across every render caused
   * by something else — a schedule arriving, a cache being restored, a screen change. Deriving it inline
   * produced an equal-but-new object each time, and the two effects below it treated that as the catalogue
   * having spoken again: the area request fired repeatedly and the schedule attempt superseded itself.
   */
  const verification = useMemo(
    () => verifyProvider(catalogue, storedProviderId),
    [catalogue, storedProviderId],
  );

  const { view, refresh } = useSchedule({
    selection: settings.selection,
    providerVerification: verification,
    onAreaUnavailable: withdrawal.begin,
  });

  /**
   * Retries whichever read actually failed.
   *
   * The dashboard shows one retry control for every error it can render, but "the schedule failed" is three
   * different situations underneath: the catalogue could not be read, this provider's areas could not be read,
   * or the collection-events request itself failed. Only the last is something `refresh` can fix — it re-runs
   * the schedule attempt, and with an unchanged failed verification that attempt lands on exactly the same
   * failure without asking the catalogue anything. The control looked like it worked and changed nothing.
   *
   * So the failed resource decides. The catalogue is checked first because everything else is gated behind it:
   * while it is unread, there is no confirmed provider to request areas for.
   */
  const retryFailedRead = useCallback(() => {
    if (catalogue.kind === 'failed') {
      retryProviders();

      return;
    }

    const failedAreaProvider =
      areaState.kind === 'failed' && areaState.providerId === storedProviderId
        ? areaState.providerId
        : null;

    if (failedAreaProvider !== null) {
      /**
       * Both readers of the service areas, because there are two and each issued its own request.
       *
       * The catalogue hook reads the list the selection surfaces offer; the schedule reads the selected area's
       * authoritative capability. The dashboard error came from the schedule's read, so retrying only the
       * catalogue's would leave the surface reporting the same failure — and retrying only the schedule's would
       * leave Settings offering an area list that is still missing.
       */
      retryAreas(failedAreaProvider);
      refresh();

      return;
    }

    // Nothing upstream is broken, so the events request is what failed and the schedule owns that retry.
    refresh();
  }, [areaState, catalogue.kind, refresh, retryAreas, retryProviders, storedProviderId]);

  /**
   * Brings the area list in step with the stored selection, but only once the provider is confirmed.
   *
   * Keyed on the verification rather than on the selection, so this cannot fire before the catalogue has
   * answered — and so it fires exactly once when it does. `requestAreas` refuses a second request for the same
   * provider itself, so a rerender cannot start another.
   */
  useEffect(() => {
    if (verification.kind === 'offered') {
      requestAreas(verification.provider.id);

      return;
    }

    if (verification.kind === 'rejected') {
      // Stale catalogue state for a provider that may not be used is dropped immediately, so no surface can
      // offer its areas while the invalidation is still settling.
      forgetAreas();
    }
  }, [verification, requestAreas, forgetAreas]);

  if (status === 'preparing') {
    return (
      <div className="grid min-h-[520px] place-items-center px-6 text-center text-sm text-ar-text-muted">
        <div>
          <div className="mx-auto size-9 animate-pulse rounded-2xl bg-ar-brand motion-reduce:animate-none" />
          <p className="mt-3">AbfallRadar wird vorbereitet…</p>
        </div>
      </div>
    );
  }

  if (status === 'unsupported_version') {
    /**
     * The stored settings were written by a newer build of this extension.
     *
     * Its own state, and deliberately not the ordinary application: the settings are intact on disk, this build
     * cannot represent them, and every edit it offered would be refused. Presenting defaults instead would show a
     * fresh installation to someone whose real settings are right there.
     *
     * The recovery offered is to run the newer version again — reloading the extension picks up the build that
     * wrote the value. There is deliberately no button that resets or downgrades the stored settings: that would
     * destroy data this build cannot even read, which is exactly what preserving it is for.
     */
    return (
      <main className="grid min-h-[520px] place-items-center px-6 text-center text-ar-text">
        <div>
          <AlertTriangle className="mx-auto text-ar-danger" size={22} aria-hidden="true" />
          <p className="mt-3 font-semibold">Neuere Einstellungen gefunden</p>
          <p className="mt-1 text-sm text-ar-text-muted" role="alert">
            Die gespeicherten Einstellungen wurden von einer neueren Version von AbfallRadar
            erstellt. Sie bleiben unverändert erhalten. Bitte aktualisiere die Erweiterung oder lade
            sie neu, um sie wieder zu verwenden.
          </p>
        </div>
      </main>
    );
  }

  if (status === 'unreadable') {
    /**
     * The stored settings could not be read.
     *
     * Its own state rather than the preparation screen, which is what this used to show: a read that will
     * never answer looked exactly like one still in flight, so a person waited on a spinner indefinitely.
     * And deliberately not the ordinary application with defaults either — that would present a fresh
     * installation to someone whose chosen area is merely unreadable right now, and silently forget it.
     */
    return (
      <main className="grid min-h-[520px] place-items-center px-6 text-center text-ar-text">
        <div>
          <AlertTriangle className="mx-auto text-ar-danger" size={22} aria-hidden="true" />
          <p className="mt-3 font-semibold">Einstellungen nicht lesbar</p>
          <p className="mt-1 text-sm text-ar-text-muted" role="alert">
            Die gespeicherten Einstellungen konnten nicht gelesen werden. Bitte öffne AbfallRadar
            erneut.
          </p>
        </div>
      </main>
    );
  }

  if (withdrawal.state.kind === 'cache_failed' || withdrawal.state.kind === 'clear_failed') {
    /**
     * The withdrawal could not be completed.
     *
     * Its own screen, ahead of every other one, because both alternatives are wrong: continuing to present the
     * schedule would show a calendar the provider has withdrawn as current official data, and showing onboarding
     * would imply the stored choice was already gone when it is still on disk.
     *
     * Which **step** failed is stated, because the two leave the extension in different places and the retry does
     * different work. The heading is shared — the area really is gone either way, and that is the part a person
     * needs first.
     *
     * The first message says the discard could not be *confirmed* rather than that it failed, because that is what
     * is known: the worker did not acknowledge the invalidation, and without that acknowledgement there is no
     * evidence either way. A refused removal is not this case at all — that is best-effort and acknowledged.
     */
    const stalledAtCache = withdrawal.state.kind === 'cache_failed';

    return (
      <main className="grid min-h-[520px] place-items-center px-6 text-center text-ar-text">
        <div>
          <AlertTriangle className="mx-auto text-ar-danger" size={22} aria-hidden="true" />
          <p className="mt-3 font-semibold">Sammelgebiet nicht mehr verfügbar</p>
          <p className="mt-1 text-sm text-ar-text-muted" role="alert">
            Für dieses Sammelgebiet veröffentlicht der Entsorgungsbetrieb keinen offiziellen
            Kalender mehr.{' '}
            {stalledAtCache
              ? 'Das Verwerfen des gespeicherten Kalenders konnte nicht bestätigt werden, deshalb bleibt die Auswahl vorläufig erhalten.'
              : 'Der gespeicherte Kalender wurde verworfen, die Auswahl konnte aber nicht zurückgesetzt werden.'}
          </p>
          <button
            type="button"
            className="mt-4 inline-flex min-h-11 items-center gap-1.5 rounded-2xl border border-ar-border bg-ar-surface px-3.5 py-2 text-sm font-semibold transition hover:border-ar-text-muted focus-visible:outline-ar-focus"
            onClick={withdrawal.retry}
          >
            <RotateCcw size={15} aria-hidden="true" />
            {stalledAtCache ? 'Erneut versuchen' : 'Auswahl zurücksetzen'}
          </button>
        </div>
      </main>
    );
  }

  if (withdrawal.state.kind === 'invalidating' || withdrawal.state.kind === 'clearing') {
    /**
     * The schedule has already stopped being presented, and the write is still in flight.
     *
     * Deliberately not the ordinary loading state, which says the schedule is being fetched — nothing is being
     * fetched here, and the previous schedule may never come back. It is a brief state with a definite end:
     * whichever way the write resolves, the next render is onboarding or the error above.
     */
    return (
      <main className="grid min-h-[520px] place-items-center px-6 text-center text-ar-text">
        <div>
          <Loader2
            className="mx-auto animate-spin text-ar-text-muted motion-reduce:animate-none"
            size={22}
            aria-hidden="true"
          />
          <p className="mt-3 text-sm text-ar-text-muted" role="status" aria-live="polite">
            Das gespeicherte Sammelgebiet wird zurückgesetzt…
          </p>
        </div>
      </main>
    );
  }

  /**
   * No selection means onboarding, **whatever screen the popup thinks it is on**.
   *
   * Checked before the Settings branch on purpose. The worker owns the selection and can clear it with nobody
   * watching — a reminder discovering the area was withdrawn, an unavailable capability, a provider or area removed
   * from a successful catalogue — and Settings winning that race left it editing an area that no longer existed,
   * with a provider list it could not resolve, until the person pressed Back. Ordering the branches this way makes
   * "there is nothing selected" the stronger fact, which it is.
   *
   * The hydration and error branches stay above both: whether the settings are readable at all is a stronger fact
   * still.
   */
  if (settings.selection === null) {
    return (
      <NeedsSelectionView
        providers={providers}
        areaState={areaState}
        isCatalogueLoading={catalogue.kind === 'loading'}
        errorMessage={
          catalogue.kind === 'failed'
            ? 'Die Liste der Entsorgungsbetriebe konnte nicht geladen werden.'
            : undefined
        }
        headingRef={onboardingHeadingRef}
        onRetryCatalogue={retryProviders}
        onRequestAreas={requestAreas}
        onRetryAreas={retryAreas}
        /**
         * Awaited, so confirmation is never fire-and-forget.
         *
         * A rejected storage write used to disappear as an unhandled rejection while the surface acted as
         * though the choice had been made — leaving a person on a screen that had accepted their input and
         * stored nothing. The outcome comes back so the surface can stay put and say so.
         */
        onConfirm={async (area: ServiceAreaSummary) => {
          const result = await saveSelection({
            selection: { providerId: area.providerId, serviceAreaId: area.id },
            /**
             * Both halves read off the **same** area object, so the evidence names the area it was read for by
             * construction. The worker compares the two identities anyway — this surface is not the only sender,
             * and the check belongs to whoever owns the write.
             */
            evidence: {
              providerId: area.providerId,
              serviceAreaId: area.id,
              collectionEvents: area.collectionEvents,
            },
          });

          if (result.outcome === 'persisted') {
            // Only a persisted confirmation moves focus. A refusal keeps the surface — and the button that was
            // pressed — exactly where they are, so taking focus away would strand the person away from the
            // error explaining what happened.
            setPendingFocus('dashboard_main');
          }

          return result.outcome;
        }}
      />
    );
  }

  if (screen === 'settings') {
    return (
      <SettingsView
        providers={providers}
        areaState={areaState}
        initialSettings={settings}
        onCancel={() => {
          // Back discards the draft and returns focus to the control that opened Settings.
          setScreen('dashboard');
          setPendingFocus('settings_trigger');
        }}
        onSave={async (input) => {
          /**
           * One repository operation. The view stays open on a refusal and keeps its own error, so the previously
           * stored value is never half-replaced.
           *
           * `saveSettings` returns whatever is stored *now* for every outcome, and the hook has already adopted it
           * — so a `conflict` leaves this popup showing the newer authoritative selection rather than the stale
           * one the draft was built from. The schedule is derived from that adopted value, so no request is issued
           * for the selection the worker just refused.
           */
          const result = await saveSettings(input);

          if (result.outcome === 'persisted') {
            setScreen('dashboard');
            setPendingFocus('settings_trigger');
          }

          // A refusal leaves the screen — and the focus — exactly where they are, beside the error explaining it.
          return result.outcome;
        }}
        onRequestAreas={requestAreas}
        onRetryAreas={retryAreas}
        headingRef={settingsHeadingRef}
      />
    );
  }

  return (
    <DashboardView
      view={view}
      visibleWasteTypes={settings.visibleWasteTypes}
      onOpenSettings={() => {
        setScreen('settings');
        setPendingFocus('settings');
      }}
      onRetry={retryFailedRead}
      mainRef={dashboardMainRef}
      settingsButtonRef={settingsTriggerRef}
    />
  );
}

export default App;
