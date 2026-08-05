import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Replaces global fetch with a loud failure; see tests/setup.ts.
    setupFiles: ['tests/setup.ts'],
    // This lives on an exFAT volume, where macOS writes AppleDouble sidecars
    // (`._foo.test.ts`). They are binary and blow up the transform.
    exclude: ['**/node_modules/**', '**/dist/**', '**/._*'],
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/ui/**'],
    },
  },
});
