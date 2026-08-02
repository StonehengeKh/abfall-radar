import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing';

// Every test starts from an empty in-memory extension: no stored settings, no cache entry, no alarm.
// Without this, a migration or cache test would inherit whatever the previous one wrote.
beforeEach(() => {
  fakeBrowser.reset();
});

// Registered explicitly because vitest globals are off, so Testing Library cannot install its own
// automatic cleanup. Without it, rendered trees accumulate and a query that should find one control finds
// one per preceding test.
afterEach(() => {
  cleanup();
});
