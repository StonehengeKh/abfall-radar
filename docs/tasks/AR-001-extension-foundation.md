# AR-001: Browser extension foundation

- Status: Done
- Owner: Initial repository setup

## Goal

Create the first runnable AbfallRadar Chrome extension with a polished popup, local preferences,
typed scheduling boundaries, and a safe two-agent workflow.

## Scope

- WXT Manifest V3 extension.
- Monorepo package boundaries for domain, providers, and shared UI.
- React and TypeScript popup.
- Responsive 320–392 px popup layout.
- Demo schedule provider.
- District selection.
- Waste-type filtering.
- Reminder enable/disable and time selection.
- Local storage.
- Background alarm and browser notification.
- Unit and component tests.

## Non-goals

- Official municipal data ingestion.
- Map.
- Web application.
- Backend.
- Mobile application.
- Chrome Web Store publication.

## Acceptance criteria

- The extension production build succeeds.
- The popup clearly uses the name AbfallRadar without a city in the product name.
- Demo data is visibly labelled as demo data.
- The next collection and at least three later collections are displayed.
- Settings survive popup close and reopen.
- At least one waste type must remain selected.
- Background reminders use Manifest V3 alarms and notifications.
- Browser permissions are limited to storage, alarms, and notifications.
- Domain scheduling logic has unit coverage.
- The main dashboard interaction has component coverage.
- Public workspace exports are used instead of cross-workspace relative imports.

## Verification

```bash
pnpm check
```

Manual verification:

- Load `apps/extension/.output/chrome-mv3` in Chrome.
- Verify the dashboard and settings at the popup width.
- Change settings, close the popup, and verify that the settings remain.
