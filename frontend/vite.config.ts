/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    outDir: 'build',
  },
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
  test: {
    // Lit components need real custom-element/shadow-DOM support to mount;
    // happy-dom provides that at a fraction of jsdom's weight. Pure lib/
    // tests don't need a DOM at all but are unaffected by having one.
    environment: 'happy-dom',
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Thresholds sit a few points under the measured baseline (~93%
      // statements / 80% branches / 95% functions / 95% lines as of this
      // writing) — enough slack that routine changes don't flake the gate,
      // tight enough that a real drop (e.g. a deleted test file, a new
      // untested component) still fails CI. Raise these as coverage grows;
      // don't lower them to make a failing PR pass.
      thresholds: {
        statements: 91,
        branches: 77,
        functions: 93,
        lines: 93,
      },
    },
  },
});
