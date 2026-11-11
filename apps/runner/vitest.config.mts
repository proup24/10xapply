import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/runner',
  test: {
    name: '@xapply/runner',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}'],
    passWithNoTests: true,
    // The first ESLint run loads the whole flat config and is slow.
    testTimeout: 30_000,
    reporters: ['default'],
  },
}));
