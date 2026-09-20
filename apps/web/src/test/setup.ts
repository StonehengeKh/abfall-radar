import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { installMatchMedia, resetViewport } from '@/src/test/viewport';

// jsdom implements no `matchMedia`, and the header asks it which appearance control fits.
installMatchMedia();

beforeEach(() => {
  installMatchMedia();
});

afterEach(() => {
  cleanup();
  resetViewport();
});
