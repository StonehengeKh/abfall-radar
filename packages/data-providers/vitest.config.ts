import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Forked, isolated workers give each test file its own process, so a file that pins
    // `process.env.TZ` before importing the module under test cannot leak that zone into another
    // file. Time-zone behavior is load-bearing here: an all-day calendar date must survive any
    // process zone unchanged.
    pool: 'forks',
    isolate: true,
  },
});
